export class TFile {
  basename = "";
  extension = "md";
  parent: TFolder | null = null;
  path = "";
}

export class TFolder {
  children: (TFile | TFolder)[] = [];
  name = "";
  path = "";
}

export class ItemView {
  contentEl = document.createElement("div");

  constructor(public leaf: unknown) {}

  registerDomEvent(
    target: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject,
  ): void {
    target.addEventListener(type, callback);
  }
}

export class PluginSettingTab {
  containerEl = document.createElement("div");

  constructor(public app: unknown, public plugin: unknown) {}

  update(): void {}
}

export class SettingGroup {
  listEl: HTMLElement;

  constructor(container: HTMLElement) { this.listEl = container.createDiv(); }
  setHeading(text: string): this { this.listEl.createEl("h3", { text }); return this; }
  addSetting(configure: (setting: Setting) => void): this {
    configure(new Setting(this.listEl));
    return this;
  }
}

class Setting {
  settingEl: HTMLElement;

  constructor(container: HTMLElement) { this.settingEl = container.createDiv({ cls: "setting-item" }); }
  setName(text: string): this { this.settingEl.dataset.name = text; return this; }
  setDesc(text: string): this { this.settingEl.dataset.desc = text; return this; }
  addToggle(configure: (control: ReturnType<typeof toggleControl>) => void): this {
    configure(toggleControl(this.settingEl)); return this;
  }
  addDropdown(configure: (control: ReturnType<typeof dropdownControl>) => void): this {
    configure(dropdownControl(this.settingEl)); return this;
  }
  addText(configure: (control: ReturnType<typeof textControl>) => void): this {
    configure(textControl(this.settingEl)); return this;
  }
  addButton(configure: (control: ReturnType<typeof buttonControl>) => void): this {
    configure(buttonControl(this.settingEl)); return this;
  }
  addExtraButton(configure: (control: ReturnType<typeof buttonControl>) => void): this {
    return this.addButton(configure);
  }
}

function toggleControl(container: HTMLElement) {
  const input = container.createEl("input", { attr: { type: "checkbox" } });
  return {
    setValue(value: boolean) { input.checked = value; return this; },
    onChange(callback: (value: boolean) => unknown) {
      input.addEventListener("change", () => { callback(input.checked); }); return this;
    },
  };
}

function dropdownControl(container: HTMLElement) {
  const input = container.createEl("select");
  return {
    addOptions(options: Record<string, string>) {
      for (const [value, text] of Object.entries(options)) input.createEl("option", { text, attr: { value } });
      return this;
    },
    setValue(value: string) { input.value = value; return this; },
    onChange(callback: (value: string) => unknown) {
      input.addEventListener("change", () => { callback(input.value); }); return this;
    },
  };
}

function textControl(container: HTMLElement) {
  const inputEl = container.createEl("input");
  return {
    inputEl,
    setValue(value: string) { inputEl.value = value; return this; },
    setPlaceholder(value: string) { inputEl.placeholder = value; return this; },
    onChange(callback: (value: string) => unknown) {
      inputEl.addEventListener("input", () => { callback(inputEl.value); }); return this;
    },
  };
}

function buttonControl(container: HTMLElement) {
  const buttonEl = container.createEl("button");
  return {
    setButtonText(value: string) { buttonEl.textContent = value; return this; },
    setDisabled(value: boolean) { buttonEl.disabled = value; return this; },
    setIcon(value: string) { buttonEl.dataset.icon = value; return this; },
    setTooltip(value: string) { buttonEl.title = value; return this; },
    onClick(callback: () => unknown) {
      buttonEl.addEventListener("click", () => { callback(); }); return this;
    },
  };
}

export class Notice {
  constructor(readonly message: unknown, readonly timeout?: number) {}

  hide(): void {}
}

class MenuItem {
  onClick(_action: () => void): this {
    return this;
  }

  setIcon(_icon: string): this {
    return this;
  }

  setTitle(_title: string): this {
    return this;
  }
}

export class Menu {
  addItem(configure: (item: MenuItem) => void): this {
    configure(new MenuItem());
    return this;
  }

  showAtMouseEvent(_event: MouseEvent): void {}
}

export function setIcon(element: HTMLElement, icon: string): void {
  element.dataset.icon = icon;
}

// Refresh fixtures use JSON, a YAML subset; Obsidian owns the YAML parser.
export function parseYaml(text: string): unknown {
  return JSON.parse(text) as unknown;
}
