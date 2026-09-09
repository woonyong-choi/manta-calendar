import { describe, expect, it, vi } from "vitest";
import type { App, SettingGroupItem } from "obsidian";

import { DEFAULT_SETTINGS, createProfile, normalizeSettings, serializeSettings, type CalendarSettings } from "../src/model";
import { LinkCalendarSettingTab, type SettingsHost } from "../src/settings";

function tab(overrides: Partial<CalendarSettings> = {}, connected = false) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings, overrides);
  const saveSettings = vi.fn(async () => {});
  const host = {
    app: {} as App,
    chooseFolder: vi.fn(),
    connectGoogle: vi.fn(async () => {}),
    completeGoogleFromLink: vi.fn(async () => {}),
    disconnectGoogle: vi.fn(async () => {}),
    ensureGoogleCalendar: vi.fn(async () => {}),
    googleAvailable: () => true,
    googleConnected: () => connected,
    saveSettings,
    settings,
    sourceHealth: () => ({ invalid: 0, missing: 0, total: 1, valid: 1 }),
    syncGoogleCalendar: vi.fn(async () => {}),
    toggleGoogleSource: vi.fn(async () => {}),
  } satisfies SettingsHost;
  return {
    host,
    saveSettings,
    tab: new LinkCalendarSettingTab({} as never, host as never),
  };
}

function googleItems(settingTab: LinkCalendarSettingTab) {
  const group = settingTab.getSettingDefinitions().find(isGoogleGroup);
  if (!group) throw new Error("missing Google Calendar settings group");
  return group.items;
}

function isGoogleGroup(value: unknown): value is {
  heading: string;
  items: SettingGroupItem[];
  type: "group";
} {
  return value !== null
    && typeof value === "object"
    && "type" in value
    && value.type === "group"
    && "heading" in value
    && value.heading === "Google Calendar"
    && "items" in value
    && Array.isArray(value.items);
}

describe("Google Calendar settings boundary", () => {
  it("keeps two-way opt-in and its selected source after restarting", async () => {
    const profile = createProfile("Calendar");
    profile.editable = true;
    const fixture = tab({ profiles: [profile] });
    await fixture.tab.setControlValue("googleIncomingProfile", profile.id);
    const restored = normalizeSettings(serializeSettings(fixture.host.settings));
    expect(restored.googleCalendar.incomingProfileId).toBe(profile.id);
    expect(restored.googleCalendar.sourceProfileIds).toContain(profile.id);
  });
  it("shows only an off toggle by default", () => {
    const fixture = tab();
    const items = googleItems(fixture.tab);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ control: { key: "googleEnabled", type: "toggle" } });
    expect(fixture.host.googleConnected()).toBe(false);
  });

  it("does not connect merely because the feature is enabled", async () => {
    const fixture = tab();
    await fixture.tab.setControlValue("googleEnabled", true);
    expect(fixture.host.settings.googleCalendar.enabled).toBe(true);
    expect(fixture.host.connectGoogle).not.toHaveBeenCalled();
    expect(fixture.saveSettings).toHaveBeenCalledOnce();
  });

  it("exposes only explicit source mappings after connection", () => {
    const profile = createProfile("Calendar");
    profile.id = "calendar-source";
    profile.name = "Calendar notes";
    const fixture = tab({
      googleCalendar: {
        calendar: { id: "dedicated", name: "Link Calendar", timeZone: "Asia/Seoul" },
        defaultDurationMinutes: 60,
        enabled: true,
        installationId: "installation",
        records: [],
        sourceProfileIds: [],
      },
      profiles: [profile],
    }, true);
    const labels = googleItems(fixture.tab).map((item) => item.name);
    expect(labels).toContain("Dedicated Google calendar");
    expect(labels).toContain("Sync source: Calendar notes");
    expect(labels).toContain("Sync now");
    expect(labels).not.toContain("Automatic date index");
  });
});
