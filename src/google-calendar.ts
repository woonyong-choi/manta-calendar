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

interface GoogleEventResource {
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
}): Promise<GoogleSyncResult> {
  const sourceIds = new Set(input.sourceProfileIds);
  const selected = input.events.filter((event) => event.origin === "profile" && sourceIds.has(event.profileId));
  const events = selected.filter((event) => event.externalSync !== "deny");
  const records = input.records.map((record) => ({ ...record }));
  const byKey = new Map(records.map((record, index) => [recordKey(record.localKey, record.calendarId), index]));
  const result: GoogleSyncResult = {
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
      if (record?.fingerprint === fingerprint) {
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
      if (record.etag && stringValue(remote.etag) !== record.etag) {
        result.conflicts.push({ localKey, reason: "The Google event changed after the previous sync." });
        continue;
      }
      let updated: GoogleEventResource;
      try {
        updated = await input.client.updateEvent(
          input.calendar.id,
          record.eventId,
          mergeOwnedFields(remote, payload),
          record.etag,
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
  return result;
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
