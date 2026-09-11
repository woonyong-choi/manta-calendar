import { describe, expect, it } from "vitest";

import {
  GoogleCalendarClient,
  type GoogleHttpRequest,
  type GoogleHttpResponse,
  syncGoogleCalendar,
  toGoogleEventPayload,
} from "../src/google-calendar";
import type { CalendarEvent, GoogleCalendarTarget, GoogleSyncRecord } from "../src/model";

const calendar: GoogleCalendarTarget = {
  id: "work@example.com",
  name: "Work",
  timeZone: "Asia/Seoul",
};

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    allDay: false,
    category: "Work",
    editable: false,
    endDate: "2026-09-15",
    endTime: "15:00",
    filePath: "Calendar/Design review.md",
    id: "profile:Calendar/Design review.md",
    kind: "event",
    origin: "profile",
    profileId: "profile",
    sources: [{ excerpt: "Frontmatter", filePath: "Calendar/Design review.md", line: 0 }],
    startDate: "2026-09-15",
    startTime: "14:00",
    title: "Design review",
    ...overrides,
  };
}

function client(handler: (request: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>) {
  return new GoogleCalendarClient(async (request) => handler(request), async () => "access-token");
}

describe("Google event projection", () => {
  it("uses exclusive Google end dates for all-day ranges", () => {
    const payload = toGoogleEventPayload(
      event({ allDay: true, endDate: "2026-09-17", endTime: "", startTime: "" }),
      "Asia/Seoul",
      60,
      "installation",
      "owner",
    );
    expect(payload.start).toEqual({ date: "2026-09-15" });
    expect(payload.end).toEqual({ date: "2026-09-18" });
    expect(payload.reminders).toEqual({ useDefault: true });
  });

  it("keeps authored wall-clock time and applies a bounded default duration", () => {
    const payload = toGoogleEventPayload(
      event({ endTime: "", startDate: "2026-09-15", startTime: "23:30" }),
      "Asia/Seoul",
      60,
      "installation",
      "owner",
    );
    expect(payload.start).toEqual({ dateTime: "2026-09-15T23:30:00", timeZone: "Asia/Seoul" });
    expect(payload.end).toEqual({ dateTime: "2026-09-16T00:30:00", timeZone: "Asia/Seoul" });
  });

  it("rejects a timed range whose end does not follow its start", () => {
    expect(() => toGoogleEventPayload(
      event({ endTime: "13:00", startTime: "14:00" }),
      "Asia/Seoul",
      60,
      "installation",
      "owner",
    )).toThrow("End time");
  });
});

describe("Google Calendar API boundary", () => {
  it("creates one dedicated app calendar without listing existing calendars", async () => {
    const requests: GoogleHttpRequest[] = [];
    const api = client((request) => {
      requests.push(request);
      return {
        json: { id: "app-calendar", summary: "Link Calendar", timeZone: "Asia/Seoul" },
        status: 200,
      };
    });

    await expect(api.ensureAppCalendar(null, "Link Calendar", "Asia/Seoul")).resolves.toEqual({
      id: "app-calendar",
      name: "Link Calendar",
      timeZone: "Asia/Seoul",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", url: "https://www.googleapis.com/calendar/v3/calendars" });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      summary: "Link Calendar",
      timeZone: "Asia/Seoul",
    });
  });

  it("reuses an existing app calendar and surfaces bounded Google API errors", async () => {
    const existing = client(() => ({
      json: { id: "app-calendar", summary: "Renamed by user", timeZone: "Europe/Paris" },
      status: 200,
    }));
    await expect(existing.ensureAppCalendar(calendar, "Link Calendar", "UTC")).resolves.toMatchObject({
      id: "app-calendar",
      name: "Renamed by user",
      timeZone: "Europe/Paris",
    });

    const api = client(() => ({
      json: { error: { message: "Calendar access was revoked" } },
      status: 403,
    }));
    await expect(api.ensureAppCalendar(calendar, "Link Calendar", "UTC"))
      .rejects.toThrow("Calendar access was revoked");
  });

  it("preserves an unavailable dedicated calendar until replacement is explicitly requested", async () => {
    const requests: GoogleHttpRequest[] = [];
    const api = client((request) => {
      requests.push(request);
      return { json: { error: { message: "not found" } }, status: 404 };
    });
    await expect(api.ensureAppCalendar(calendar, "Link Calendar", "UTC"))
      .rejects.toThrow("unavailable to this account");
    expect(requests.map((request) => request.method ?? "GET")).toEqual(["GET"]);
  });

  it("creates an empty replacement only after an explicit request and a 404", async () => {
    const requests: GoogleHttpRequest[] = [];
    const replacement = { id: "new-calendar", name: "Link Calendar", timeZone: "Asia/Seoul" };
    const api = client((request) => {
      requests.push(request);
      return request.url.endsWith(encodeURIComponent(calendar.id))
        ? { json: { error: { message: "not found" } }, status: 404 }
        : { json: { ...replacement, summary: replacement.name }, status: 200 };
    });
    await expect(api.ensureAppCalendar(calendar, "Link Calendar", "Asia/Seoul", true)).resolves.toEqual(replacement);
    await expect(api.ensureAppCalendar(replacement, "Link Calendar", "Asia/Seoul", true)).resolves.toEqual(replacement);
    expect(requests.map(request => request.method ?? "GET")).toEqual(["GET", "POST", "GET"]);
    expect(requests.every(request => !request.url.includes("/events"))).toBe(true);
  });

  it.each([401, 403, 429, 500])("does not replace a calendar on HTTP %s", async (status) => {
    const requests: GoogleHttpRequest[] = [];
    const api = client(request => {
      requests.push(request);
      return { json: { error: { message: "unavailable" } }, status };
    });
    await expect(api.ensureAppCalendar(calendar, "Link Calendar", "UTC", true)).rejects.toThrow("unavailable");
    expect(requests.map(request => request.method ?? "GET")).toEqual(["GET"]);
  });
});

describe("one-way Google synchronization", () => {
  it("keeps old calendar mappings and sends only allowed notes to a new calendar", async () => {
    const records: GoogleSyncRecord[] = Array.from({ length: 7 }, (_, index) => ({
      calendarId: "old-calendar", etag: `etag-${String(index)}`, eventId: `remote-${String(index)}`,
      fingerprint: "old", localKey: `profile\u0000Calendar/${String(index)}.md`,
    }));
    const original = structuredClone(records);
    const requests: GoogleHttpRequest[] = [];
    const result = await syncGoogleCalendar({
      calendar, defaultDurationMinutes: 60, installationId: "installation", records, sourceProfileIds: ["profile"],
      client: client(request => {
        requests.push(request);
        return { json: { etag: "new-etag", id: "new-event" }, status: 200 };
      }),
      events: [event({ filePath: "Calendar/0.md" }), event({ filePath: "Calendar/Private.md", externalSync: "deny" })],
    });
    expect(result).toMatchObject({ created: 1, updated: 0, syncDenied: 1 });
    expect(result.records.slice(0, 7)).toEqual(original);
    expect(records).toEqual(original);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain(encodeURIComponent(calendar.id));
    expect(requests[0]?.body).not.toContain("Private");
  });

  it("honors explicit sync denial while allowing selected read-only local notes", async () => {
    const requests: GoogleHttpRequest[] = [];
    const api = client((request) => {
      requests.push(request);
      return { json: { etag: "etag-1", id: "remote-id" }, status: 200 };
    });
    const restricted = { ...event({ filePath: "Calendar/Private.md" }), externalSync: "deny" };
    const existing: GoogleSyncRecord = {
      calendarId: calendar.id, etag: "private-etag", eventId: "private-remote",
      fingerprint: "old", localKey: "profile\u0000Calendar/Private.md",
    };
    const input = {
      calendar, client: api, defaultDurationMinutes: 60, events: [{ ...event(), access: "local-only" }, restricted],
      installationId: "installation", records: [existing], sourceProfileIds: ["profile"],
    };
    const first = await syncGoogleCalendar(input);
    expect(first).toMatchObject({ created: 1, syncDenied: 1 });
    expect(first.records[0]).toEqual(existing);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).not.toContain("Private");
    const second = await syncGoogleCalendar({ ...input, records: first.records });
    expect(second).toMatchObject({ created: 0, skipped: 1, syncDenied: 1 });
    expect(second.records).toEqual(first.records);
    expect(requests).toHaveLength(1);
  });

  it("creates once, keeps a local mapping, and skips an unchanged repeat", async () => {
    const requests: GoogleHttpRequest[] = [];
    const api = client((request) => {
      requests.push(request);
      return { json: { etag: "etag-1", id: "remote-id" }, status: 200 };
    });
    const first = await syncGoogleCalendar({
      calendar,
      client: api,
      defaultDurationMinutes: 60,
      events: [event(), event({ filePath: "Body.md", origin: "body" })],
      installationId: "installation",
      records: [],
      sourceProfileIds: ["profile"],
    });
    expect(first).toMatchObject({ created: 1, skipped: 0, updated: 0 });
    expect(first.records).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers?.Authorization).toBe("Bearer access-token");

    const second = await syncGoogleCalendar({
      calendar,
      client: api,
      defaultDurationMinutes: 60,
      events: [event()],
      installationId: "installation",
      records: first.records,
      sourceProfileIds: ["profile"],
    });
    expect(second).toMatchObject({ created: 0, skipped: 1, updated: 0 });
    expect(requests).toHaveLength(1);
  });

  it("updates only owned fields when the remote ETag is unchanged", async () => {
    const requests: GoogleHttpRequest[] = [];
    const api = client((request) => {
      requests.push(request);
      if (request.method === "PUT") return { json: { etag: "etag-2", id: "remote-id" }, status: 200 };
      return {
        json: {
          description: "Keep this Google-side note",
          etag: "etag-1",
          id: "remote-id",
          reminders: { overrides: [{ method: "popup", minutes: 5 }], useDefault: false },
        },
        status: 200,
      };
    });
    const records: GoogleSyncRecord[] = [{
      calendarId: calendar.id,
      etag: "etag-1",
      eventId: "remote-id",
      fingerprint: "old",
      localKey: "profile\u0000Calendar/Design review.md",
    }];
    const result = await syncGoogleCalendar({
      calendar,
      client: api,
      defaultDurationMinutes: 60,
      events: [event({ title: "Updated design review" })],
      installationId: "installation",
      records,
      sourceProfileIds: ["profile"],
    });
    expect(result).toMatchObject({ conflicts: [], updated: 1 });
    const update = requests.find((request) => request.method === "PUT");
    expect(update?.headers?.["If-Match"]).toBe("etag-1");
    expect(JSON.parse(update?.body ?? "{}")).toMatchObject({
      description: "Keep this Google-side note",
      reminders: { overrides: [{ method: "popup", minutes: 5 }], useDefault: false },
      summary: "Updated design review",
    });
  });

  it("stops instead of overwriting a Google-side change", async () => {
    const api = client(() => ({ json: { etag: "remote-new", id: "remote-id" }, status: 200 }));
    const result = await syncGoogleCalendar({
      calendar,
      client: api,
      defaultDurationMinutes: 60,
      events: [event({ title: "Local change" })],
      installationId: "installation",
      records: [{
        calendarId: calendar.id,
        etag: "previous",
        eventId: "remote-id",
        fingerprint: "old",
        localKey: "profile\u0000Calendar/Design review.md",
      }],
      sourceProfileIds: ["profile"],
    });
    expect(result.updated).toBe(0);
    expect(result.conflicts).toEqual([{
      localKey: "profile\u0000Calendar/Design review.md",
      reason: "The Google event changed after the previous sync.",
    }]);
  });

  it("never treats a missing local note as permission to delete remotely", async () => {
    const record: GoogleSyncRecord = {
      calendarId: calendar.id,
      etag: "etag",
      eventId: "remote-id",
      fingerprint: "fingerprint",
      localKey: "profile\u0000Calendar/Removed.md",
    };
    const result = await syncGoogleCalendar({
      calendar,
      client: client(() => { throw new Error("network should not be called"); }),
      defaultDurationMinutes: 60,
      events: [],
      installationId: "installation",
      records: [record],
      sourceProfileIds: ["profile"],
    });
    expect(result.records).toEqual([record]);
    expect(result).toMatchObject({ created: 0, failed: [], skipped: 0, updated: 0 });
  });

  it("adopts a deterministic event only when its ownership marker matches", async () => {
    let insertedPayload: Record<string, unknown> | undefined;
    const api = client((request) => {
      if (request.method === "POST") {
        const parsed: unknown = JSON.parse(request.body ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("expected an object payload");
        }
        insertedPayload = parsed as Record<string, unknown>;
        return { json: { error: { message: "duplicate" } }, status: 409 };
      }
      const marker = (insertedPayload?.extendedProperties as {
        private?: { linkCalendarKey?: string };
      } | undefined)?.private?.linkCalendarKey;
      return {
        json: {
          etag: "etag-existing",
          extendedProperties: { private: { linkCalendarKey: marker } },
          id: insertedPayload?.id,
        },
        status: 200,
      };
    });
    const result = await syncGoogleCalendar({
      calendar,
      client: api,
      defaultDurationMinutes: 60,
      events: [event()],
      installationId: "installation",
      records: [],
      sourceProfileIds: ["profile"],
    });
    expect(result).toMatchObject({ conflicts: [], created: 1, failed: [] });
    expect(result.records[0]?.eventId).toBe(insertedPayload?.id);
  });

  it("does not adopt a colliding deterministic event owned elsewhere", async () => {
    const api = client((request) => request.method === "POST"
      ? { json: { error: { message: "duplicate" } }, status: 409 }
      : {
          json: {
            etag: "etag-existing",
            extendedProperties: { private: { linkCalendarKey: "someone-else" } },
            id: "collision",
          },
          status: 200,
        });
    const result = await syncGoogleCalendar({
      calendar,
      client: api,
      defaultDurationMinutes: 60,
      events: [event()],
      installationId: "installation",
      records: [],
      sourceProfileIds: ["profile"],
    });
    expect(result.created).toBe(0);
    expect(result.conflicts[0]?.reason).toContain("owned by another event");
  });

  it("isolates an event validation failure and continues the remaining batch", async () => {
    let inserts = 0;
    const api = client((request) => {
      if (request.method === "POST" && inserts++ === 0) {
        return { json: { error: { message: "invalid event" } }, status: 400 };
      }
      return { json: { etag: "etag", id: `remote-${String(inserts)}` }, status: 200 };
    });
    const result = await syncGoogleCalendar({
      calendar,
      client: api,
      defaultDurationMinutes: 60,
      events: [event(), event({ filePath: "Calendar/Second.md", id: "second" })],
      installationId: "installation",
      records: [],
      sourceProfileIds: ["profile"],
    });
    expect(result.created).toBe(1);
    expect(result.failed).toEqual([{
      localKey: "profile\u0000Calendar/Design review.md",
      reason: "invalid event",
    }]);
  });

  it("stops a batch after a quota failure instead of repeating doomed requests", async () => {
    let requests = 0;
    const result = await syncGoogleCalendar({
      calendar,
      client: client(() => {
        requests += 1;
        return { json: { error: { message: "quota exceeded" } }, status: 429 };
      }),
      defaultDurationMinutes: 60,
      events: [event(), event({ filePath: "Calendar/Second.md", id: "second" })],
      installationId: "installation",
      records: [],
      sourceProfileIds: ["profile"],
    });
    expect(requests).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toBe("quota exceeded");
  });

  it("reports delete and update races as conflicts", async () => {
    const record: GoogleSyncRecord = {
      calendarId: calendar.id,
      etag: "etag-1",
      eventId: "remote-id",
      fingerprint: "old",
      localKey: "profile\u0000Calendar/Design review.md",
    };
    const missing = await syncGoogleCalendar({
      calendar,
      client: client(() => ({ json: { error: { message: "gone" } }, status: 404 })),
      defaultDurationMinutes: 60,
      events: [event({ title: "Changed" })],
      installationId: "installation",
      records: [record],
      sourceProfileIds: ["profile"],
    });
    expect(missing.conflicts[0]?.reason).toContain("no longer exists");

    const racing = await syncGoogleCalendar({
      calendar,
      client: client((request) => request.method === "PUT"
        ? { json: { error: { message: "precondition" } }, status: 412 }
        : { json: { etag: "etag-1", id: "remote-id" }, status: 200 }),
      defaultDurationMinutes: 60,
      events: [event({ title: "Changed" })],
      installationId: "installation",
      records: [record],
      sourceProfileIds: ["profile"],
    });
    expect(racing.conflicts[0]?.reason).toContain("during synchronization");
  });

  it("refuses to persist a mapping when Google omits the ETag", async () => {
    const result = await syncGoogleCalendar({
      calendar,
      client: client(() => ({ json: { id: "remote-without-etag" }, status: 200 })),
      defaultDurationMinutes: 60,
      events: [event()],
      installationId: "installation",
      records: [],
      sourceProfileIds: ["profile"],
    });
    expect(result.created).toBe(0);
    expect(result.records).toEqual([]);
    expect(result.failed[0]?.reason).toContain("ETag is missing");
  });
});
