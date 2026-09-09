import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient, fromGoogleEvent, syncGoogleCalendar, type GoogleHttpRequest, type GoogleIncomingFields } from "../src/google-calendar";
import type { CalendarEvent } from "../src/model";

const event: CalendarEvent = {
  allDay: true, category: "", editable: true, endDate: "2026-09-09", endTime: "",
  filePath: "Calendar/Meeting.md", id: "meeting", kind: "event", origin: "profile",
  profileId: "calendar", sources: [], startDate: "2026-09-09", startTime: "", title: "Meeting",
};
const calendar = { id: "dedicated", name: "Link Calendar", timeZone: "Asia/Seoul" };

function fixture() {
  const requests: GoogleHttpRequest[] = [];
  let remote: Record<string, unknown> = {};
  const client = new GoogleCalendarClient(async (request) => {
    requests.push(request);
    if (request.method === "POST" || request.method === "PUT") {
      remote = { ...JSON.parse(request.body ?? "{}") as Record<string, unknown>, id: "google-event", etag: "original" };
    }
    return { status: 200, json: request.url.includes("?") ? { items: [] } : remote };
  }, async () => "token");
  const input = { calendar, client, defaultDurationMinutes: 60, events: [event], installationId: "install", records: [], sourceProfileIds: ["calendar"] };
  return { input, requests, changeRemote: (changes: Record<string, unknown>) => { Object.assign(remote, changes); } };
}

describe("two-way synchronization", () => {
  it("preserves the exact Google instant when only the title changes across a DST fold", async () => {
    const f = fixture();
    f.input.calendar = { ...calendar, timeZone: "America/New_York" };
    const timed = { ...event, allDay: false, startDate: "2026-11-01", endDate: "2026-11-01", startTime: "01:30", endTime: "02:30" };
    f.input.events = [timed];
    const first = await syncGoogleCalendar(f.input);
    f.changeRemote({ start: { dateTime: "2026-11-01T01:30:00-05:00" }, end: { dateTime: "2026-11-01T02:30:00-05:00" } });
    await syncGoogleCalendar({ ...f.input, events: [{ ...timed, title: "New title" }], records: first.records, incoming: { apply: vi.fn() } });
    const body = JSON.parse(f.requests.find(r => r.method === "PUT")?.body ?? "{}") as { start?: { dateTime?: string } };
    expect(body.start?.dateTime).toBe("2026-11-01T01:30:00-05:00");
  });
  it("imports Google-created events once across paginated lists", async () => {
    const urls: string[] = [];
    const remote = { id: "new-google", etag: "one", summary: "Google created", start: { date: "2026-09-09" }, end: { date: "2026-09-10" } };
    const client = new GoogleCalendarClient(async request => {
      urls.push(request.url);
      if (request.url.includes("pageToken=next")) return { status: 200, json: { items: [remote] } };
      return { status: 200, json: { items: [], nextPageToken: "next" } };
    }, async () => "token");
    const apply = vi.fn(async (changes: GoogleIncomingFields) => ({ ...event, ...changes }));
    const result = await syncGoogleCalendar({ calendar, client, events: [], records: [], defaultDurationMinutes: 60, installationId: "install", sourceProfileIds: ["calendar"], incoming: { apply, importNew: true } });
    expect(result.received).toBe(1);
    expect(result.records[0]?.eventId).toBe("new-google");
    expect(apply).toHaveBeenCalledOnce();
    expect(urls).toHaveLength(2);
  });

  it("normalizes offset times into the calendar zone and exclusive all-day ends", () => {
    expect(fromGoogleEvent({ summary: "Evening", start: { dateTime: "2026-09-09T16:00:00Z" }, end: { dateTime: "2026-09-09T17:00:00Z" } }, "Asia/Seoul")).toEqual({ title: "Evening", startDate: "2026-09-10", endDate: "2026-09-10", startTime: "01:00", endTime: "02:00", allDay: false });
    expect(fromGoogleEvent({ summary: "Trip", start: { date: "2026-09-09" }, end: { date: "2026-09-12" } }, "UTC").endDate).toBe("2026-09-11");
    expect(() => fromGoogleEvent({ recurrence: ["RRULE:FREQ=DAILY"] }, "UTC")).toThrow("Recurring");
  });

  it("preserves a remote cancellation and rejects malformed responses", async () => {
    const f = fixture();
    const first = await syncGoogleCalendar(f.input);
    f.changeRemote({ status: "cancelled", etag: "deleted" });
    const apply = vi.fn();
    const result = await syncGoogleCalendar({ ...f.input, records: first.records, incoming: { apply } });
    expect(result.conflicts[0]?.reason).toContain("deleted");
    expect(apply).not.toHaveBeenCalled();
    expect(result.records).toEqual(first.records);
    expect(() => fromGoogleEvent({ start: { date: "2026-02-30" }, end: { date: "2026-03-01" } }, "UTC")).toThrow("Invalid");
  });

  it("imports a Google edit even when the local note has not changed", async () => {
    const f = fixture();
    const first = await syncGoogleCalendar(f.input);
    f.changeRemote({ summary: "Google edit", etag: "remote-edit" });
    const apply = vi.fn(async (changes: GoogleIncomingFields) => ({ ...event, ...changes }));
    const result = await syncGoogleCalendar({ ...f.input, records: first.records, incoming: { apply } });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ title: "Google edit" }), expect.objectContaining({ id: "google-event" }), event);
    expect(result.received).toBe(1);
    expect(f.requests.filter(r => r.method === "PUT")).toHaveLength(0);
    expect(result.records[0]?.etag).toBe("remote-edit");
  });

  it("preserves both sides when Google and the note changed", async () => {
    const f = fixture();
    const first = await syncGoogleCalendar(f.input);
    f.changeRemote({ summary: "Google edit", etag: "remote-edit" });
    const apply = vi.fn();
    const result = await syncGoogleCalendar({ ...f.input, events: [{ ...event, title: "Local edit" }], records: first.records, incoming: { apply } });
    expect(result.conflicts).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
    expect(f.requests.filter(r => r.method === "PUT")).toHaveLength(0);
    expect(result.records).toEqual(first.records);
  });

  it("does not advance the baseline when a local write fails", async () => {
    const f = fixture();
    const first = await syncGoogleCalendar(f.input);
    f.changeRemote({ summary: "Google edit", etag: "remote-edit" });
    const result = await syncGoogleCalendar({ ...f.input, records: first.records, incoming: { apply: async () => { throw Error("Note changed during sync"); } } });
    expect(result.failed).toHaveLength(1);
    expect(result.records).toEqual(first.records);
  });
});
