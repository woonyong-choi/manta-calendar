import { type CalendarEvent, type SourceProfile, calendarSpanLength, MAX_EVENT_SPAN_DAYS, dateKey, findFieldKey, readField } from "./model";
import { writableProfiles } from "./policy";
import type { GoogleIncomingFields } from "./google-calendar";

export function googleNoteChanges(profile: SourceProfile, fields: GoogleIncomingFields, frontmatter: Record<string, unknown>, current?: CalendarEvent): Record<string, unknown> {
  if (writableProfiles([profile]).length !== 1 || readField(frontmatter, "external_sync") === "deny") throw new Error("This note does not allow incoming synchronization.");
  if (calendarSpanLength(fields.startDate, fields.endDate) > MAX_EVENT_SPAN_DAYS) throw new Error("Google event exceeds the supported date range.");
  const names = [profile.properties.title, profile.properties.start, profile.properties.end, profile.properties.startTime, profile.properties.endTime, profile.properties.allDay];
  if (names.some(name => !name || ["external_sync", "google_calendar_id", "google_event_id", "tags"].includes(name.toLowerCase())) || new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error("Incoming synchronization requires distinct title, start, end, time and all-day property mappings.");
  if (current) {
    const text = (name: string) => {
      const value = readField(frontmatter, name);
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).trim() : "";
    };
    const allDay = text(profile.properties.allDay).toLowerCase() === "true";
    const title = text(profile.properties.title) || current.filePath.split("/").pop()?.replace(/\.md$/i, "");
    if (dateKey(readField(frontmatter, profile.properties.start)) !== current.startDate
      || (dateKey(readField(frontmatter, profile.properties.end)) || current.startDate) !== current.endDate
      || title !== current.title || allDay !== current.allDay
      || (!allDay && (text(profile.properties.startTime) !== current.startTime || text(profile.properties.endTime) !== current.endTime))) {
      throw new Error("The note changed during synchronization. Its contents were preserved.");
    }
  }
  const values = [fields.title, fields.startDate, fields.endDate, fields.startTime, fields.endTime, fields.allDay];
  return Object.fromEntries(names.map((name, index) => [findFieldKey(frontmatter, name) ?? name, values[index]]));
}
