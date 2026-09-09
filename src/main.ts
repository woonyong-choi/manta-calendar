import {
  MarkdownRenderChild,
  Notice,
  Plugin,
  TFile,
  TFolder,
  normalizePath,
  parseYaml,
  requestUrl,
  stringifyYaml,
} from "obsidian";

import {
  CalendarIndex,
  type SourceDetection,
  type SourceHealth,
  detectSourceFolder,
  selectProfileFromFrontmatter,
} from "./index";
import { formatMessage, translate } from "./i18n";
import { GoogleAuthManager, parseGoogleReturnLink, type OAuthProtocolData } from "./google-auth";
import {
  GoogleCalendarClient,
  type GoogleHttpRequest,
  syncGoogleCalendar as runGoogleSync,
} from "./google-calendar";
import { GOOGLE_OAUTH_RELAY_URL } from "./google-config";
import {
  type CalendarEvent,
  type CalendarSettings,
  type SourceProfile,
  DEFAULT_SETTINGS,
  dateKey,
  isRecord,
  normalizeSettings,
  serializeSettings,
} from "./model";
import { createPresetProfile } from "./onboarding";
import { EventModal, FolderSuggestModal, SourcePreviewModal } from "./modals";
import {
  canCreateWithProfile,
  embedSource,
  eventFrontmatter,
  frontmatterMatchesChanges,
  frontmatterMatchesEventDates,
  planMoveFrontmatter,
  resolveEventPath,
  writableProfiles,
} from "./policy";
import { LinkCalendarSettingTab, type SettingsHost } from "./settings";
import { LinkCalendarView, VIEW_TYPE, type CalendarActions } from "./view";

const CODE_BLOCK = "link-calendar";

interface MoveUndoReceipt {
  expected: Record<string, unknown>;
  filePath: string;
  profileId: string;
  restore: Record<string, unknown>;
}

export default class LinkCalendarPlugin extends Plugin implements SettingsHost {
  override settings: CalendarSettings = structuredClone(DEFAULT_SETTINGS);
  private index!: CalendarIndex;
  private readonly listeners = new Set<() => void>();
  private refreshQueued = false;
  private refreshTimer: number | null = null;
  private lastMove: MoveUndoReceipt | null = null;
  private settingsTab!: LinkCalendarSettingTab;
  private googleAuth!: GoogleAuthManager;

  override async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.googleAuth = new GoogleAuthManager(
      GOOGLE_OAUTH_RELAY_URL,
      (request) => this.googleRequest(request),
      this.app.secretStorage,
    );
    this.index = new CalendarIndex(
      this.app.vault,
      this.app.metadataCache,
      this.settings.profiles,
      this.settings.autoIndexDates,
    );
    this.registerView(VIEW_TYPE, (leaf) =>
      new LinkCalendarView(
        leaf,
        () => this.settings,
        () => this.index.snapshot(),
        this.actions(),
      ));
    this.addRibbonIcon(
      "calendar-days",
      translate(this.settings.locale, "openCalendar"),
      () => void this.openCalendar(),
    );
    this.addCommand({
      id: "open-month",
      name: translate(this.settings.locale, "openCalendar"),
      callback: () => void this.openCalendar(),
    });
    this.addCommand({
      id: "show-today",
      name: translate(this.settings.locale, "showToday"),
      callback: () => void this.openCalendar("", true),
    });
    this.addCommand({
      id: "create-event-note",
      name: translate(this.settings.locale, "createEvent"),
      callback: () => void this.createEvent(dateKey(new Date()) ?? ""),
    });
    this.addCommand({
      id: "add-source-folder",
      name: translate(this.settings.locale, "chooseFolder"),
      callback: () => this.chooseSourceFolder(),
    });
    this.addCommand({
      id: "reveal-active-note",
      name: translate(this.settings.locale, "revealActiveNote"),
      checkCallback: (checking) => {
        const path = this.app.workspace.getActiveFile()?.path;
        if (!path || !resolveEventPath(this.index.snapshot().events, path)) return false;
        if (!checking) void this.openCalendar(path);
        return true;
      },
    });
    this.addCommand({
      id: "undo-last-date-move",
      name: translate(this.settings.locale, "undoLastMove"),
      checkCallback: (checking) => {
        if (!this.lastMove) return false;
        if (!checking) void this.undoMove(this.lastMove);
        return true;
      },
    });
    this.addCommand({
      id: "sync-google-calendar",
      name: translate(this.settings.locale, "googleSyncNow"),
      checkCallback: (checking) => {
        const available = this.settings.googleCalendar.enabled
          && this.googleAuth.isConnected()
          && Boolean(this.settings.googleCalendar.calendar)
          && this.settings.googleCalendar.sourceProfileIds.length > 0;
        if (available && !checking) void this.syncGoogleCalendar();
        return available;
      },
    });
    this.registerObsidianProtocolHandler("link-calendar-google", (data) => {
      void this.completeGoogleConnection({
        code: data.code, error: data.error, relay_state: data.relay_state, state: data.state,
      });
    });
    this.settingsTab = new LinkCalendarSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.registerMarkdownCodeBlockProcessor(CODE_BLOCK, (source, element, context) => {
      context.addChild(new CalendarEmbedChild(element, this, source));
    });
    this.app.workspace.onLayoutReady(() => {
      this.index.rebuild();
      this.settingsTab.update();
      this.publishSnapshot();
      this.registerIndexEvents();
      void this.index.rebuildBodies().then(() => this.publishSnapshot());
      if (this.settings.googleCalendar.enabled && this.googleAuth.isConnected()) {
        void this.ensureGoogleCalendar(false);
      }
    });
  }

  override onunload(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
  }

  async saveSettings(rebuildIndex = false): Promise<void> {
    await this.saveData(serializeSettings(this.settings));
    if (rebuildIndex) {
      this.index.setConfiguration(this.settings.profiles, this.settings.autoIndexDates);
      void this.index.rebuildBodies().then(() => this.publishSnapshot());
    }
    this.publishSnapshot();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private registerIndexEvents(): void {
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.index.update(file);
        this.queuePublish();
        void this.index.updateBody(file).then(() => this.queuePublish());
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          this.index.update(file);
          this.queuePublish();
          void this.index.updateBody(file).then(() => this.queuePublish());
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.index.remove(file.path);
          this.queuePublish();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          this.migrateGoogleRecordPath(oldPath, file.path);
          this.index.remove(oldPath);
          this.index.update(file);
          this.queuePublish();
          void this.index.updateBody(file).then(() => this.queuePublish());
        }
      }),
    );
  }

  private queuePublish(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshQueued = false;
      this.refreshTimer = null;
      this.publishSnapshot();
    }, 80);
  }

  private migrateGoogleRecordPath(oldPath: string, newPath: string): void {
    const changed = this.settings.googleCalendar.records.some((record) => {
      const separator = record.localKey.indexOf("\u0000");
      return separator >= 0 && record.localKey.slice(separator + 1) === oldPath;
    });
    if (!changed) return;
    this.settings.googleCalendar.records = this.settings.googleCalendar.records.map((record) => {
      const separator = record.localKey.indexOf("\u0000");
      if (separator < 0 || record.localKey.slice(separator + 1) !== oldPath) return record;
      return { ...record, localKey: `${record.localKey.slice(0, separator)}\u0000${newPath}` };
    });
    void this.saveSettings();
  }

  private publishSnapshot(): void {
    const snapshot = this.index.snapshot();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof LinkCalendarView) view.setSnapshot(snapshot);
    }
    for (const listener of this.listeners) listener();
  }

  private actions(): CalendarActions {
    return {
      create: (date) => this.createEvent(date),
      move: (event, date) => this.moveEvent(event, date),
      open: (path) => this.openPath(path),
      openSettings: () => this.openSettings(),
      setup: () => this.chooseSourceFolder(),
    };
  }

  private openSettings(): void {
    const settings = (this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
    }).setting;
    if (!settings) {
      new Notice(translate(this.settings.locale, "openSettingsHelp"));
      return;
    }
    settings.open();
    settings.openTabById(this.manifest.id);
  }

  private async openCalendar(revealPath = "", showToday = false): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ active: true, type: VIEW_TYPE });
    }
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const view = leaf.view;
    if (view instanceof LinkCalendarView) {
      view.setSnapshot(this.index.snapshot());
      if (showToday) view.showToday(true);
      else if (revealPath) view.revealPath(revealPath);
    }
  }

  chooseFolder(onChoose?: (folder: TFolder) => void): void {
    new FolderSuggestModal(
      this.app,
      this.settings.locale,
      onChoose ?? ((folder) => this.previewSource(folder)),
    ).open();
  }

  sourceHealth(profile: SourceProfile): SourceHealth {
    return this.index.sourceHealth(profile.id);
  }

  googleAvailable(): boolean {
    return this.googleAuth.isAvailable();
  }

  googleConnected(): boolean {
    return this.googleAuth.isConnected();
  }

  googleConnectionPhase() { return this.googleAuth.connectionPhase(); }

  async connectGoogle(): Promise<void> {
    if (!this.settings.googleCalendar.enabled) return;
    try {
      const url = await this.googleAuth.beginAuthorization(this.settings.locale);
      window.open(url, "_blank", "noopener,noreferrer");
      new Notice(translate(this.settings.locale, "googleConnectionStarted"));
    } catch (error) {
      new Notice(error instanceof Error ? error.message : translate(this.settings.locale, "googleSyncFailed"));
    }
  }

  async disconnectGoogle(): Promise<void> {
    try {
      await this.googleAuth.disconnect();
      this.settings.googleCalendar.calendar = null;
      this.settings.googleCalendar.records = [];
      this.settings.googleCalendar.sourceProfileIds = [];
      await this.saveSettings();
      new Notice(translate(this.settings.locale, "googleDisconnected"));
    } catch (error) {
      new Notice(error instanceof Error ? error.message : translate(this.settings.locale, "googleSyncFailed"));
    }
  }

  async completeGoogleFromLink(link: string): Promise<void> {
    try {
      await this.completeGoogleConnection(parseGoogleReturnLink(link));
    } catch (error) {
      new Notice(error instanceof Error ? error.message : translate(this.settings.locale, "googleSyncFailed"));
    }
    this.settingsTab.update();
  }

  async ensureGoogleCalendar(showFailure = true): Promise<void> {
    if (!this.googleAuth.isConnected()) {
      if (showFailure) new Notice(translate(this.settings.locale, "googleConnectionRequired"));
      return;
    }
    try {
      this.settings.googleCalendar.calendar = await this.resolveGoogleCalendar();
      await this.saveSettings();
      this.settingsTab.update();
    } catch (error) {
      if (showFailure) {
        new Notice(error instanceof Error ? error.message : translate(this.settings.locale, "googleSyncFailed"));
      }
    }
  }

  async toggleGoogleSource(profileId: string, enabled: boolean): Promise<void> {
    const values = new Set(this.settings.googleCalendar.sourceProfileIds);
    if (enabled) values.add(profileId);
    else values.delete(profileId);
    this.settings.googleCalendar.sourceProfileIds = [...values].sort();
    await this.saveSettings();
  }

  async syncGoogleCalendar(): Promise<void> {
    const google = this.settings.googleCalendar;
    if (!google.enabled || !this.googleAuth.isConnected() || !google.calendar) {
      new Notice(translate(this.settings.locale, "googleConnectionRequired"));
      return;
    }
    if (!google.sourceProfileIds.length) {
      new Notice(translate(this.settings.locale, "googleNoSources"));
      return;
    }
    if (!google.installationId) {
      google.installationId = crypto.randomUUID();
      await this.saveSettings();
    }
    try {
      google.calendar = await this.resolveGoogleCalendar();
      const result = await runGoogleSync({
        calendar: google.calendar,
        client: this.googleClient(),
        defaultDurationMinutes: google.defaultDurationMinutes,
        events: this.index.snapshot().events,
        installationId: google.installationId,
        records: google.records,
        sourceProfileIds: google.sourceProfileIds,
      });
      google.records = result.records;
      await this.saveSettings();
      new Notice(formatMessage(this.settings.locale, "googleSyncSummary", {
        syncDenied: String(result.syncDenied),
        conflicts: String(result.conflicts.length),
        created: String(result.created),
        failed: String(result.failed.length),
        skipped: String(result.skipped),
        updated: String(result.updated),
      }));
    } catch (error) {
      new Notice(error instanceof Error ? error.message : translate(this.settings.locale, "googleSyncFailed"));
    }
  }

  private async completeGoogleConnection(data: OAuthProtocolData): Promise<void> {
    try {
      await this.googleAuth.completeAuthorization(data);
      this.settings.googleCalendar.enabled = true;
      if (!this.settings.googleCalendar.installationId) {
        this.settings.googleCalendar.installationId = crypto.randomUUID();
      }
      await this.saveSettings();
      await this.ensureGoogleCalendar();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : translate(this.settings.locale, "googleSyncFailed"));
    }
  }

  private googleClient(): GoogleCalendarClient {
    return new GoogleCalendarClient(
      (request) => this.googleRequest(request),
      () => this.googleAuth.getAccessToken(),
    );
  }

  private async resolveGoogleCalendar(): Promise<NonNullable<CalendarSettings["googleCalendar"]["calendar"]>> {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return this.googleClient().ensureAppCalendar(
      this.settings.googleCalendar.calendar,
      "Link Calendar",
      timeZone,
    );
  }

  private async googleRequest(input: GoogleHttpRequest): Promise<{ json: unknown; status: number }> {
    const response = await requestUrl({
      body: input.body,
      headers: input.headers,
      method: input.method,
      throw: false,
      url: input.url,
    });
    return { json: response.json, status: response.status };
  }

  private detectSource(folder: string, recursive: boolean): SourceDetection {
    return detectSourceFolder(this.app.vault, this.app.metadataCache, folder, recursive);
  }

  private chooseSourceFolder(): void {
    this.chooseFolder();
  }

  private previewSource(folder: TFolder): void {
    const detection = this.detectSource(folder.path, true);
    new SourcePreviewModal(
      this.app,
      this.settings.locale,
      folder,
      detection,
      async (presetId, startProperty) => {
        const profile = createPresetProfile(
          folder.path,
          presetId,
          detection.dateProperties.map((item) => item.name),
        );
        profile.properties.start = startProperty;
        this.settings.profiles.push(profile);
        await this.saveSettings(true);
        await this.openCalendar();
      },
    ).open();
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`${translate(this.settings.locale, "noteNotFound")}: ${path}`);
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  private async createEvent(initialDate: string): Promise<void> {
    const writable = writableProfiles(this.settings.profiles);
    if (!writable.length) {
      new Notice(translate(this.settings.locale, "writableSourceRequired"));
      return;
    }
    new EventModal(
      this.app,
      writable,
      initialDate,
      this.settings.locale,
      async (input) => {
        const profile = writableProfiles(this.settings.profiles)
          .find((candidate) => candidate.id === input.profileId);
        if (!profile) {
          new Notice(translate(this.settings.locale, "writableSourceRequired"));
          return;
        }
        try {
          const basename = safeBasename(input.title);
          let path = normalizePath(`${profile.folder}/${input.date} ${basename}.md`);
          for (let suffix = 2; this.app.vault.getAbstractFileByPath(path); suffix += 1) {
            path = normalizePath(`${profile.folder}/${input.date} ${basename} ${String(suffix)}.md`);
          }
          const frontmatter = eventFrontmatter(profile, input);
          const selected = selectProfileFromFrontmatter(
            { path },
            frontmatter,
            this.settings.profiles,
          );
          if (!canCreateWithProfile(profile, selected)) {
            new Notice(translate(this.settings.locale, "writableSourceRequired"));
            return;
          }
          await this.ensureFolder(profile.folder);
          const yaml = stringifyYaml(frontmatter).trimEnd();
          const file = await this.app.vault.create(path, `---\n${yaml}\n---\n\n# ${input.title}\n`);
          this.index.update(file, frontmatter);
          this.publishSnapshot();
          await this.app.workspace.getLeaf("tab").openFile(file);
        } catch {
          new Notice(translate(this.settings.locale, "createFailed"));
        }
      },
    ).open();
  }

  private async moveEvent(event: CalendarEvent, targetDate: string): Promise<void> {
    const profile = this.settings.profiles.find((candidate) => candidate.id === event.profileId);
    const file = this.app.vault.getAbstractFileByPath(event.filePath);
    if (!profile || !(file instanceof TFile)) return;
    let updated: Record<string, unknown> | undefined;
    let undoReceipt: MoveUndoReceipt | undefined;
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const target = frontmatter as Record<string, unknown>;
        const current = structuredClone(target);
        const selected = selectProfileFromFrontmatter(
          file,
          current,
          this.settings.profiles,
        );
        if (!frontmatterMatchesEventDates(event, profile, current)) {
          throw new EventMutationConflict();
        }
        const changes = planMoveFrontmatter(event, profile, selected, current, targetDate);
        if (!changes) {
          throw new EventMutationRejected();
        }
        undoReceipt = {
          expected: structuredClone(changes),
          filePath: file.path,
          profileId: profile.id,
          restore: Object.fromEntries(Object.keys(changes).map((key) => [key, current[key]])),
        };
        Object.assign(target, changes);
        updated = structuredClone(target);
      });
      this.index.update(file, updated);
      this.publishSnapshot();
      if (undoReceipt) {
        this.lastMove = undoReceipt;
        this.showUndoNotice(undoReceipt);
      }
    } catch (error) {
      new Notice(translate(
        this.settings.locale,
        error instanceof EventMutationConflict
          ? "moveConflict"
          : error instanceof EventMutationRejected ? "readOnly" : "moveFailed",
      ));
    }
  }

  private showUndoNotice(receipt: MoveUndoReceipt): void {
    const fragment = createFragment();
    fragment.append(document.createTextNode(`${translate(this.settings.locale, "moveComplete")} `));
    const button = createEl("button");
    button.type = "button";
    button.textContent = translate(this.settings.locale, "undo");
    fragment.append(button);
    const notice = new Notice(fragment, 8_000);
    button.addEventListener("click", () => {
      notice.hide();
      void this.undoMove(receipt);
    });
  }

  private async undoMove(receipt: MoveUndoReceipt): Promise<void> {
    if (this.lastMove !== receipt) return;
    const profile = this.settings.profiles.find((candidate) => candidate.id === receipt.profileId);
    const file = this.app.vault.getAbstractFileByPath(receipt.filePath);
    if (!profile || !(file instanceof TFile) || writableProfiles([profile]).length !== 1) {
      this.lastMove = null;
      new Notice(translate(this.settings.locale, "undoConflict"));
      return;
    }
    let updated: Record<string, unknown> | undefined;
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const target = frontmatter as Record<string, unknown>;
        const current = structuredClone(target);
        const selected = selectProfileFromFrontmatter(file, current, this.settings.profiles);
        if (selected?.id !== profile.id || !frontmatterMatchesChanges(current, receipt.expected)) {
          throw new EventMutationConflict();
        }
        Object.assign(target, receipt.restore);
        updated = structuredClone(target);
      });
      this.lastMove = null;
      this.index.update(file, updated);
      this.publishSnapshot();
      new Notice(translate(this.settings.locale, "undoComplete"));
    } catch {
      this.lastMove = null;
      new Notice(translate(this.settings.locale, "undoConflict"));
    }
  }

  private async ensureFolder(folder: string): Promise<void> {
    const segments = normalizePath(folder).split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`Expected folder: ${current}`);
    }
  }

  renderEmbed(source: string, element: HTMLElement): void {
    const config = parseBlock(source);
    element.empty();
    const root = element.createDiv({ cls: "link-calendar-embed" });
    root.createEl("strong", { text: config.title || "Link Calendar Navigator" });
    if (config.invalid) {
      root.createDiv({
        cls: "link-calendar-embed__error",
        text: translate(this.settings.locale, "invalidEmbedSource"),
      });
      return;
    }
    const events = this.index.snapshot().events.filter((event) =>
      !config.source || event.filePath.startsWith(`${config.source}/`));
    const upcoming = events
      .filter((event) => event.endDate >= (dateKey(new Date()) ?? ""))
      .slice(0, 5);
    const list = root.createDiv({ cls: "link-calendar-embed__events" });
    for (const event of upcoming) {
      const button = list.createEl("button", { attr: { type: "button" } });
      button.createEl("time", { text: event.startDate });
      button.createSpan({ text: event.title });
      button.onclick = () => void this.openPath(event.filePath);
    }
    root.createEl("button", {
      text: translate(this.settings.locale, "openCalendar"),
      attr: { type: "button" },
    }).onclick = () => void this.openCalendar();
  }
}

class EventMutationRejected extends Error {}
class EventMutationConflict extends Error {}

class CalendarEmbedChild extends MarkdownRenderChild {
  constructor(
    container: HTMLElement,
    private readonly plugin: LinkCalendarPlugin,
    private readonly source: string,
  ) {
    super(container);
  }

  override onload(): void {
    const render = () => this.plugin.renderEmbed(this.source, this.containerEl);
    render();
    this.register(this.plugin.subscribe(render));
  }
}

export function parseBlock(source: string): { invalid: boolean; source: string; title: string } {
  if (!source.trim()) return { invalid: false, source: "", title: "" };
  try {
    const value: unknown = parseYaml(source);
    if (!isRecord(value)) return { invalid: true, source: "", title: "" };
    const parsedSource = embedSource(value.source);
    return {
      invalid: parsedSource.invalid,
      source: parsedSource.source,
      title: typeof value.title === "string" ? value.title.trim() : "",
    };
  } catch {
    return { invalid: true, source: "", title: "" };
  }
}

function safeBasename(value: string): string {
  return value.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 96) || "Event";
}
