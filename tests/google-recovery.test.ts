import { expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import LinkCalendarPlugin from "../src/main";
import type { GoogleHttpRequest } from "../src/google-calendar";

vi.mock("../src/google-config", () => ({ GOOGLE_OAUTH_RELAY_URL: "https://example.com" }));
vi.mock("obsidian", async importOriginal => ({
  ...await importOriginal<object>(),
  Plugin: vi.fn(),
  MarkdownRenderChild: vi.fn(),
  FuzzySuggestModal: vi.fn(),
  Modal: vi.fn(),
}));

it.each([200, 500])("preserves mappings and authorization during concurrent recovery with create status %s", async status => {
  const plugin = new LinkCalendarPlugin({} as App, {} as PluginManifest);
  const google = plugin.settings.googleCalendar;
  google.enabled = true;
  google.calendar = { id: "old-calendar", name: "Link Calendar", timeZone: "UTC" };
  google.sourceProfileIds = ["profile"];
  google.incomingProfileId = "profile";
  google.installationId = "installation";
  google.records = Array.from({ length: 7 }, (_, index) => ({
    calendarId: "old-calendar", etag: "etag", eventId: String(index), fingerprint: "fingerprint",
    localKey: `profile\u0000Calendar/${String(index)}.md`,
  }));
  const before = structuredClone(google);
  const requests: GoogleHttpRequest[] = [];
  const auth = { isConnected: () => true, getAccessToken: async () => "test-token", disconnect: vi.fn() };
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  Object.assign(plugin, {
    googleAuth: auth,
    settingsTab: { update: vi.fn() },
    googleRequest: async (request: GoogleHttpRequest) => {
      requests.push(request);
      await pending;
      return request.method === "POST"
        ? { status, json: { id: "new-calendar", summary: "Link Calendar", timeZone: "UTC" } }
        : { status: 404, json: {} };
    },
  });
  const save = vi.fn(async () => {});
  plugin.saveSettings = save;
  const first = plugin.ensureGoogleCalendar({ replaceUnavailable: true });
  const repeated = plugin.ensureGoogleCalendar({ replaceUnavailable: true });
  await plugin.syncGoogleCalendar();
  finish();
  await Promise.all([first, repeated]);
  expect(google).toEqual({ ...before, calendar: status === 200 ? { ...before.calendar, id: "new-calendar" } : before.calendar });
  expect(requests.map(request => request.method ?? "GET")).toEqual(["GET", "POST"]);
  expect(save).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  expect(auth.disconnect).not.toHaveBeenCalled();
});
