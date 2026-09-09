import { addDays, type CalendarEvent, type GoogleCalendarTarget, type GoogleSyncRecord } from "./model";

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export interface GoogleHttpRequest {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  url: string;
}

export interface GoogleHttpResponse {
  json: unknown;
  status: number;
}

export type GoogleHttpClient = (request: GoogleHttpRequest) => Promise<GoogleHttpResponse>;

interface GoogleEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEventResource {
  end?: GoogleEventDateTime;
  etag?: string;
  extendedProperties?: { private?: Record<string, string> };
  id?: string;
  start?: GoogleEventDateTime;
  summary?: string;
  [key: string]: unknown;
}

export interface GoogleEventPayload {
  end: GoogleEventDateTime;
  extendedProperties: { private: Record<string, string> };
  id?: string;
  reminders: { useDefault: true };
  start: GoogleEventDateTime;
  summary: string;
}

export interface GoogleSyncResult {
  received: number;
  syncDenied: number;
  conflicts: { localKey: string; reason: string }[];
  created: number;
  failed: { localKey: string; reason: string }[];
  records: GoogleSyncRecord[];
  skipped: number;
  updated: number;
}

class GoogleApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class GoogleCalendarClient {
  constructor(
    private readonly http: GoogleHttpClient,
    private readonly accessToken: () => Promise<string>,
  ) {}

  async ensureAppCalendar(
    current: GoogleCalendarTarget | null,
    name: string,
    timeZone: string,
  ): Promise<GoogleCalendarTarget> {
    if (current) {
      try {
        const response = await this.request({
          url: `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(current.id)}`,
        });
        return calendarTarget(response.json, current);
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 404) {
          throw new GoogleApiError(
            404,
            "The dedicated Google calendar no longer exists. Disconnect and connect again to create a new one.",
          );
        }
        throw error;
      }
    }
    const response = await this.request({
      body: JSON.stringify({ summary: name, timeZone }),
      method: "POST",
      url: `${GOOGLE_CALENDAR_API}/calendars`,
    });
    return calendarTarget(response.json, {
      id: "",
      name,
      timeZone,
    });
  }

  async getEvent(calendarId: string, eventId: string): Promise<GoogleEventResource> {
    const response = await this.request({
      url: `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    });
    return recordValue(response.json);
  }

  async listEvents(calendarId: string): Promise<GoogleEventResource[]> {
    const events: GoogleEventResource[] = [];
    const seen = new Set<string>();
    let pageToken = "";
    do {
      const query = new URLSearchParams({ maxResults: "250", showDeleted: "true", singleEvents: "false" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.request({ url: `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${query}` });
      const page = recordValue(response.json);
      if (!Array.isArray(page.items)) throw new Error("Google returned an invalid event list.");
      events.push(...page.items.map(recordValue));
      pageToken = stringValue(page.nextPageToken);
      if (events.length > 10_000 || (pageToken && seen.has(pageToken)) || seen.size >= 100) {
        throw new Error("Google event list exceeded the safe synchronization limit.");
      }
      seen.add(pageToken);
    } while (pageToken);
    return events;
  }

  async insertEvent(calendarId: string, payload: GoogleEventPayload): Promise<GoogleEventResource> {
    const response = await this.request({
      body: JSON.stringify(payload),
      method: "POST",
      url: `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
    });
    return recordValue(response.json);
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    payload: GoogleEventResource,
    etag: string,
  ): Promise<GoogleEventResource> {
    if (!etag) throw new GoogleApiError(409, "Google event ETag is missing; update stopped.");
    const response = await this.request({
      body: JSON.stringify(payload),
      headers: { "If-Match": etag },
      method: "PUT",
      url: `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    });
    return recordValue(response.json);
  }

  private async request(input: GoogleHttpRequest): Promise<GoogleHttpResponse> {
    const token = await this.accessToken();
    if (!token) throw new GoogleApiError(401, "Google Calendar is not connected.");
    const response = await this.http({
      ...input,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(input.body ? { "Content-Type": "application/json" } : {}),
        ...input.headers,
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new GoogleApiError(response.status, googleErrorMessage(response.json, response.status));
    }
    return response;
  }
}

export async function syncGoogleCalendar(input: {
  calendar: GoogleCalendarTarget;
  client: GoogleCalendarClient;
  defaultDurationMinutes: number;
  events: readonly CalendarEvent[];
  installationId: string;
  records: readonly GoogleSyncRecord[];
  sourceProfileIds: readonly string[];
  incoming?: {
    apply: (changes: GoogleIncomingFields, remote: GoogleEventResource, current?: CalendarEvent) => Promise<CalendarEvent>;
    importNew?: boolean;
  };
}): Promise<GoogleSyncResult> {
  const sourceIds = new Set(input.sourceProfileIds);
  const selected = input.events.filter((event) => event.origin === "profile" && sourceIds.has(event.profileId));
  const events = selected.filter((event) => event.externalSync !== "deny");
  const records = input.records.map((record) => ({ ...record }));
  const byKey = new Map(records.map((record, index) => [recordKey(record.localKey, record.calendarId), index]));
  const result: GoogleSyncResult = {
    received: 0,
    syncDenied: selected.length - events.length,
    conflicts: [],
    created: 0,
    failed: [],
    records,
    skipped: 0,
    updated: 0,
  };

  for (const event of events) {
    const localKey = googleLocalKey(event);
    try {
      const ownershipKey = await sha256Base32(localKey);
      const payload = toGoogleEventPayload(
        event,
        input.calendar.timeZone,
        input.defaultDurationMinutes,
        input.installationId,
        ownershipKey,
      );
      const fingerprint = await sha256Base32(JSON.stringify(payload));
      const key = recordKey(localKey, input.calendar.id);
      const recordIndex = byKey.get(key);
      const record = recordIndex === undefined ? undefined : records[recordIndex];
      if (!input.incoming && record?.fingerprint === fingerprint) {
        result.skipped += 1;
        continue;
      }

      if (!record) {
        const eventId = (await sha256Base32(`${input.installationId}\u0000${localKey}`)).slice(0, 32);
        let remote: GoogleEventResource;
        try {
          remote = await input.client.insertEvent(input.calendar.id, { ...payload, id: eventId });
        } catch (error) {
          if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
          remote = await input.client.getEvent(input.calendar.id, eventId);
          if (remote.extendedProperties?.private?.linkCalendarKey !== ownershipKey) {
            result.conflicts.push({ localKey, reason: "Google event ID is already owned by another event." });
            continue;
          }
        }
        const next = toSyncRecord(localKey, input.calendar.id, eventId, fingerprint, remote);
        byKey.set(key, records.length);
        records.push(next);
        result.created += 1;
        continue;
      }
      if (recordIndex === undefined) throw new Error("Google synchronization record is inconsistent.");

      let remote: GoogleEventResource;
      try {
        remote = await input.client.getEvent(input.calendar.id, record.eventId);
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 404) {
          result.conflicts.push({ localKey, reason: "The mapped Google event no longer exists." });
          continue;
        }
        throw error;
      }
      if (input.incoming) {
        if (!stringValue(remote.etag)) throw new Error("Google event ETag is missing.");
        if (remote.status === "cancelled") {
          result.conflicts.push({ localKey, reason: "The Google event was deleted. The local note was preserved." });
          continue;
        }
        const changes = fromGoogleEvent(remote, input.calendar.timeZone);
        const projectedRemote = toGoogleEventPayload(
          { ...event, ...changes }, input.calendar.timeZone, input.defaultDurationMinutes, input.installationId, ownershipKey,
        );
        const remoteFingerprint = await sha256Base32(JSON.stringify(projectedRemote));
        // A title-only edit must not reinterpret an ambiguous daylight-saving time.
        if (JSON.stringify(projectedRemote.start) === JSON.stringify(payload.start) && remote.start) payload.start = remote.start;
        if (JSON.stringify(projectedRemote.end) === JSON.stringify(payload.end) && remote.end) payload.end = remote.end;
        const localChanged = fingerprint !== record.fingerprint;
        const remoteChanged = remoteFingerprint !== record.fingerprint;
        if (localChanged && remoteChanged && fingerprint !== remoteFingerprint) {
          result.conflicts.push({ localKey, reason: "Both Google and the note changed. Both versions were preserved." });
          continue;
        }
        if (remoteChanged && !localChanged) {
          const applied = await input.incoming.apply(changes, remote, event);
          const appliedFingerprint = await sha256Base32(JSON.stringify(toGoogleEventPayload(
            applied, input.calendar.timeZone, input.defaultDurationMinutes, input.installationId, ownershipKey,
          )));
          records[recordIndex] = toSyncRecord(localKey, input.calendar.id, record.eventId, appliedFingerprint, remote);
          result.received += 1;
          continue;
        }
        if (!localChanged || fingerprint === remoteFingerprint) {
          records[recordIndex] = toSyncRecord(localKey, input.calendar.id, record.eventId, fingerprint, remote);
          result.skipped += 1;
          continue;
        }
      }
      if (!input.incoming && record.etag && stringValue(remote.etag) !== record.etag) {
        result.conflicts.push({ localKey, reason: "The Google event changed after the previous sync." });
        continue;
      }
      let updated: GoogleEventResource;
      try {
        updated = await input.client.updateEvent(
          input.calendar.id,
          record.eventId,
          mergeOwnedFields(remote, payload),
          input.incoming ? stringValue(remote.etag) : record.etag,
        );
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 412) {
          result.conflicts.push({ localKey, reason: "The Google event changed during synchronization." });
          continue;
        }
        throw error;
      }
      records[recordIndex] = toSyncRecord(
        localKey,
        input.calendar.id,
        record.eventId,
        fingerprint,
        updated,
      );
      result.updated += 1;
    } catch (error) {
      result.failed.push({
        localKey,
        reason: error instanceof Error ? error.message : "Unknown Google Calendar error.",
      });
      if (error instanceof GoogleApiError
        && (error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500)) {
        break;
      }
    }
  }
  if (input.incoming?.importNew && result.failed.length === 0) {
    const localKeys = new Set(selected.map(googleLocalKey));
    for (const record of records) {
      if (record.calendarId === input.calendar.id && sourceIds.has(record.localKey.split("\u0000")[0] ?? "") && !localKeys.has(record.localKey)) {
        result.conflicts.push({ localKey: record.localKey, reason: "A mapped note is missing or no longer a valid event. Google was preserved." });
      }
    }
    const known = new Set(records.filter(record => record.calendarId === input.calendar.id).map(record => record.eventId));
    try {
      const remoteEvents = await input.client.listEvents(input.calendar.id);
      for (const remote of remoteEvents) {
        const id = stringValue(remote.id);
        if (!id || known.has(id) || remote.status === "cancelled") continue;
        if (remote.extendedProperties?.private?.linkCalendarInstallation) {
          result.conflicts.push({ localKey: id, reason: "An existing plugin-owned event has no active local mapping. It was preserved." });
          continue;
        }
        try {
          if (!stringValue(remote.etag)) throw new Error("Google event ETag is missing.");
          const applied = await input.incoming.apply(fromGoogleEvent(remote, input.calendar.timeZone), remote);
          const localKey = googleLocalKey(applied);
          const fingerprint = await sha256Base32(JSON.stringify(toGoogleEventPayload(
            applied, input.calendar.timeZone, input.defaultDurationMinutes, input.installationId, await sha256Base32(localKey),
          )));
          records.push(toSyncRecord(localKey, input.calendar.id, id, fingerprint, remote));
          known.add(id);
          result.received += 1;
        } catch (error) {
          result.failed.push({ localKey: id, reason: error instanceof Error ? error.message : "Google import failed." });
        }
      }
    } catch (error) {
      result.failed.push({ localKey: "calendar", reason: error instanceof Error ? error.message : "Google event listing failed." });
    }
  }
  return result;
}

export type GoogleIncomingFields = Pick<CalendarEvent, "title" | "startDate" | "endDate" | "startTime" | "endTime" | "allDay">;

export function fromGoogleEvent(remote: GoogleEventResource, timeZone: string): GoogleIncomingFields {
  if (remote.recurrence || remote.recurringEventId || remote.eventType && remote.eventType !== "default") {
    throw new Error("Recurring or special Google events are preserved but cannot be imported yet.");
  }
  if (remote.status === "cancelled") throw new Error("Deleted Google events cannot be imported.");
  const title = stringValue(remote.summary).trim() || "Untitled event";
  if (remote.start?.date && remote.end?.date) {
    const startDate = validDate(remote.start.date);
    const exclusiveEnd = validDate(remote.end.date);
    if (exclusiveEnd <= startDate) throw new Error("Invalid Google all-day range.");
    return { title, startDate, endDate: addDays(exclusiveEnd, -1), startTime: "", endTime: "", allDay: true };
  }
  const start = googleClock(remote.start?.dateTime, timeZone);
  const end = googleClock(remote.end?.dateTime, timeZone);
  if (end.instant <= start.instant) throw new Error("Invalid Google event range.");
  return { title, startDate: start.date, endDate: end.date, startTime: start.time, endTime: end.time, allDay: false };
}

function validDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("Invalid Google date.");
  return value;
}

function googleClock(value: string | undefined, timeZone: string): { date: string; time: string; instant: number } {
  if (!value || !/T\d{2}:\d{2}:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("Google event time must include an offset and whole minutes.");
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error("Invalid Google time.");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return { date: `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`, time: `${parts.hour ?? ""}:${parts.minute ?? ""}`, instant };
}

function googleLocalKey(event: Pick<CalendarEvent, "filePath" | "profileId">): string {
  return `${event.profileId}\u0000${event.filePath}`;
}

export function toGoogleEventPayload(
  event: CalendarEvent,
  timeZone: string,
  defaultDurationMinutes: number,
  installationId: string,
  ownershipKey: string,
): GoogleEventPayload {
  const extendedProperties = {
    private: {
      linkCalendarInstallation: installationId,
      linkCalendarKey: ownershipKey,
      linkCalendarVersion: "1",
    },
  };
  const startTime = normalizeClock(event.startTime);
  if (event.allDay || !startTime) {
    return {
      end: { date: addDays(event.endDate, 1) },
      extendedProperties,
      reminders: { useDefault: true },
      start: { date: event.startDate },
      summary: event.title,
    };
  }
  const startDateTime = `${event.startDate}T${startTime}:00`;
  const endTime = normalizeClock(event.endTime);
  const endDateTime = endTime
    ? `${event.endDate}T${endTime}:00`
    : addWallClockMinutes(event.startDate, startTime, defaultDurationMinutes);
  if (endDateTime <= startDateTime) throw new Error("End time must be after start time.");
  return {
    end: { dateTime: endDateTime, timeZone },
    extendedProperties,
    reminders: { useDefault: true },
    start: { dateTime: startDateTime, timeZone },
    summary: event.title,
  };
}

function mergeOwnedFields(remote: GoogleEventResource, payload: GoogleEventPayload): GoogleEventResource {
  return {
    ...remote,
    end: payload.end,
    extendedProperties: {
      ...remote.extendedProperties,
      private: {
        ...remote.extendedProperties?.private,
        ...payload.extendedProperties.private,
      },
    },
    start: payload.start,
    summary: payload.summary,
  };
}

function toSyncRecord(
  localKey: string,
  calendarId: string,
  fallbackEventId: string,
  fingerprint: string,
  remote: GoogleEventResource,
): GoogleSyncRecord {
  const etag = stringValue(remote.etag);
  if (!etag) throw new GoogleApiError(502, "Google event ETag is missing; synchronization stopped.");
  return {
    calendarId,
    etag,
    eventId: stringValue(remote.id) || fallbackEventId,
    fingerprint,
    localKey,
  };
}

function recordKey(localKey: string, calendarId: string): string {
  return `${calendarId}\u0000${localKey}`;
}

function normalizeClock(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function addWallClockMinutes(date: string, time: string, minutes: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}T${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}:00`;
}

async function sha256Base32(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31] ?? "";
    }
  }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31] ?? "";
  return output;
}

function googleErrorMessage(value: unknown, status: number): string {
  const body = recordValue(value);
  const error = recordValue(body.error);
  return stringValue(error.message) || `Google Calendar request failed (${String(status)}).`;
}

function calendarTarget(value: unknown, fallback: GoogleCalendarTarget): GoogleCalendarTarget {
  const calendar = recordValue(value);
  const id = stringValue(calendar.id) || fallback.id;
  if (!id) throw new GoogleApiError(502, "Google returned an invalid calendar response.");
  return {
    id,
    name: stringValue(calendar.summary) || fallback.name || id,
    timeZone: stringValue(calendar.timeZone) || fallback.timeZone || "UTC",
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
