import { beforeEach } from "vitest";

interface CreateOptions {
  attr?: Record<string, boolean | null | number | string>;
  cls?: string | string[];
  text?: DocumentFragment | string;
  title?: string;
}

function applyOptions(element: HTMLElement, input: CreateOptions | string = {}): void {
  const options = typeof input === "string" ? { cls: input } : input;
  if (options.cls) element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
  if (typeof options.text === "string") element.textContent = options.text;
  else if (options.text) element.append(options.text);
  if (options.title !== undefined) element.title = options.title;
  for (const [name, value] of Object.entries(options.attr ?? {})) {
    if (value !== null) element.setAttribute(name, String(value));
  }
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: CreateOptions | string = {},
  callback?: (element: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  applyOptions(element, options);
  callback?.(element);
  return element;
}

Reflect.set(globalThis, "createEl", makeElement);
Reflect.set(HTMLElement.prototype, "addClass", function addClass(this: HTMLElement, ...classes: string[]): void {
  this.classList.add(...classes);
});
Reflect.set(HTMLElement.prototype, "createDiv", function createDiv(
  this: HTMLElement,
  options: CreateOptions | string = {},
): HTMLDivElement {
  const child = makeElement("div", options);
  this.append(child);
  return child;
});
Reflect.set(HTMLElement.prototype, "createEl", function createChild<K extends keyof HTMLElementTagNameMap>(
  this: HTMLElement,
  tag: K,
  options: CreateOptions | string = {},
  callback?: (element: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const child = makeElement(tag, options, callback);
  this.append(child);
  return child;
});
Reflect.set(HTMLElement.prototype, "createSpan", function createSpan(
  this: HTMLElement,
  options: CreateOptions | string = {},
): HTMLSpanElement {
  const child = makeElement("span", options);
  this.append(child);
  return child;
});
Reflect.set(HTMLElement.prototype, "empty", function empty(this: HTMLElement): void {
  this.replaceChildren();
});
Reflect.set(HTMLElement.prototype, "findAll", function findAll(
  this: HTMLElement,
  selector: string,
): HTMLElement[] {
  return Array.from(this.querySelectorAll<HTMLElement>(selector));
});
Reflect.set(HTMLElement.prototype, "setText", function setText(this: HTMLElement, text: string): void {
  this.textContent = text;
});

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  disconnect(): void {}
  observe(target: Element): void {
    this.callback([{ target } as ResizeObserverEntry], this);
  }
  unobserve(_target: Element): void {}
}

globalThis.ResizeObserver = TestResizeObserver;
Reflect.set(globalThis, "CSS", { escape: (value: string) => value });

beforeEach(() => {
  document.body.replaceChildren();
});
