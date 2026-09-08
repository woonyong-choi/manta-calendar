import { ItemView, Menu, type WorkspaceLeaf, setIcon } from "obsidian";

import {
  type MessageKey,
  firstDayOfWeek,
  formatMessage,
  monthTitle,
  resolvedLocale,
  translate,
  weekdayNames,
} from "./i18n";
import {
  type CalendarEvent,
  type CalendarSettings,
  type CalendarSnapshot,
  type TemporalKind,
  addMonths,
  eachDate,
  fileTitle,
  localDateKey,
  monthGrid,
  parseDateKey,
} from "./model";
import {
  filterCalendarEvents,
  gridMovement,
  resolveEventPath,
} from "./policy";
import { type CalendarSurfaceState, calendarSurfaceState } from "./presentation";

export const VIEW_TYPE = "link-calendar-view";

const PANEL_ID = "link-calendar-agenda";
const PANEL_TITLE_ID = "link-calendar-agenda-title";
const SEARCH_DELAY_MS = 80;
const MAX_VISIBLE_EVENTS = 3;
const PRODUCT_NAME = ["Link", "Calendar"].join(" ");

export interface CalendarActions {
  create: (date: string) => Promise<void>;
  move: (event: CalendarEvent, date: string) => Promise<void>;
  open: (path: string) => Promise<void>;
  openSettings: () => void;
  setup: () => void;
}

export class LinkCalendarView extends ItemView {
  private month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  private query = "";
  private selectedDate = localDateKey(new Date());
  private selectedEventId = "";
  private sideClosed = false;
  private profileId = "";
  private snapshot: CalendarSnapshot = { diagnostics: [], events: [], revision: 0 };
  private searchTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => CalendarSettings,
    private readonly getSnapshot: () => CalendarSnapshot,
    private readonly actions: CalendarActions,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }

  override getDisplayText(): string {
    return PRODUCT_NAME;
  }

  override getIcon(): string {
    return "calendar-days";
  }

  setSnapshot(snapshot: CalendarSnapshot): void {
    this.snapshot = snapshot;
    if (this.selectedEventId && !snapshot.events.some((event) => event.id === this.selectedEventId)) {
      this.clearSelection();
    }
    this.render();
  }

  showToday(focus = false): void {
    const today = new Date();
    this.month = new Date(today.getFullYear(), today.getMonth(), 1);
    this.selectedDate = localDateKey(today);
    this.selectedEventId = "";
    this.render();
    if (focus) window.requestAnimationFrame(() => this.focusSelectedDay());
  }

  revealPath(path: string): boolean {
    const event = resolveEventPath(this.snapshot.events, path);
    if (!event) return false;
    const date = parseDateKey(event.startDate);
    this.month = new Date(date.getFullYear(), date.getMonth(), 1);
    this.profileId = "";
    this.selectEvent(event, event.startDate);
    return true;
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("link-calendar-view");
    this.registerDomEvent(document, "fullscreenchange", () => this.render());
    this.registerDomEvent(this.contentEl, "keydown", (event) => {
      if (event.key === "Escape" && !this.sideClosed) {
        event.preventDefault();
        this.closeSidePanel();
      }
    });
    this.setSnapshot(this.getSnapshot());
  }

  override async onClose(): Promise<void> {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    if (document.fullscreenElement === this.contentEl) await document.exitFullscreen();
  }

  private render(): void {
    const settings = this.getSettings();
    const root = this.contentEl;
    root.empty();
    const shell = root.createDiv({ cls: "link-calendar" });
    this.renderHeader(shell, settings);

    const enabledProfiles = settings.profiles.filter((profile) => profile.enabled && profile.folder);
    if (!enabledProfiles.some((profile) => profile.id === this.profileId)) this.profileId = "";
    if (!enabledProfiles.length && !settings.autoIndexDates) {
      this.renderOnboarding(shell, settings);
      return;
    }

    if (settings.autoIndexDates || enabledProfiles.length > 1 || this.query) {
      this.renderScope(shell, settings, enabledProfiles);
    }

    const body = shell.createDiv({ cls: "link-calendar__body" });
    const monthPanel = this.renderMonth(body, settings);
    const visibleEvents = this.visibleEvents();
    const monthEvents = visibleEvents.filter((event) => this.overlapsCurrentMonth(event));
    const diagnostics = this.visibleDiagnostics();
    const state = calendarSurfaceState({
      diagnosticCount: diagnostics.length,
      eventCount: monthEvents.length,
      filtered: Boolean(this.query.trim() || this.profileId),
      revision: this.snapshot.revision,
    });
    this.renderSurfaceState(monthPanel, state, settings);
    if (state === "ready" && diagnostics.length > 0) {
      this.renderDiagnosticNotice(monthPanel, settings, diagnostics.length);
    }

    if (settings.showAgenda && !this.sideClosed) {
      body.addClass("has-side");
      this.renderSidePanel(body, settings);
    }
  }

  private renderHeader(parent: HTMLElement, settings: CalendarSettings): void {
    const locale = settings.locale;
    const header = parent.createEl("header", { cls: "link-calendar__header" });
    const navigation = header.createDiv({ cls: "link-calendar__navigation" });
    navigation.append(
      iconButton("chevron-left", translate(locale, "previous"), () => {
        this.navigateMonth(-1);
      }),
      iconButton("chevron-right", translate(locale, "next"), () => {
        this.navigateMonth(1);
      }),
    );
    navigation.append(iconButton("calendar-check", translate(locale, "today"), () => this.showToday(true)));
    header.createEl("h1", {
      cls: "link-calendar__title",
      text: monthTitle(locale, this.month),
      attr: { "aria-live": "polite" },
    });
    const tools = header.createDiv({ cls: "link-calendar__tools" });
    const searchContainer = tools.createDiv({
      cls: "search-input-container link-calendar__search",
    });
    const search = searchContainer.createEl("input", {
      attr: { "aria-label": translate(locale, "search"), type: "search" },
      placeholder: translate(locale, "search"),
      value: this.query,
    });
    search.addEventListener("input", (event) => {
      this.query = search.value;
      if ("isComposing" in event && event.isComposing === true) return;
      if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null;
        this.normalizeSelection();
        this.render();
        const next = this.contentEl.querySelector<HTMLInputElement>(".link-calendar__search input");
        next?.focus();
        next?.setSelectionRange(this.query.length, this.query.length);
      }, SEARCH_DELAY_MS);
    });
    if (settings.profiles.some((profile) => profile.enabled && profile.editable && profile.folder)) {
      const add = iconButton("plus", translate(locale, "create"), () => {
        void this.actions.create(this.selectedDate);
      });
      add.addClass("link-calendar__add");
      tools.append(add);
    }
    tools.append(iconButton(
      document.fullscreenElement === this.contentEl ? "minimize-2" : "maximize-2",
      translate(locale, document.fullscreenElement === this.contentEl ? "exitFocusMode" : "focusMode"),
      () => void this.toggleFocusMode(),
    ));
    tools.append(iconButton("settings", translate(locale, "settings"), () => {
      this.actions.openSettings();
    }));
  }

  private renderOnboarding(parent: HTMLElement, settings: CalendarSettings): void {
    const empty = parent.createDiv({
      cls: "link-calendar__onboarding",
      attr: { "aria-live": "polite", role: "status" },
    });
    setIcon(empty.createDiv({ cls: "link-calendar__onboarding-icon" }), "calendar-search");
    empty.createEl("h2", { text: translate(settings.locale, "noSources") });
    empty.createEl("p", { text: translate(settings.locale, "onboarding") });
    this.renderExample(empty, settings);
    empty.createEl("button", {
      cls: "mod-cta",
      text: translate(settings.locale, "chooseFolder"),
      attr: { type: "button" },
    }).onclick = () => this.actions.setup();
  }

  private renderExample(parent: HTMLElement, settings: CalendarSettings): void {
    const help = parent.createEl("details", { cls: "link-calendar__example" });
    help.createEl("summary", { text: translate(settings.locale, "exampleHelp") });
    const example = `- ${this.selectedDate} ${settings.locale === "ko" ? "예정 · 회의 준비" : "scheduled · Prepare meeting"}`;
    help.createEl("pre").createEl("code", { text: example });
    const copy = iconButton("copy", translate(settings.locale, "copyExample"), () => undefined);
    help.append(copy);
    const showCopyState = (icon: string, key: MessageKey) => {
      setIcon(copy, icon);
      copy.title = translate(settings.locale, key);
      copy.setAttribute("aria-label", copy.title);
    };
    copy.onclick = () => {
      void Promise.resolve().then(() => navigator.clipboard.writeText(example))
        .then(() => showCopyState("check", "exampleCopied"))
        .catch(() => showCopyState("triangle-alert", "copyFailed"));
    };
  }

  private async toggleFocusMode(): Promise<void> {
    if (document.fullscreenElement === this.contentEl) await document.exitFullscreen();
    else await this.contentEl.requestFullscreen();
  }

  private renderScope(
    parent: HTMLElement,
    settings: CalendarSettings,
    profiles: CalendarSettings["profiles"],
  ): void {
    const scope = parent.createEl("nav", {
      cls: "link-calendar__scope",
      attr: { "aria-label": translate(settings.locale, "calendarScope") },
    });
    if (profiles.length) {
      scope.createSpan({ cls: "link-calendar__scope-label", text: translate(settings.locale, "sources") });
      const all = scope.createEl("button", {
        text: translate(settings.locale, "allSources"),
        attr: { "aria-pressed": String(!this.profileId), type: "button" },
      });
      all.onclick = () => {
        this.profileId = "";
        this.normalizeSelection();
        this.render();
      };
    }
    for (const profile of profiles) {
      const count = this.snapshot.events.filter((event) =>
        event.profileId === profile.id && this.overlapsCurrentMonth(event)).length;
      const button = scope.createEl("button", {
        text: `${profile.name} ${String(count)}`,
        attr: { "aria-pressed": String(this.profileId === profile.id), type: "button" },
      });
      button.onclick = () => {
        this.profileId = profile.id;
        this.normalizeSelection();
        this.render();
      };
    }
    if (this.query) {
      scope.createDiv({ cls: "link-calendar__scope-divider" });
      const label = this.query;
      const clear = scope.createEl("button", {
        cls: "link-calendar__lens",
        text: `${label} ×`,
        title: translate(settings.locale, "clearFilter"),
        attr: { type: "button" },
      });
      clear.onclick = () => this.clearFilters();
    }
    scope.createSpan({
      cls: "link-calendar__result-count",
      text: formatMessage(settings.locale, "visibleEvents", {
        count: String(this.visibleEvents().filter((event) => this.overlapsCurrentMonth(event)).length),
      }),
      attr: { "aria-live": "polite" },
    });
  }

  private renderMonth(parent: HTMLElement, settings: CalendarSettings): HTMLElement {
    const monthPanel = parent.createEl("section", { cls: "link-calendar__month" });
    const firstDay = firstDayOfWeek(settings.locale, settings.weekStart);
    const dates = monthGrid(this.month, firstDay);
    const weekCount = dates.length / 7;
    const grid = monthPanel.createDiv({
      cls: `link-calendar__grid weeks-${String(weekCount)}`,
      attr: {
        "aria-colcount": "7",
        "aria-label": monthTitle(settings.locale, this.month),
        "aria-rowcount": String(weekCount + 1),
        role: "grid",
      },
    });
    weekdayNames(settings.locale, firstDay).forEach((weekday, index) => {
      grid.createDiv({
        cls: "link-calendar__weekday",
        text: weekday,
        attr: { "aria-colindex": String(index + 1), role: "columnheader" },
      });
    });
    const visibleEvents = this.visibleEvents();
    const eventsByDate = new Map<string, CalendarEvent[]>();
    for (const event of visibleEvents) {
      for (const day of eachDate(event.startDate, event.endDate)) {
        const events = eventsByDate.get(day) ?? [];
        events.push(event);
        eventsByDate.set(day, events);
      }
    }
    const today = localDateKey(new Date());
    dates.forEach((date, index) => {
      const day = parseDateKey(date);
      const outside = day.getMonth() !== this.month.getMonth();
      const cell = grid.createDiv({
        cls: `link-calendar__day${outside ? " is-outside" : ""}${date === this.selectedDate ? " is-selected" : ""}`,
        attr: {
          "aria-colindex": String((index % 7) + 1),
          "aria-current": date === today ? "date" : null,
          "aria-label": date === today ? `${date}, ${translate(settings.locale, "today")}` : date,
          "aria-rowindex": String(Math.floor(index / 7) + 2),
          "aria-selected": String(date === this.selectedDate),
          role: "gridcell",
          tabindex: date === this.selectedDate ? "0" : "-1",
        },
      });
      cell.createSpan({
        cls: `link-calendar__day-number${date === today ? " is-today" : ""}`,
        text: String(day.getDate()),
        attr: { "aria-hidden": "true" },
      });
      cell.addEventListener("click", (event) => {
        if (event.target === cell || event.target === cell.firstElementChild) this.selectDate(date);
      });
      cell.addEventListener("keydown", (event) => this.handleDayKey(event, day, date, firstDay));
      cell.addEventListener("dragover", (event) => event.preventDefault());
      cell.addEventListener("drop", (event) => {
        event.preventDefault();
        const id = event.dataTransfer?.getData("text/link-calendar-event");
        const calendarEvent = this.snapshot.events.find((candidate) => candidate.id === id);
        if (calendarEvent?.editable) void this.actions.move(calendarEvent, date);
      });
      const events = eventsByDate.get(date) ?? [];
      const markers = cell.createDiv({
        cls: "link-calendar__markers",
        attr: { "data-event-count": String(events.length) },
      });
      for (const event of events.slice(0, MAX_VISIBLE_EVENTS)) {
        this.renderMarker(markers, event, settings, date);
      }
      const hiddenCount = Math.max(0, events.length - MAX_VISIBLE_EVENTS);
      if (hiddenCount > 0) {
        const more = markers.createEl("button", {
          cls: "link-calendar__marker-more",
          text: formatMessage(settings.locale, "moreEvents", { count: String(hiddenCount) }),
          attr: {
            "aria-label": formatMessage(settings.locale, "moreEvents", { count: String(hiddenCount) }),
            type: "button",
          },
        });
        more.onclick = () => this.selectDate(date);
      }
    });
    return monthPanel;
  }

  private handleDayKey(
    event: KeyboardEvent,
    day: Date,
    date: string,
    firstDay: 0 | 1,
  ): void {
    if (event.target !== event.currentTarget) return;
    const weekOffset = (day.getDay() - firstDay + 7) % 7;
    const movement = gridMovement(event.key, weekOffset);
    if (movement !== null) {
      event.preventDefault();
      const target = new Date(day);
      target.setDate(target.getDate() + movement);
      this.selectedDate = localDateKey(target);
      this.month = new Date(target.getFullYear(), target.getMonth(), 1);
      this.render();
      window.requestAnimationFrame(() => this.focusSelectedDay());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.selectDate(date);
    }
  }

  private renderMarker(
    parent: HTMLElement,
    event: CalendarEvent,
    settings: CalendarSettings,
    visibleDate: string,
  ): void {
    const accessibleName = [event.title, event.category].filter(Boolean).join(", ");
    const marker = parent.createEl("button", {
      cls: `link-calendar__marker is-kind-${event.kind}`,
      title: event.title,
      attr: {
        "aria-controls": PANEL_ID,
        "aria-expanded": String(event.id === this.selectedEventId && !this.sideClosed),
        "aria-label": accessibleName,
        "aria-pressed": String(event.id === this.selectedEventId),
        draggable: String(event.editable),
        type: "button",
        "data-event-id": event.id,
      },
    });
    marker.createSpan({ cls: "link-calendar__marker-label", text: event.title });
    if (event.id === this.selectedEventId) marker.addClass("is-active");
    marker.onclick = (click) => {
      click.stopPropagation();
      this.selectEvent(event, visibleDate);
    };
    marker.onkeydown = (keyboardEvent) => {
      if (keyboardEvent.key === "Enter" && (keyboardEvent.metaKey || keyboardEvent.ctrlKey)) {
        keyboardEvent.preventDefault();
        keyboardEvent.stopPropagation();
        void this.actions.open(event.filePath);
      }
    };
    marker.oncontextmenu = (mouseEvent) => {
      const menu = new Menu();
      menu.addItem((item) => item
        .setTitle(translate(settings.locale, "open"))
        .setIcon("file-text")
        .onClick(() => void this.actions.open(event.filePath)));
      if (event.editable) {
        menu.addItem((item) => item
          .setTitle(translate(settings.locale, "create"))
          .setIcon("copy-plus")
          .onClick(() => void this.actions.create(event.startDate)));
      }
      menu.showAtMouseEvent(mouseEvent);
    };
    marker.addEventListener("dragstart", (dragEvent) => {
      if (!event.editable) {
        dragEvent.preventDefault();
        return;
      }
      dragEvent.dataTransfer?.setData("text/link-calendar-event", event.id);
      if (dragEvent.dataTransfer) dragEvent.dataTransfer.effectAllowed = "move";
    });
  }

  private renderSurfaceState(
    parent: HTMLElement,
    state: CalendarSurfaceState,
    settings: CalendarSettings,
  ): void {
    if (state === "ready") return;
    const keys = {
      empty: ["calendar-off", "emptyMonth", "emptyMonthDesc"],
      error: ["triangle-alert", "invalidNotes", "invalidNotesDesc"],
      "filtered-empty": ["list-filter", "noFilterResults", "noFilterResultsDesc"],
      loading: ["loader-circle", "loading", "loadingDesc"],
    } as const;
    const [icon, title, description] = keys[state];
    const surface = parent.createDiv({
      cls: `link-calendar__surface-state is-${state}`,
      attr: { "aria-live": "polite", role: state === "error" ? "alert" : "status" },
    });
    setIcon(surface.createDiv({ cls: "link-calendar__surface-icon" }), icon);
    surface.createEl("h2", { text: translate(settings.locale, title) });
    surface.createEl("p", { text: translate(settings.locale, description) });
    if (state === "empty") this.renderExample(surface, settings);
    if (state === "filtered-empty") {
      surface.createEl("button", {
        text: translate(settings.locale, "clearFilters"),
        attr: { type: "button" },
      }).onclick = () => this.clearFilters();
    } else if (state === "error") {
      surface.createEl("button", {
        text: translate(settings.locale, "reviewDiagnostics"),
        attr: { type: "button" },
      }).onclick = () => {
        this.sideClosed = false;
        this.render();
        this.focusSidePanel();
      };
    }
  }

  private renderDiagnosticNotice(
    parent: HTMLElement,
    settings: CalendarSettings,
    count: number,
  ): void {
    const notice = parent.createEl("button", {
      cls: "link-calendar__diagnostic-notice",
      title: translate(settings.locale, "reviewDiagnostics"),
      attr: { type: "button" },
    });
    setIcon(notice.createSpan(), "triangle-alert");
    notice.createSpan({
      text: formatMessage(settings.locale, "invalidNoteCount", { count: String(count) }),
    });
    notice.onclick = () => {
      this.sideClosed = false;
      this.render();
      this.focusSidePanel();
    };
  }

  private renderSidePanel(parent: HTMLElement, settings: CalendarSettings): void {
    const panel = parent.createEl("aside", {
      cls: "link-calendar__side",
      attr: { "aria-labelledby": PANEL_TITLE_ID, id: PANEL_ID, tabindex: "-1" },
    });
    const dateEvents = this.visibleEvents().filter(
      (event) => event.startDate <= this.selectedDate && event.endDate >= this.selectedDate,
    );
    const topbar = panel.createDiv({ cls: "link-calendar__side-topbar" });
    const date = topbar.createDiv({ cls: "link-calendar__side-date", attr: { id: PANEL_TITLE_ID } });
    setIcon(date.createSpan({ cls: "link-calendar__side-date-icon" }), "calendar-days");
    date.createEl("time", { text: formatEventDate(settings.locale, this.selectedDate) });
    topbar.append(iconButton("x", translate(settings.locale, "closeAgenda"), () => {
      this.closeSidePanel();
    }));
    if (!dateEvents.length) panel.createDiv({ cls: "link-calendar__empty", text: translate(settings.locale, "empty") });
    else this.renderAgenda(panel, dateEvents, settings);
    this.renderDiagnostics(panel, settings);
  }

  private renderAgenda(
    parent: HTMLElement,
    events: CalendarEvent[],
    settings: CalendarSettings,
  ): void {
    const agenda = parent.createDiv({ cls: "link-calendar__agenda" });
    agenda.createDiv({
      cls: "link-calendar__agenda-label",
      text: formatMessage(settings.locale, "eventsOnDate", { count: String(events.length) }),
    });
    for (const event of events) {
      const time = formatEventTimeRange(event, settings);
      const item = agenda.createDiv({
        cls: `link-calendar__agenda-item${time ? " has-time" : ""}${event.id === this.selectedEventId ? " is-active" : ""}`,
      });
      if (time) item.createEl("time", {
        cls: "link-calendar__agenda-time",
        text: time,
      });
      const identity = item.createDiv({ cls: "link-calendar__agenda-identity" });
      const heading = identity.createDiv({ cls: "link-calendar__agenda-heading" });
      heading.createDiv({
        cls: `link-calendar__agenda-kind is-kind-${event.kind}`,
        text: translate(settings.locale, temporalKindMessage(event.kind)),
      });
      const link = heading.createEl("a", {
        cls: "link-calendar__agenda-link internal-link",
        title: `${translate(settings.locale, "open")}: ${event.title}`,
        attr: {
          "aria-label": `${translate(settings.locale, "open")}: ${event.title}`,
          "data-href": event.filePath,
          href: event.filePath,
        },
      });
      const icon = link.createSpan({ cls: "link-calendar__agenda-note-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "file-text");
      link.createSpan({ cls: "link-calendar__agenda-title", text: event.title });
      link.onclick = (mouseEvent) => {
        mouseEvent.preventDefault();
        void this.actions.open(event.filePath);
      };
      const sourcePaths = [...new Set(event.sources.map((source) => source.filePath))];
      const mentions = sourcePaths.filter((sourcePath) => sourcePath !== event.filePath);
      if ((event.origin !== "profile" && event.title !== fileTitle(event.filePath)) || mentions.length > 0) {
        const sources = identity.createDiv({ cls: "link-calendar__agenda-sources" });
        const canonical = sources.createDiv({ cls: "link-calendar__agenda-source-row" });
        const canonicalButton = canonical.createEl("button", {
          cls: "link-calendar__agenda-note-link",
          title: `${translate(settings.locale, "open")}: ${event.filePath}`,
          attr: {
            type: "button",
            "aria-label": `${translate(settings.locale, "open")}: ${fileTitle(event.filePath)}`,
          },
        });
        const noteIcon = canonicalButton.createSpan({
          cls: "link-calendar__agenda-note-icon",
          attr: { "aria-hidden": "true" },
        });
        setIcon(noteIcon, "file-text");
        canonicalButton.createSpan({ text: fileTitle(event.filePath) });
        canonicalButton.onclick = () => void this.actions.open(event.filePath);
        if (mentions.length > 0) {
          const mentioned = sources.createDiv({ cls: "link-calendar__agenda-source-row" });
          mentioned.createSpan({
            cls: "link-calendar__agenda-source-label",
            text: formatMessage(settings.locale, "mentionedIn", {
              count: String(mentions.length),
            }),
          });
          for (const sourcePath of mentions) {
            const source = mentioned.createEl("button", {
              text: fileTitle(sourcePath),
              title: sourcePath,
              attr: { type: "button" },
            });
            source.onclick = () => void this.actions.open(sourcePath);
          }
        }
      }
    }
  }

  private renderDiagnostics(parent: HTMLElement, settings: CalendarSettings): void {
    const diagnostics = this.visibleDiagnostics();
    if (!diagnostics.length) return;
    const details = parent.createEl("details", { cls: "link-calendar__diagnostics" });
    details.createEl("summary", {
      text: `${translate(settings.locale, "diagnostics")} · ${String(diagnostics.length)}`,
    });
    for (const item of diagnostics.slice(0, 20)) {
      details.createEl("button", {
        text: `${fileTitle(item.filePath)} — ${translate(settings.locale, diagnosticMessage(item.code))}`,
        title: item.filePath,
        attr: { type: "button" },
      }).onclick = () => void this.actions.open(item.filePath);
    }
  }

  private clearFilters(): void {
    this.profileId = "";
    this.query = "";
    this.normalizeSelection();
    this.render();
  }

  private visibleEvents(): CalendarEvent[] {
    return filterCalendarEvents(this.snapshot.events, {
      profileId: this.profileId,
      query: this.query,
    });
  }

  private visibleDiagnostics(): CalendarSnapshot["diagnostics"] {
    return this.snapshot.diagnostics.filter((item) =>
      !this.profileId || item.profileId === this.profileId);
  }

  private normalizeSelection(): void {
    const visible = this.visibleEvents();
    if (visible.some((event) => event.id === this.selectedEventId)) return;
    this.clearSelection();
  }

  private clearSelection(): void {
    this.selectedEventId = "";
  }

  private navigateMonth(amount: number): void {
    const target = addMonths(this.month, amount);
    const selected = parseDateKey(this.selectedDate);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    this.month = target;
    this.selectedDate = localDateKey(new Date(
      target.getFullYear(),
      target.getMonth(),
      Math.min(selected.getDate(), lastDay),
    ));
    this.selectedEventId = "";
    this.render();
  }

  private overlapsCurrentMonth(event: CalendarEvent): boolean {
    const start = localDateKey(new Date(this.month.getFullYear(), this.month.getMonth(), 1));
    const end = localDateKey(new Date(this.month.getFullYear(), this.month.getMonth() + 1, 0));
    return event.startDate <= end && event.endDate >= start;
  }

  private selectDate(date: string): void {
    this.selectedDate = date;
    const selected = this.visibleEvents().find(
      (event) => event.startDate <= date && event.endDate >= date,
    );
    if (selected) {
      this.selectEvent(selected, date);
      return;
    }
    this.clearSelection();
    this.sideClosed = false;
    this.render();
    this.focusSidePanel();
  }

  private selectEvent(event: CalendarEvent, date: string): void {
    this.selectedDate = date;
    this.selectedEventId = event.id;
    this.sideClosed = false;
    this.render();
    this.focusSidePanel();
  }

  private closeSidePanel(): void {
    const selectedEventId = this.selectedEventId;
    this.sideClosed = true;
    this.render();
    if (selectedEventId) {
      window.requestAnimationFrame(() => {
        this.contentEl.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(selectedEventId)}"]`)?.focus();
      });
    } else {
      window.requestAnimationFrame(() => this.focusSelectedDay());
    }
  }

  private focusSidePanel(): void {
    window.requestAnimationFrame(() => {
      this.contentEl.querySelector<HTMLElement>(`#${PANEL_ID}`)?.focus({ preventScroll: true });
    });
  }

  private focusSelectedDay(): void {
    this.contentEl.querySelector<HTMLElement>(
      `[role="gridcell"][aria-label^="${this.selectedDate}"]`,
    )?.focus();
  }

}

function temporalKindMessage(kind: TemporalKind): MessageKey {
  if (kind === "period") return "temporalPeriod";
  if (kind === "history") return "temporalHistory";
  if (kind === "deadline") return "temporalDeadline";
  return "temporalEvent";
}

function diagnosticMessage(code: CalendarSnapshot["diagnostics"][number]["code"]):
  | "diagnosticEndBeforeStart"
  | "diagnosticEventTooLong"
  | "diagnosticInvalidDate"
  | "diagnosticInvalidEnd"
  | "diagnosticMissingDate" {
  if (code === "end-before-start") return "diagnosticEndBeforeStart";
  if (code === "event-too-long") return "diagnosticEventTooLong";
  if (code === "invalid-date") return "diagnosticInvalidDate";
  if (code === "invalid-end") return "diagnosticInvalidEnd";
  return "diagnosticMissingDate";
}

function iconButton(icon: string, label: string, action: () => void): HTMLButtonElement {
  const button = createEl("button", { cls: "clickable-icon link-calendar__icon-button" });
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  setIcon(button, icon);
  button.addEventListener("click", action);
  return button;
}

function formatEventDate(locale: CalendarSettings["locale"], date: string): string {
  return new Intl.DateTimeFormat(resolvedLocale(locale), {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parseDateKey(date));
}

function formatEventTimeRange(event: CalendarEvent, settings: CalendarSettings): string {
  if (event.allDay || !event.startTime) return "";
  const start = formatEventTime(event.startTime, settings);
  const end = formatEventTime(event.endTime, settings);
  return end && end !== start ? `${start}–${end}` : start;
}

function formatEventTime(value: string, settings: CalendarSettings): string {
  const wallClock = /(?:^|T)(\d{2}):(\d{2})/u.exec(value);
  if (!wallClock?.[1] || !wallClock[2]) return value;
  if (settings.timeFormat === "12-hour") {
    const date = new Date(Date.UTC(2000, 0, 1, Number(wallClock[1]), Number(wallClock[2])));
    return new Intl.DateTimeFormat(resolvedLocale(settings.locale), {
      hour: "numeric",
      hour12: true,
      minute: "2-digit",
      timeZone: "UTC",
    }).format(date);
  }
  return `${wallClock[1]}:${wallClock[2]}`;
}
