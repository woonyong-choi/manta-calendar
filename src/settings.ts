import type { ConnectionPhase } from "./google-auth";
import {
  type App,
  Notice,
  type Plugin,
  PluginSettingTab,
  SettingGroup,
  type SettingDefinitionItem,
  type SettingDefinitionPage,
  type SettingGroupItem,
  type TFolder,
} from "obsidian";

import { type SourceHealth } from "./index";
import { type MessageKey, formatMessage, translate } from "./i18n";
import {
  type CalendarSettings,
  type SourceProfile,
  createProfile,
} from "./model";
import { type ProfileValidation, validateProfile } from "./policy";

export interface SettingsHost {
  app: App;
  settings: CalendarSettings;
  chooseFolder(onChoose: (folder: TFolder) => void): void;
  connectGoogle(): Promise<void>;
  cancelGoogleConnection(): void;
  disconnectGoogle(): Promise<void>;
  googleAvailable(): boolean;
  googleConnected(): boolean;
  googleConnectionPhase?(): ConnectionPhase;
  ensureGoogleCalendar(options?: { showFailure?: boolean; replaceUnavailable?: boolean }): Promise<void>;
  saveSettings(rebuildIndex?: boolean): Promise<void>;
  sourceHealth(profile: SourceProfile): SourceHealth;
  syncGoogleCalendar(): Promise<void>;
  toggleGoogleSource(profileId: string, enabled: boolean): Promise<void>;
}

export class LinkCalendarSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: SettingsHost & Plugin) {
    super(app, host);
  }

  override update(): void {
    // Obsidian 1.12 has no declarative settings refresh API.
    if (typeof super.update === "function") super.update();
    else if (this.containerEl.isConnected) this.renderLegacy();
  }

  override display(): void {
    this.renderLegacy();
  }

  private renderLegacy(): void {
    this.containerEl.empty();
    this.renderLegacyDefinitions(this.containerEl, this.getSettingDefinitions());
  }

  private renderLegacyDefinitions(container: HTMLElement, definitions: SettingDefinitionItem[]): void {
    for (const definition of definitions) {
      const group = new SettingGroup(container);
      if (!("name" in definition)) {
        if (definition.heading) group.setHeading(definition.heading);
        definition.items?.forEach((item, index) => this.renderLegacySetting(group, item, index));
      } else {
        this.renderLegacySetting(group, definition, 0);
      }
    }
  }

  private renderLegacySetting(group: SettingGroup, definition: SettingGroupItem, index: number): void {
    if ("type" in definition) {
      const page = group.listEl.createEl("details", { cls: "link-calendar-setting-source" });
      page.createEl("summary", { text: definition.name });
      if (definition.desc) page.createEl("p", { text: definition.desc });
      this.renderLegacyDefinitions(page, definition.items ?? []);
      return;
    }
    group.addSetting((setting) => {
      setting.setName(definition.name);
      if (definition.desc) setting.setDesc(definition.desc);
      if (definition.render) definition.render(setting, group);
      else if (definition.action) {
        const action = definition.action;
        setting.addButton((button) => button.setButtonText(definition.name)
          .onClick(() => action(setting.settingEl, index)));
      } else if (definition.control) {
        const control = definition.control;
        if (control.type === "toggle") {
          setting.addToggle((toggle) => toggle.setValue(Boolean(this.getControlValue(control.key)))
            .onChange((value) => this.setControlValue(control.key, value)));
        } else if (control.type === "dropdown") {
          const value = this.getControlValue(control.key);
          setting.addDropdown((dropdown) => dropdown.addOptions(control.options)
            .setValue(typeof value === "string" ? value : "")
            .onChange((value) => this.setControlValue(control.key, value)));
        }
      }
    });
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const locale = this.host.settings.locale;
    return [
      {
        type: "group",
        heading: translate(locale, "settings"),
        items: [
          {
            name: translate(locale, "language"),
            desc: translate(locale, "languageDesc"),
            control: {
              type: "dropdown",
              key: "locale",
              options: {
                auto: translate(locale, "automatic"),
                en: translate(locale, "english"),
                ko: translate(locale, "korean"),
              },
            },
          },
          {
            name: translate(locale, "weekStartsOn"),
            control: {
              type: "dropdown",
              key: "weekStart",
              options: {
                auto: translate(locale, "automatic"),
                sunday: translate(locale, "sunday"),
                monday: translate(locale, "monday"),
              },
            },
          },
          {
            name: translate(locale, "timeFormat"),
            desc: translate(locale, "timeFormatDesc"),
            control: {
              type: "dropdown",
              key: "timeFormat",
              options: {
                "12-hour": translate(locale, "twelveHour"),
                "24-hour": translate(locale, "twentyFourHour"),
              },
            },
          },
          {
            name: translate(locale, "agendaPanel"),
            desc: translate(locale, "agendaPanelDesc"),
            control: { type: "toggle", key: "showAgenda" },
          },
          {
            name: translate(locale, "automaticDateIndex"),
            desc: translate(locale, "automaticDateIndexDesc"),
            control: { type: "toggle", key: "autoIndexDates" },
          },
        ],
      },
      {
        type: "group",
        heading: translate(locale, "googleCalendar"),
        items: this.googleItems(),
      },
      {
        type: "group",
        heading: translate(locale, "sources"),
        items: [
          ...this.host.settings.profiles.map((profile) => this.profilePage(profile)),
          {
            name: translate(locale, "addSource"),
            desc: translate(locale, "sourceDesc"),
            action: () => {
              const profile = createProfile();
              profile.name = translate(locale, "calendarNotes");
              this.host.settings.profiles.push(profile);
              this.update();
            },
          },
        ],
      },
    ];
  }

  override getControlValue(key: string): unknown {
    if (key === "locale") return this.host.settings.locale;
    if (key === "weekStart") return this.host.settings.weekStart;
    if (key === "showAgenda") return this.host.settings.showAgenda;
    if (key === "timeFormat") return this.host.settings.timeFormat;
    if (key === "autoIndexDates") return this.host.settings.autoIndexDates;
    if (key === "googleEnabled") return this.host.settings.googleCalendar.enabled;
    if (key === "googleIncomingProfile") return this.host.settings.googleCalendar.incomingProfileId ?? "";
    if (key === "googleDefaultDuration") {
      return String(this.host.settings.googleCalendar.defaultDurationMinutes);
    }
    return undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "locale" && (value === "auto" || value === "en" || value === "ko")) {
      this.host.settings.locale = value;
    } else if (key === "weekStart" && (value === "auto" || value === "sunday" || value === "monday")) {
      this.host.settings.weekStart = value;
    } else if (key === "showAgenda" && typeof value === "boolean") {
      this.host.settings.showAgenda = value;
    } else if (key === "timeFormat" && (value === "12-hour" || value === "24-hour")) {
      this.host.settings.timeFormat = value;
    } else if (key === "autoIndexDates" && typeof value === "boolean") {
      this.host.settings.autoIndexDates = value;
      await this.host.saveSettings(true);
      this.update();
      return;
    } else if (key === "googleEnabled" && typeof value === "boolean") {
      this.host.settings.googleCalendar.enabled = value;
      if (!value) this.host.cancelGoogleConnection();
    } else if (key === "googleIncomingProfile" && typeof value === "string"
      && (!value || this.host.settings.profiles.some(profile => profile.id === value && profile.enabled && profile.editable))) {
      this.host.settings.googleCalendar.incomingProfileId = value;
      if (value && !this.host.settings.googleCalendar.sourceProfileIds.includes(value)) this.host.settings.googleCalendar.sourceProfileIds.push(value);
    } else if (key === "googleDefaultDuration"
      && (value === "15" || value === "30" || value === "60" || value === "90")) {
      this.host.settings.googleCalendar.defaultDurationMinutes = Number(value);
    } else {
      return;
    }
    await this.host.saveSettings();
    this.update();
  }

  private googleItems(): SettingGroupItem[] {
    const locale = this.host.settings.locale;
    const google = this.host.settings.googleCalendar;
    const connected = this.host.googleConnected();
    const connecting = ["waiting", "exchanging"].includes(this.host.googleConnectionPhase?.() ?? "idle");
    const items: SettingGroupItem[] = [
      {
        name: translate(locale, "googleEnable"),
        desc: translate(locale, "googleEnableDesc"),
        control: { type: "toggle", key: "googleEnabled" },
      },
    ];
    if (!google.enabled) return items;
    items.push({
      name: translate(locale, "googleConnectionStatus"),
      render: (setting) => {
        const refresh = () => setting.setDesc(translate(locale, this.host.googleConnectionPhase?.() ?? "idle"));
        refresh();
        setting.addExtraButton((button) => button.setIcon("refresh-cw")
          .setTooltip(translate(locale, "googleConnectionStatus")).onClick(() => { refresh(); this.update(); }));
      },
    });
    items.push({
      name: connected ? translate(locale, "googleConnected") : translate(locale, "googleConnect"),
      desc: translate(locale, "googleCalendarDesc"),
      render: (setting) => {
        setting
          .setName(connected ? translate(locale, "googleConnected") : translate(locale, "googleConnect"))
          .setDesc(this.host.googleAvailable()
            ? translate(locale, "googleCalendarDesc")
            : translate(locale, "googleUnavailable"));
        setting.addButton((button) => {
          button
            .setButtonText(connected ? translate(locale, "googleDisconnect") : translate(locale, "googleConnect"))
            .setDisabled(connecting || (!connected && !this.host.googleAvailable()))
            .onClick(() => {
              void (connected ? this.host.disconnectGoogle() : this.host.connectGoogle())
                .then(() => this.update());
            });
        });
      },
    });
    if (connecting) items.push({
      name: translate(locale, "googleCancelConnection"),
      action: () => { this.host.cancelGoogleConnection(); },
    });
    if (!connected) return items;
    items.push({
      name: translate(locale, "googleCalendarTarget"),
      desc: google.calendar?.name ?? translate(locale, "googleNoCalendars"),
      render: (setting) => {
        setting
          .setName(translate(locale, "googleCalendarTarget"))
          .setDesc(google.calendar?.name ?? translate(locale, "googleNoCalendars"));
        setting.addExtraButton((button) => {
          button.setIcon("refresh-cw").setTooltip(translate(locale, "googleCalendarTarget"));
          button.onClick(() => { void this.host.ensureGoogleCalendar().then(() => this.update()); });
        });
      },
    });
    if (google.calendar) items.push({
      name: translate(locale, "googleReplaceUnavailable"),
      desc: translate(locale, "googleReplaceUnavailableDesc"),
      action: () => { void this.host.ensureGoogleCalendar({ replaceUnavailable: true }).then(() => this.update()); },
    });
    items.push({
      name: translate(locale, "googleDefaultDuration"),
      desc: translate(locale, "googleDefaultDurationDesc"),
      control: {
        type: "dropdown",
        key: "googleDefaultDuration",
        options: { "15": "15 min", "30": "30 min", "60": "60 min", "90": "90 min" },
      },
    });
    for (const profile of this.host.settings.profiles.filter((profile) => profile.enabled)) {
      items.push({
        name: formatMessage(locale, "googleSourceMapping", { name: profile.name }),
        desc: translate(locale, "googleSourceMappingDesc"),
        render: (setting) => {
          setting
            .setName(formatMessage(locale, "googleSourceMapping", { name: profile.name }))
            .setDesc(translate(locale, "googleSourceMappingDesc"))
            .addToggle((control) => {
              control
                .setValue(google.sourceProfileIds.includes(profile.id))
                .onChange((value) => {
                  void this.host.toggleGoogleSource(profile.id, value).then(() => this.update());
                });
            });
        },
      });
    }
    items.push({
      name: translate(locale, "googleSyncNow"),
      action: () => { void this.host.syncGoogleCalendar().then(() => this.update()); },
    });
    items.splice(items.length - 1, 0, {
      name: translate(locale, "googleIncomingProfile"),
      desc: translate(locale, "googleIncomingProfileDesc"),
      control: { type: "dropdown", key: "googleIncomingProfile", options: {
        "": translate(locale, "googleOutgoingOnly"),
        ...Object.fromEntries(this.host.settings.profiles.filter(profile => profile.enabled && profile.editable).map(profile => [profile.id, profile.name])),
      } },
    });
    return items;
  }

  private profilePage(profile: SourceProfile): SettingDefinitionPage {
    const locale = this.host.settings.locale;
    const draft = structuredClone(profile);
    const health = this.host.sourceHealth(profile);
    const healthSummary = formatMessage(locale, "sourceHealth", {
      invalid: String(health.invalid),
      missing: String(health.missing),
      total: String(health.total),
      valid: String(health.valid),
    });
    const fields = [
      ["start", translate(locale, "startDate")],
      ["end", translate(locale, "endDate")],
      ["startTime", translate(locale, "startTime")],
      ["endTime", translate(locale, "endTime")],
      ["allDay", translate(locale, "allDay")],
      ["title", translate(locale, "titleField")],
      ["category", translate(locale, "category")],
    ] as const;
    return {
      type: "page",
      name: profile.name || translate(locale, "calendarSource"),
      desc: profile.enabled ? healthSummary : translate(locale, "disabled"),
      displayValue: profile.enabled
        ? `${profile.folder || translate(locale, "folderRequired")} · ${healthSummary}`
        : profile.folder || translate(locale, "folderRequired"),
      status: validateProfile(profile) || health.invalid || health.missing ? "warning" : null,
      items: [
        {
          type: "group",
          items: [
            {
              name: translate(locale, "sourceHealthLabel"),
              render: (setting) => {
                setting
                  .setName(translate(locale, "sourceHealthLabel"))
                  .setDesc(healthSummary);
              },
            },
          ],
        },
        {
          type: "group",
          items: [
            {
              name: translate(locale, "enableSource"),
              render: (setting) => {
                setting.addToggle((control) => {
                  control.setValue(draft.enabled).onChange((value) => { draft.enabled = value; });
                });
              },
            },
            {
              name: translate(locale, "name"),
              render: (setting) => {
                setting.addText((control) => {
                  control.setValue(draft.name).onChange((value) => { draft.name = value.trim(); });
                });
              },
            },
            {
              name: translate(locale, "folder"),
              desc: translate(locale, "folderDesc"),
              render: (setting) => {
                let setFolderValue = (_value: string): void => undefined;
                setting.addText((control) => {
                  setFolderValue = (value) => {
                    control.setValue(value);
                  };
                  control
                    .setPlaceholder(translate(locale, "calendarNotes"))
                    .setValue(draft.folder)
                    .onChange((value) => {
                      draft.folder = value.trim().replace(/^\/+|\/+$/g, "");
                    });
                });
                setting.addExtraButton((button) => {
                  button.setIcon("folder-search").setTooltip(translate(locale, "chooseFolder"));
                  button.onClick(() => this.host.chooseFolder((folder) => {
                    draft.folder = folder.path;
                    setFolderValue(folder.path);
                  }));
                });
              },
            },
            {
              name: translate(locale, "tag"),
              desc: translate(locale, "tagDesc"),
              render: (setting) => {
                setting.addText((control) => {
                  control.setPlaceholder("Calendar").setValue(draft.tag).onChange((value) => {
                    draft.tag = value.replace(/^#/, "").trim();
                  });
                });
              },
            },
            {
              name: translate(locale, "writable"),
              desc: translate(locale, "writableDesc"),
              render: (setting) => {
                setting.addToggle((control) => {
                  control.setValue(draft.editable).onChange((value) => { draft.editable = value; });
                });
              },
            },
            {
              name: translate(locale, "includeSubfolders"),
              render: (setting) => {
                setting.addToggle((control) => {
                  control.setValue(draft.recursive).onChange((value) => { draft.recursive = value; });
                });
              },
            },
          ],
        },
        {
          type: "group",
          heading: translate(locale, "propertyMapping"),
          items: fields.map(([key, label]) => ({
            name: label,
            render: (setting) => {
              setting.addText((control) => {
                control.setValue(draft.properties[key]).onChange((value) => {
                  draft.properties[key] = value.trim();
                });
              });
            },
          })),
        },
        {
          name: translate(locale, "apply"),
          action: () => {
            const invalid = validateProfile(draft);
            if (invalid) {
              new Notice(translate(locale, validationMessage(invalid)));
              return;
            }
            Object.assign(profile, structuredClone(draft));
            void this.host.saveSettings(true).then(() => this.update());
          },
        },
        {
          name: translate(locale, "removeSource"),
          action: () => {
            this.host.settings.profiles = this.host.settings.profiles.filter((item) => item.id !== profile.id);
            this.host.settings.googleCalendar.sourceProfileIds = this.host.settings.googleCalendar.sourceProfileIds
              .filter((id) => id !== profile.id);
            void this.host.saveSettings(true).then(() => this.update());
          },
        },
      ],
    };
  }
}

function validationMessage(value: ProfileValidation): MessageKey {
  if (value === "invalid-property") return "invalidProperty";
  if (value === "missing-start") return "missingStart";
  if (value === "unsafe-folder") return "invalidFolder";
  return "missingSource";
}
