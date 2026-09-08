import { TFile, TFolder, type CachedMetadata, type MetadataCache, type Vault } from "obsidian";

import {
  type CalendarEvent,
  type CalendarSnapshot,
  type Diagnostic,
  type SourceProfile,
  type TemporalSource,
  MAX_EVENT_SPAN_DAYS,
  calendarSpanLength,
  dateKey,
  isRecord,
  readField,
  values,
} from "./model";
import { type TemporalCandidate, extractMarkdownTemporal } from "./temporal";

export { readField } from "./model";

interface IndexedNote {
  diagnostic: Diagnostic | null;
  event: CalendarEvent | null;
}

export interface SourceDetection {
  dateProperties: { count: number; name: string }[];
  datedNoteCount: number;
  noteCount: number;
  suggestedStart: string;
}

export interface SourceHealth {
  invalid: number;
  missing: number;
  total: number;
  valid: number;
}

export class CalendarIndex {
  private readonly notes = new Map<string, IndexedNote>();
  private readonly automaticBody = new Map<string, CalendarEvent[]>();
  private readonly bodyVersions = new Map<string, number>();
  private autoIndexDates: boolean;
  private profiles: SourceProfile[];
  private revision = 0;

  constructor(
    private readonly vault: Vault,
    private readonly metadataCache: MetadataCache,
    profiles: SourceProfile[],
    autoIndexDates = true,
  ) {
    this.profiles = profiles;
    this.autoIndexDates = autoIndexDates;
  }

  rebuild(): void {
    this.notes.clear();
    this.automaticBody.clear();
    for (const file of sourceFiles(this.vault, this.profiles)) this.indexFile(file);
    this.revision += 1;
  }

  async rebuildBodies(): Promise<void> {
    if (!this.autoIndexDates || typeof this.vault.cachedRead !== "function") return;
    const files = automaticSourceFiles(this.vault);
    for (let index = 0; index < files.length; index += 32) {
      await Promise.all(files.slice(index, index + 32).map((file) => this.indexBody(file)));
      await yieldToRenderer();
    }
    this.revision += 1;
  }

  update(file: TFile, frontmatterOverride?: Record<string, unknown>): void {
    this.notes.delete(file.path);
    this.indexFile(file, frontmatterOverride);
    this.revision += 1;
  }

  async updateBody(file: TFile): Promise<void> {
    if (!this.autoIndexDates || !isAutomaticSourcePath(file.path)) {
      this.automaticBody.delete(file.path);
      return;
    }
    await this.indexBody(file);
    this.revision += 1;
  }

  remove(path: string): void {
    this.bodyVersions.set(path, (this.bodyVersions.get(path) ?? 0) + 1);
    const profileRemoved = this.notes.delete(path);
    const bodyRemoved = this.automaticBody.delete(path);
    const removed = profileRemoved || bodyRemoved;
    if (removed) this.revision += 1;
  }

  setConfiguration(profiles: SourceProfile[], autoIndexDates: boolean): void {
    this.profiles = profiles;
    this.autoIndexDates = autoIndexDates;
    this.rebuild();
  }

  snapshot(): CalendarSnapshot {
    const diagnostics: Diagnostic[] = [];
    const events: CalendarEvent[] = [];
    for (const note of this.notes.values()) {
      if (note.diagnostic) diagnostics.push(note.diagnostic);
      if (note.event) events.push(note.event);
    }
    for (const automatic of this.automaticBody.values()) events.push(...automatic);
    const merged = mergeTemporalEvents(events);
    merged.sort((left, right) =>
      left.startDate.localeCompare(right.startDate)
      || left.startTime.localeCompare(right.startTime)
      || left.title.localeCompare(right.title)
      || left.filePath.localeCompare(right.filePath),
    );
    diagnostics.sort((left, right) => left.filePath.localeCompare(right.filePath));
    return { diagnostics, events: merged, revision: this.revision };
  }

  sourceHealth(profileId: string): SourceHealth {
    const health: SourceHealth = { invalid: 0, missing: 0, total: 0, valid: 0 };
    for (const note of this.notes.values()) {
      const noteProfileId = note.event?.profileId ?? note.diagnostic?.profileId;
      if (noteProfileId !== profileId) continue;
      health.total += 1;
      if (note.event) health.valid += 1;
      else if (note.diagnostic?.code === "missing-date") health.missing += 1;
      else health.invalid += 1;
    }
    return health;
  }

  private indexFile(file: TFile, frontmatterOverride?: Record<string, unknown>): void {
    const cache = this.metadataCache.getFileCache(file);
    const effectiveCache = frontmatterOverride
      ? metadataWithFrontmatter(cache, frontmatterOverride)
      : cache;
    const profile = selectProfile(file, effectiveCache, this.profiles);
    if (!profile) return;
    const frontmatter = frontmatterOverride ?? (isRecord(cache?.frontmatter) ? cache.frontmatter : {});
    const rawStart = readField(frontmatter, profile.properties.start);
    const start = dateKey(rawStart);
    if (!start) {
      this.notes.set(file.path, {
        diagnostic: {
          code: rawStart === undefined ? "missing-date" : "invalid-date",
          filePath: file.path,
          profileId: profile.id,
        },
        event: null,
      });
      return;
    }
    const rawEnd = readField(frontmatter, profile.properties.end);
    const explicitEnd = rawEnd !== undefined;
    const parsedEnd = explicitEnd ? dateKey(rawEnd) : start;
    if (!parsedEnd) {
      this.notes.set(file.path, invalidNote(file.path, profile.id, "invalid-end"));
      return;
    }
    const end = parsedEnd;
    if (end < start) {
      this.notes.set(file.path, invalidNote(file.path, profile.id, "end-before-start"));
      return;
    }
    if (calendarSpanLength(start, end) > MAX_EVENT_SPAN_DAYS) {
      this.notes.set(file.path, invalidNote(file.path, profile.id, "event-too-long"));
      return;
    }
    const title = stringField(frontmatter, profile.properties.title) || file.basename;
    const category = stringField(frontmatter, profile.properties.category);
    const allDay = booleanField(frontmatter, profile.properties.allDay);
    const writableProfile = selectProfileFromFrontmatter(file, frontmatter, this.profiles);
    this.notes.set(file.path, {
      diagnostic: null,
      event: {
        access: stringField(frontmatter, "access"),
        allDay,
        category,
        editable: profile.editable && writableProfile?.id === profile.id,
        endDate: end,
        endTime: allDay ? "" : stringField(frontmatter, profile.properties.endTime),
        filePath: file.path,
        id: `${profile.id}:${file.path}`,
        kind: end > start ? "period" : "event",
        origin: "profile",
        profileId: profile.id,
        sources: [{ excerpt: "Frontmatter", filePath: file.path, line: 0 }],
        startDate: start,
        startTime: allDay ? "" : stringField(frontmatter, profile.properties.startTime),
        title,
      },
    });
  }

  private async indexBody(file: TFile): Promise<void> {
    const version = (this.bodyVersions.get(file.path) ?? 0) + 1;
    this.bodyVersions.set(file.path, version);
    let markdown: string;
    try {
      markdown = await this.vault.cachedRead(file);
    } catch {
      return;
    }
    if (this.bodyVersions.get(file.path) !== version) return;
    const candidates = extractMarkdownTemporal(file.path, file.basename, markdown);
    if (candidates.length) {
      this.automaticBody.set(
        file.path,
        candidates.map((candidate) => this.toTemporalEvent(file, candidate)),
      );
    } else {
      this.automaticBody.delete(file.path);
    }
  }

  private toTemporalEvent(file: TFile, candidate: TemporalCandidate): CalendarEvent {
    const resolvedDestination = candidate.linkPath
      ? this.metadataCache.getFirstLinkpathDest(candidate.linkPath, file.path)
      : null;
    const destination = resolvedDestination && isAutomaticSourcePath(resolvedDestination.path)
      ? resolvedDestination
      : null;
    const filePath = destination?.path ?? file.path;
    const destinationFrontmatter = destination
      ? this.metadataCache.getFileCache(destination)?.frontmatter
      : null;
    const canonicalTitle = isRecord(destinationFrontmatter)
      ? stringField(destinationFrontmatter, "title")
      : "";
    const kind = candidate.kind;
    const identity = [filePath, candidate.startDate, candidate.endDate, kind].join(":");
    return {
      allDay: !candidate.startTime,
      category: candidate.category,
      editable: false,
      endDate: candidate.endDate,
      endTime: candidate.endTime,
      filePath,
      id: `temporal:${identity}`,
      kind,
      ongoing: candidate.ongoing,
      origin: candidate.origin,
      profileId: "automatic-temporal-index",
      sources: [candidate.source],
      startDate: candidate.startDate,
      startTime: candidate.startTime,
      title: canonicalTitle || (candidate.linkPath && !destination ? file.basename : candidate.title),
    };
  }
}

export function matchesProfile(
  file: Pick<TFile, "path">,
  cache: CachedMetadata | null,
  profile: SourceProfile,
): boolean {
  if (!profile.enabled || !profile.folder) return false;
  const folderMatches = file.path.startsWith(`${profile.folder}/`)
    && (profile.recursive || !file.path.slice(profile.folder.length + 1).includes("/"));
  if (!folderMatches) return false;
  if (!profile.tag) return true;
  const expected = profile.tag.toLocaleLowerCase();
  return tags(cache).some((tag) => tag.toLocaleLowerCase() === expected);
}

export function selectProfile(
  file: Pick<TFile, "path">,
  cache: CachedMetadata | null,
  profiles: SourceProfile[],
): SourceProfile | undefined {
  return profiles
    .filter((profile) => matchesProfile(file, cache, profile))
    .sort((left, right) =>
      right.folder.length - left.folder.length
      || Number(left.editable) - Number(right.editable)
      || left.id.localeCompare(right.id),
    )[0];
}

export function selectProfileFromFrontmatter(
  file: Pick<TFile, "path">,
  frontmatter: Record<string, unknown>,
  profiles: SourceProfile[],
): SourceProfile | undefined {
  return selectProfile(file, { frontmatter }, profiles);
}

function metadataWithFrontmatter(
  cache: CachedMetadata | null,
  frontmatter: Record<string, unknown>,
): CachedMetadata {
  return { ...(cache ?? {}), frontmatter };
}

function tags(cache: CachedMetadata | null): string[] {
  const result = new Set<string>();
  for (const item of cache?.tags ?? []) result.add(item.tag.replace(/^#/, ""));
  const frontmatter = isRecord(cache?.frontmatter) ? cache.frontmatter : {};
  for (const item of values(readField(frontmatter, "tags"))) result.add(item.replace(/^#/, ""));
  return [...result];
}

function stringField(frontmatter: Record<string, unknown>, name: string): string {
  const value = readField(frontmatter, name);
  if (typeof value === "string") return value.trim();
  return typeof value === "number" ? String(value) : "";
}

function booleanField(frontmatter: Record<string, unknown>, name: string): boolean {
  const value = readField(frontmatter, name);
  return value === true || (typeof value === "string" && value.toLocaleLowerCase() === "true");
}

function invalidNote(
  filePath: string,
  profileId: string,
  code: Diagnostic["code"],
): IndexedNote {
  return { diagnostic: { code, filePath, profileId }, event: null };
}

function sourceFiles(vault: Vault, profiles: SourceProfile[]): TFile[] {
  const files = new Map<string, TFile>();
  for (const profile of profiles) {
    if (!profile.enabled || !profile.folder) continue;
    const folder = vault.getFolderByPath(profile.folder);
    if (!folder) continue;
    collectMarkdownFiles(folder, profile.recursive, files);
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function automaticSourceFiles(vault: Vault): TFile[] {
  if (typeof vault.getMarkdownFiles !== "function") return [];
  return vault.getMarkdownFiles()
    .filter((file) => isAutomaticSourcePath(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function isAutomaticSourcePath(path: string): boolean {
  return !path.split("/").some((part) =>
    part.startsWith(".") || isReferenceArchiveSegment(part));
}

const REFERENCE_ARCHIVE_SEGMENTS = new Set([
  "_sources",
  "archive",
  "archives",
  "backup",
  "backups",
  "legacy-backup",
  "retired",
]);

function isReferenceArchiveSegment(part: string): boolean {
  return REFERENCE_ARCHIVE_SEGMENTS.has(part.toLocaleLowerCase());
}

function mergeTemporalEvents(events: CalendarEvent[]): CalendarEvent[] {
  const merged = new Map<string, CalendarEvent>();
  for (const event of events) {
    const key = [event.filePath, event.startDate, event.endDate, event.kind].join("\u0000");
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, { ...event, sources: distinctSources(event.sources) });
      continue;
    }
    const preferred = originPriority(event.origin) > originPriority(previous.origin)
      ? event
      : previous;
    const fallback = preferred === event ? previous : event;
    merged.set(key, {
      ...preferred,
      category: preferred.category || fallback.category,
      ongoing: preferred.ongoing || fallback.ongoing,
      sources: distinctSources([...previous.sources, ...event.sources]),
    });
  }
  return [...merged.values()];
}

function distinctSources(sources: TemporalSource[]): TemporalSource[] {
  const result = new Map<string, TemporalSource>();
  for (const source of sources) {
    const key = [source.filePath, source.line, source.excerpt].join("\u0000");
    if (!result.has(key)) result.set(key, source);
  }
  return [...result.values()].sort((left, right) =>
    left.filePath.localeCompare(right.filePath) || left.line - right.line,
  );
}

function originPriority(origin: CalendarEvent["origin"]): number {
  return origin === "profile" ? 2 : 1;
}

async function yieldToRenderer(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

export function detectSourceFolder(
  vault: Vault,
  metadataCache: MetadataCache,
  folderPath: string,
  recursive: boolean,
): SourceDetection {
  const folder = vault.getFolderByPath(folderPath);
  if (!folder) {
    return { dateProperties: [], datedNoteCount: 0, noteCount: 0, suggestedStart: "" };
  }
  const files = new Map<string, TFile>();
  collectMarkdownFiles(folder, recursive, files);
  const counts = new Map<string, number>();
  for (const file of files.values()) {
    const frontmatter = metadataCache.getFileCache(file)?.frontmatter;
    if (!isRecord(frontmatter)) continue;
    for (const [name, value] of Object.entries(frontmatter)) {
      if (!dateKey(value)) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const dateProperties = [...counts].map(([name, count]) => ({ count, name })).sort((left, right) =>
    datePropertyPriority(left.name) - datePropertyPriority(right.name)
    || right.count - left.count
    || left.name.localeCompare(right.name),
  );
  const suggestedStart = dateProperties[0]?.name ?? "";
  return {
    dateProperties,
    datedNoteCount: suggestedStart ? counts.get(suggestedStart) ?? 0 : 0,
    noteCount: files.size,
    suggestedStart,
  };
}

export function inspectSourceHealth(
  vault: Vault,
  metadataCache: MetadataCache,
  profile: SourceProfile,
): SourceHealth {
  const folder = profile.folder ? vault.getFolderByPath(profile.folder) : null;
  if (!folder) return { invalid: 0, missing: 0, total: 0, valid: 0 };
  const files = new Map<string, TFile>();
  collectMarkdownFiles(folder, profile.recursive, files);
  const health: SourceHealth = { invalid: 0, missing: 0, total: 0, valid: 0 };
  for (const file of files.values()) {
    const cache = metadataCache.getFileCache(file);
    if (!matchesProfile(file, cache, profile)) continue;
    health.total += 1;
    const frontmatter = isRecord(cache?.frontmatter) ? cache.frontmatter : {};
    const rawStart = readField(frontmatter, profile.properties.start);
    if (rawStart === undefined) health.missing += 1;
    else if (dateKey(rawStart)) health.valid += 1;
    else health.invalid += 1;
  }
  return health;
}

function datePropertyPriority(name: string): number {
  const normalized = name.replace(/[\s_-]/g, "").toLocaleLowerCase();
  const preferred = ["date", "start", "startdate", "begins", "scheduled", "when", "day"];
  const index = preferred.indexOf(normalized);
  return index === -1 ? preferred.length : index;
}

function collectMarkdownFiles(folder: TFolder, recursive: boolean, files: Map<string, TFile>): void {
  for (const child of folder.children) {
    if (child instanceof TFile && child.extension === "md") files.set(child.path, child);
    else if (recursive && child instanceof TFolder) collectMarkdownFiles(child, true, files);
  }
}
