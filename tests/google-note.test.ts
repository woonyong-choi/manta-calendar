import { describe, expect, it } from "vitest";
import { googleNoteChanges } from "../src/google-note";
import { createProfile, type CalendarEvent } from "../src/model";

const fields = { title: "New title", allDay: true, startDate: "2026-09-09", endDate: "2026-09-10", startTime: "", endTime: "" };
describe("incoming note writes", () => {
  it("rejects read-only and externally denied notes before producing changes", () => {
    const profile = createProfile("Calendar");
    profile.editable = false;
    expect(() => googleNoteChanges(profile, fields, {})).toThrow("does not allow");
    profile.editable = true;
    expect(() => googleNoteChanges(profile, fields, { external_sync: "deny" })).toThrow("does not allow");
  });
  it("keeps unrelated properties and uses existing property casing", () => {
    const profile = createProfile("Calendar");
    profile.editable = true;
    const frontmatter = { Title: "Old", description: "My description", custom: 42 };
    const result = googleNoteChanges(profile, fields, frontmatter);
    expect(result.Title).toBe("New title");
    expect(result).not.toHaveProperty("description");
    expect(frontmatter).toEqual({ Title: "Old", description: "My description", custom: 42 });
  });
  it("rejects a title edited while the remote request was running", () => {
    const profile = createProfile("Calendar");
    profile.editable = true;
    const current = { ...fields, title: "Original", filePath: "Calendar/Note.md" } as CalendarEvent;
    const p = profile.properties;
    expect(() => googleNoteChanges(profile, fields, {
      [p.title]: "Concurrent change", [p.start]: fields.startDate, [p.end]: fields.endDate, [p.allDay]: true,
    }, current)).toThrow("changed during");
  });
  it("rejects overlapping fields and oversized ranges", () => {
    const profile = createProfile("Calendar");
    profile.editable = true;
    profile.properties.title = profile.properties.start;
    expect(() => googleNoteChanges(profile, fields, {})).toThrow("distinct");
    expect(() => googleNoteChanges(profile, { ...fields, endDate: "2029-09-10" }, {})).toThrow("date range");
  });
});
