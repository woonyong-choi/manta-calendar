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
