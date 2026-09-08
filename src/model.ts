export type LocaleId = "auto" | "en" | "ko";
type WeekStart = "auto" | "sunday" | "monday";
type TimeFormat = "12-hour" | "24-hour";

export interface PropertyMap {
  allDay: string;
  category: string;
  end: string;
  endTime: string;
  start: string;
  startTime: string;
  title: string;
}

export interface SourceProfile {
  editable: boolean;
  enabled: boolean;
  folder: string;
  id: string;
  name: string;
  properties: PropertyMap;
  recursive: boolean;
  tag: string;
}

export interface GoogleCalendarTarget {
  id: string;
  name: string;
  timeZone: string;
}

export interface GoogleSyncRecord {
  calendarId: string;
  etag: string;
  eventId: string;
  fingerprint: string;
  localKey: string;
}

interface GoogleCalendarSettings {
  calendar: GoogleCalendarTarget | null;
  defaultDurationMinutes: number;
  enabled: boolean;
  installationId: string;
  records: GoogleSyncRecord[];
  sourceProfileIds: string[];
}

export interface CalendarSettings {
  autoIndexDates: boolean;
  googleCalendar: GoogleCalendarSettings;
  locale: LocaleId;
  profiles: SourceProfile[];
  showAgenda: boolean;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
}

export type TemporalKind = "event" | "period" | "history" | "deadline";

export interface TemporalSource {
  excerpt: string;
  filePath: string;
  line: number;
}

export interface CalendarEvent {
  access?: string;
  allDay: boolean;
  category: string;
  editable: boolean;
  endDate: string;
  endTime: string;
  filePath: string;
  id: string;
  kind: TemporalKind;
  ongoing?: boolean;
  origin: "profile" | "body";
  profileId: string;
  sources: TemporalSource[];
  startDate: string;
  startTime: string;
  title: string;
}

export interface Diagnostic {
  code: "end-before-start" | "event-too-long" | "invalid-date" | "invalid-end" | "missing-date";
  filePath: string;
  profileId: string;
}

export const MAX_EVENT_SPAN_DAYS = 370;

export interface CalendarSnapshot {
  diagnostics: Diagnostic[];
  events: CalendarEvent[];
  revision: number;
}

const DEFAULT_PROPERTIES: PropertyMap = {
  allDay: "allDay",
  category: "category",
  end: "end",
  endTime: "endTime",
  start: "date",
  startTime: "startTime",
  title: "title",
};

export const DEFAULT_SETTINGS: CalendarSettings = {
  autoIndexDates: true,
  googleCalendar: {
    calendar: null,
    defaultDurationMinutes: 60,
    enabled: false,
    installationId: "",
    records: [],
    sourceProfileIds: [],
  },
  locale: "auto",
  profiles: [],
  showAgenda: true,
  timeFormat: "24-hour",
  weekStart: "auto",
};

export function createProfile(folder = ""): SourceProfile {
  const normalized = normalizeVaultPath(folder);
  return {
    editable: false,
    enabled: true,
    folder: normalized,
    id: crypto.randomUUID(),
    name: normalized ? normalized.split("/").at(-1) ?? normalized : "Calendar notes",
    properties: { ...DEFAULT_PROPERTIES },
    recursive: true,
    tag: "",
  };
}

export function normalizeSettings(value: unknown): CalendarSettings {
  if (!isRecord(value)) return structuredClone(DEFAULT_SETTINGS);
  const rawProfiles = Array.isArray(value.sourceProfiles)
    ? value.sourceProfiles
    : Array.isArray(value.profiles) ? value.profiles : [];
  const normalizedProfiles = rawProfiles
    .map(normalizeProfile).filter((item): item is SourceProfile => item !== null);
  const profileIds = new Map<string, number>();
  const profiles = normalizedProfiles.map((profile) => {
    const count = (profileIds.get(profile.id) ?? 0) + 1;
    profileIds.set(profile.id, count);
    return count === 1 ? profile : { ...profile, id: `${profile.id}-${String(count)}` };
  });
  return {
    autoIndexDates: value.autoIndexDates !== false,
    googleCalendar: normalizeGoogleCalendar(value.googleCalendar, profiles),
    locale: value.locale === "en" || value.locale === "ko" ? value.locale : "auto",
    profiles,
    showAgenda: value.showAgenda !== false && value.showContext !== false,
    timeFormat: value.timeFormat === "12-hour" ? "12-hour" : "24-hour",
    weekStart: value.weekStart === "sunday" || value.weekStart === "monday"
      ? value.weekStart
      : "auto",
  };
}

export function serializeSettings(settings: CalendarSettings): Record<string, unknown> {
  return {
    schemaVersion: 4,
    autoIndexDates: settings.autoIndexDates,
    googleCalendar: {
      calendar: settings.googleCalendar.calendar,
      defaultDurationMinutes: settings.googleCalendar.defaultDurationMinutes,
      enabled: settings.googleCalendar.enabled,
      installationId: settings.googleCalendar.installationId,
      records: settings.googleCalendar.records,
      sourceProfileIds: settings.googleCalendar.sourceProfileIds,
    },
    locale: settings.locale,
    showAgenda: settings.showAgenda,
    sourceProfiles: settings.profiles.map((profile) => ({
      editable: profile.editable,
      enabled: profile.enabled,
      id: profile.id,
      name: profile.name,
      properties: profile.properties,
      source: {
        path: profile.folder,
        recursive: profile.recursive,
        tag: profile.tag,
        type: "folder",
      },
    })),
    timeFormat: settings.timeFormat,
    weekStart: settings.weekStart,
  };
}

function normalizeGoogleCalendar(
  value: unknown,
  profiles: readonly SourceProfile[],
): GoogleCalendarSettings {
  if (!isRecord(value)) return structuredClone(DEFAULT_SETTINGS.googleCalendar);
  const allowedProfiles = new Set(profiles.map((profile) => profile.id));
  const sourceProfileIds = Array.isArray(value.sourceProfileIds)
    ? [...new Set(value.sourceProfileIds.filter((item): item is string =>
      typeof item === "string" && allowedProfiles.has(item),
    ))]
    : [];
  const rawCalendar = isRecord(value.calendar) ? value.calendar : null;
  const calendarId = rawCalendar ? stringValue(rawCalendar.id) : "";
  const calendar = calendarId && rawCalendar
    ? {
        id: calendarId,
        name: stringValue(rawCalendar.name) || calendarId,
        timeZone: stringValue(rawCalendar.timeZone) || "UTC",
      }
    : null;
  const records = Array.isArray(value.records)
    ? value.records.map(normalizeGoogleSyncRecord).filter((item): item is GoogleSyncRecord => item !== null)
    : [];
  const duration = typeof value.defaultDurationMinutes === "number"
    ? Math.round(value.defaultDurationMinutes)
    : 60;
  return {
    calendar,
    defaultDurationMinutes: duration >= 5 && duration <= 1_440 ? duration : 60,
    enabled: value.enabled === true,
    installationId: stringValue(value.installationId),
    records,
    sourceProfileIds,
  };
}

function normalizeGoogleSyncRecord(value: unknown): GoogleSyncRecord | null {
  if (!isRecord(value)) return null;
  const calendarId = stringValue(value.calendarId);
  const etag = stringValue(value.etag);
  const eventId = stringValue(value.eventId);
  const localKey = stringValue(value.localKey);
  if (!calendarId || !etag || !eventId || !localKey) return null;
  return {
    calendarId,
    etag,
    eventId,
    fingerprint: stringValue(value.fingerprint),
    localKey,
  };
}

function normalizeProfile(value: unknown): SourceProfile | null {
  if (!isRecord(value)) return null;
  const sourceConfig = isRecord(value.source) ? value.source : {};
  const folder = normalizeVaultPath(stringValue(sourceConfig.path) || stringValue(value.folder));
  const tag = (stringValue(sourceConfig.tag) || stringValue(value.tag)).replace(/^#/, "").trim();
  if (!folder && !tag) return null;
  const source = isRecord(value.properties) ? value.properties : {};
  return {
    editable: value.editable === true,
    enabled: Boolean(folder) && value.enabled !== false,
    folder,
    id: stringValue(value.id) || crypto.randomUUID(),
    name: stringValue(value.name) || folder || tag,
    properties: {
      allDay: propertyName(source.allDay, DEFAULT_PROPERTIES.allDay),
      category: propertyName(source.category, DEFAULT_PROPERTIES.category),
      end: propertyName(source.end, DEFAULT_PROPERTIES.end),
      endTime: propertyName(source.endTime, DEFAULT_PROPERTIES.endTime),
      start: propertyName(source.start, DEFAULT_PROPERTIES.start),
      startTime: propertyName(source.startTime, DEFAULT_PROPERTIES.startTime),
      title: propertyName(source.title, DEFAULT_PROPERTIES.title),
    },
    recursive: sourceConfig.recursive !== false && value.recursive !== false,
    tag,
  };
}

export function normalizeVaultPath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

export function isSafeVaultPath(value: string): boolean {
  const normalized = normalizeVaultPath(value);
  return Boolean(normalized) && !value.startsWith("/") && !normalized.split("/").includes("..");
}

const RESERVED_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const MAX_PROPERTY_NAME_LENGTH = 128;

export function isSafePropertyName(value: string, required = false): boolean {
  const normalized = value.trim();
  if (!normalized) return !required;
  return normalized.length <= MAX_PROPERTY_NAME_LENGTH
    && !hasControlCharacter(normalized)
    && !RESERVED_PROPERTY_NAMES.has(normalized.toLocaleLowerCase());
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function dateKey(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return localDateKey(value);
  }
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    : null;
}

export function localDateKey(value: Date): string {
  return [
    String(value.getFullYear()).padStart(4, "0"),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
}

export function parseDateKey(value: string): Date {
  const [year = 0, month = 1, day = 1] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(value: string, amount: number): string {
  const date = parseDateKey(value);
  date.setDate(date.getDate() + amount);
  return localDateKey(date);
}

export function eachDate(start: string, end: string): string[] {
  const length = calendarSpanLength(start, end);
  if (length < 1 || length > MAX_EVENT_SPAN_DAYS) return [];
  return Array.from({ length }, (_, index) => addDays(start, index));
}

export function calendarDayDifference(start: string, end: string): number {
  const [startYear = 0, startMonth = 1, startDay = 1] = start.split("-").map(Number);
  const [endYear = 0, endMonth = 1, endDay = 1] = end.split("-").map(Number);
  return Math.round(
    (Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay))
      / 86_400_000,
  );
}

export function calendarSpanLength(start: string, end: string): number {
  return calendarDayDifference(start, end) + 1;
}

export function monthGrid(month: Date, firstDay: 0 | 1): string[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() - firstDay + 7) % 7;
  first.setDate(first.getDate() - offset);
  const count = offset + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate() > 35 ? 42 : 35;
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(first);
    day.setDate(day.getDate() + index);
    return localDateKey(day);
  });
}

export function addMonths(value: Date, amount: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1);
}

export function values(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(values);
  if (typeof value !== "string") return [];
  return splitPropertyValue(value)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitPropertyValue(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let wikiDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const pair = value.slice(index, index + 2);
    if (pair === "[[") wikiDepth += 1;
    if (pair === "]]" && wikiDepth > 0) wikiDepth -= 1;
    if (value[index] === "," && wikiDepth === 0) {
      result.push(current);
      current = "";
    } else {
      current += value[index] ?? "";
    }
  }
  result.push(current);
  return result;
}

const CATEGORY_TONE_COUNT = 12;

export function categoryToken(
  value: string,
  assignments?: ReadonlyMap<string, string>,
): string {
  const normalized = categoryKey(value);
  const assigned = assignments?.get(normalized);
  if (assigned) return assigned;
  return `tone-${String(categoryHash(normalized) % CATEGORY_TONE_COUNT)}`;
}

export function categoryToneMap(values: readonly string[]): ReadonlyMap<string, string> {
  const categories = [...new Set(values.map(categoryKey).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const assignments = new Map<string, string>();
  const occupied = new Set<number>();
  for (const category of categories) {
    const preferred = categoryHash(category) % CATEGORY_TONE_COUNT;
    let tone = preferred;
    for (let offset = 0; offset < CATEGORY_TONE_COUNT; offset += 1) {
      const candidate = (preferred + offset) % CATEGORY_TONE_COUNT;
      if (!occupied.has(candidate)) {
        tone = candidate;
        occupied.add(candidate);
        break;
      }
    }
    assignments.set(category, `tone-${String(tone)}`);
  }
  return assignments;
}

function categoryKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function categoryHash(value: string): number {
  let hash = 0;
  for (const character of value) hash = Math.imul(31, hash) + character.charCodeAt(0) | 0;
  return Math.abs(hash);
}

export function fileTitle(path: string): string {
  return path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;
}

export function findFieldKey(frontmatter: Record<string, unknown>, name: string): string | null {
  if (Object.hasOwn(frontmatter, name)) return name;
  const wanted = name.toLocaleLowerCase();
  return Object.keys(frontmatter).find((candidate) => candidate.toLocaleLowerCase() === wanted) ?? null;
}

export function readField(frontmatter: Record<string, unknown>, name: string): unknown {
  const key = findFieldKey(frontmatter, name);
  return key ? frontmatter[key] : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertyName(value: unknown, fallback: string): string {
  return stringValue(value).trim() || fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
