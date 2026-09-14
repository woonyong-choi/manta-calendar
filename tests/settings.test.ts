import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSettingTab, type App, type SettingGroupItem } from "obsidian";

import { DEFAULT_SETTINGS, createProfile, normalizeSettings, serializeSettings, type CalendarSettings } from "../src/model";
import { LinkCalendarSettingTab, type SettingsHost } from "../src/settings";
import type { ConnectionPhase } from "../src/google-auth";

function tab(overrides: Partial<CalendarSettings> = {}, connected = false) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  Object.assign(settings, overrides);
  const saveSettings = vi.fn(async () => {});
  const host = {
    app: {} as App,
    chooseFolder: vi.fn(),
    connectGoogle: vi.fn(async () => {}),
    cancelGoogleConnection: vi.fn(),
    disconnectGoogle: vi.fn(async () => {}),
    ensureGoogleCalendar: vi.fn(async () => {}),
    googleAvailable: () => true,
    googleConnected: () => connected,
    googleConnectionPhase: vi.fn<() => ConnectionPhase>(() => "idle"),
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

describe("Obsidian 1.12 settings compatibility", () => {
  const nativeUpdate = Object.getOwnPropertyDescriptor(PluginSettingTab.prototype, "update");
  beforeEach(() => { Reflect.deleteProperty(PluginSettingTab.prototype, "update"); });
  afterEach(() => {
    if (nativeUpdate) Object.defineProperty(PluginSettingTab.prototype, "update", nativeUpdate);
  });

  it("finishes initialization before the settings tab is mounted", () => {
    const fixture = tab();
    expect(() => fixture.tab.update()).not.toThrow();
    expect(fixture.tab.containerEl.childElementCount).toBe(0);
  });

  it("keeps using the native refresh API when available", () => {
    const update = vi.fn();
    Object.defineProperty(PluginSettingTab.prototype, "update", { configurable: true, value: update });
    const fixture = tab();
    fixture.tab.update();
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.instances[0]).toBe(fixture.tab);
  });

  it("renders controls and persists changes through the existing settings host", async () => {
    const fixture = tab({ locale: "en" });
    document.body.append(fixture.tab.containerEl);
    fixture.tab.display();
    const select = fixture.tab.containerEl.querySelector<HTMLSelectElement>('[data-name="Language"] select');
    expect(select).not.toBeNull();
    if (!select) throw new Error("missing language dropdown");
    select.value = "ko";
    select.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(fixture.saveSettings).toHaveBeenCalledOnce());
    expect(fixture.host.settings.locale).toBe("ko");
    expect(fixture.tab.containerEl.querySelector('[data-name="언어"]')).not.toBeNull();
    expect(fixture.host.connectGoogle).not.toHaveBeenCalled();
  });

  it("keeps editable source drafts and the apply action available", async () => {
    const profile = createProfile("Calendar");
    const fixture = tab({ locale: "en", profiles: [profile] });
    document.body.append(fixture.tab.containerEl);
    fixture.tab.display();
    const source = fixture.tab.containerEl.querySelector("details");
    expect(source?.querySelector("summary")?.textContent).toBe(profile.name);
    const name = source?.querySelector<HTMLInputElement>('[data-name="Name"] input');
    if (!name) throw new Error("missing source name field");
    name.value = "Project dates";
    name.dispatchEvent(new Event("input"));
    expect(profile.name).not.toBe("Project dates");
    source?.querySelector<HTMLButtonElement>('[data-name="Apply"] button')?.click();
    await vi.waitFor(() => expect(fixture.saveSettings).toHaveBeenCalledWith(true));
    expect(profile.name).toBe("Project dates");
  });

  it.each([false, true])("renders Google settings without starting a connection (connected=%s)", (connected) => {
    const fixture = tab({ locale: "en", profiles: [createProfile("Calendar")] }, connected);
    fixture.host.settings.googleCalendar.enabled = true;
    if (connected) fixture.host.settings.googleCalendar.calendar = { id: "dedicated", name: "Calendar", timeZone: "UTC" };
    fixture.tab.display();
    expect(fixture.tab.containerEl.querySelectorAll(".setting-item").length).toBeGreaterThan(15);
    expect(fixture.host.connectGoogle).not.toHaveBeenCalled();
    expect(fixture.host.syncGoogleCalendar).not.toHaveBeenCalled();
  });
});

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

  it("offers cancellation while approval is pending and cancels when Google is disabled", async () => {
    const fixture = tab({ locale: "en" });
    fixture.host.settings.googleCalendar.enabled = true;
    fixture.host.googleConnectionPhase.mockReturnValue("waiting");
    fixture.tab.display();
    expect(fixture.tab.containerEl.querySelector<HTMLButtonElement>('[data-name="Connect Google Calendar"] button')?.disabled).toBe(true);
    const cancel = fixture.tab.containerEl.querySelector<HTMLButtonElement>('[data-name="Cancel connection"] button');
    expect(cancel).not.toBeNull();
    cancel?.click();
    expect(fixture.host.cancelGoogleConnection).toHaveBeenCalledOnce();
    fixture.host.cancelGoogleConnection.mockClear();
    await fixture.tab.setControlValue("googleEnabled", false);
    expect(fixture.host.cancelGoogleConnection).toHaveBeenCalledOnce();
    expect(fixture.host.settings.googleCalendar.enabled).toBe(false);
    expect(fixture.host.connectGoogle).not.toHaveBeenCalled();
  });

  it("exposes explicit calendar recovery separately from source synchronization", () => {
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
    const recovery = googleItems(fixture.tab).find(item => item.name === "Create calendar if unavailable");
    expect(recovery).toBeDefined();
    if (!recovery || !("action" in recovery) || typeof recovery.action !== "function") throw new Error("missing recovery action");
    recovery.action(document.createElement("button"), 0);
    expect(fixture.host.ensureGoogleCalendar).toHaveBeenCalledWith({ replaceUnavailable: true });
    expect(fixture.host.disconnectGoogle).not.toHaveBeenCalled();
    expect(fixture.host.syncGoogleCalendar).not.toHaveBeenCalled();
  });
});
