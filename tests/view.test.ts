import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarEvent, CalendarSettings, CalendarSnapshot } from "../src/model";
import { LinkCalendarView, type CalendarActions } from "../src/view";

const FIXED_NOW = new Date(2026, 7, 25, 12);

function settings(): CalendarSettings {
  return {
    autoIndexDates: true,
    googleCalendar: {
      calendar: null,
      defaultDurationMinutes: 60,
      enabled: false,
      installationId: "",
      records: [],
      sourceProfileIds: [],
    },
    locale: "en",
    profiles: [{
      editable: false,
      enabled: true,
      folder: "Calendar",
      id: "calendar",
      name: "Calendar notes",
      properties: {
        allDay: "allDay",
        category: "category",
        end: "end",
        endTime: "endTime",
        start: "date",
        startTime: "startTime",
        title: "title",
      },
      recursive: true,
      tag: "",
    }],
    showAgenda: true,
    timeFormat: "24-hour",
    weekStart: "sunday",
  };
}

function calendarEvent(): CalendarEvent {
  return {
    allDay: false,
    category: "Learning",
    editable: false,
    endDate: "2026-08-25",
    endTime: "2026-08-25T17:30:00+09:00",
    filePath: "Calendar/Exam.md",
    id: "calendar:Calendar/Exam.md",
    kind: "event",
    origin: "profile",
    profileId: "calendar",
    sources: [{ excerpt: "Frontmatter", filePath: "Calendar/Exam.md", line: 0 }],
    startDate: "2026-08-25",
    startTime: "2026-08-25T16:00:00+09:00",
    title: "Practical certification exam with a long title",
  };
}

function snapshot(overrides: Partial<CalendarSnapshot> = {}): CalendarSnapshot {
  return {
    diagnostics: [],
    events: [calendarEvent()],
    revision: 1,
    ...overrides,
  };
}

function actions(): CalendarActions {
  return {
    create: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    openSettings: vi.fn(),
    setup: vi.fn(),
  };
}

async function openView(
  currentSnapshot: CalendarSnapshot,
  currentActions = actions(),
): Promise<{ actions: CalendarActions; view: LinkCalendarView }> {
  const view = new LinkCalendarView(
    {} as never,
    settings,
    () => currentSnapshot,
    currentActions,
  );
  document.body.append(view.contentEl);
  await view.onOpen();
  return { actions: currentActions, view };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve));
}

describe("Link Calendar Navigator view", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders loading, empty, and diagnostic error states", async () => {
    const loading = await openView(snapshot({ events: [], revision: 0 }));
    expect(loading.view.contentEl.querySelector(".is-loading")?.textContent).toContain(
      "Building your calendar",
    );

    const empty = await openView(snapshot({ events: [] }));
    expect(empty.view.contentEl.querySelector(".is-empty")?.textContent).toContain(
      "No dated notes this month",
    );

    const error = await openView(snapshot({
      diagnostics: [{ code: "invalid-date", filePath: "Calendar/Broken.md", profileId: "calendar" }],
      events: [],
    }));
    expect(error.view.contentEl.querySelector('[role="alert"]')?.textContent).toContain(
      "Some dated notes need review",
    );
  });

  it("shows only direct canonical note links after an event is selected", async () => {
    const currentActions = actions();
    const { view } = await openView(snapshot(), currentActions);
    expect(view.contentEl.querySelector(".link-calendar__side")).not.toBeNull();

    view.contentEl.querySelector<HTMLButtonElement>("[data-event-id]")?.click();
    await settle();

    expect(view.contentEl.querySelector(".link-calendar__side")).not.toBeNull();
    expect(view.contentEl.querySelector(".link-calendar__agenda-link")?.textContent).toContain(
      "Practical certification exam",
    );
    expect(view.contentEl.querySelector(".link-calendar__agenda-time")?.textContent).toBe(
      "16:00–17:30",
    );
    expect(view.contentEl.querySelector(".link-calendar__preview")).toBeNull();
    expect(view.contentEl.querySelector(".link-calendar__properties")).toBeNull();

    const openNote = view.contentEl.querySelector<HTMLAnchorElement>(".link-calendar__agenda-link");
    expect(openNote?.getAttribute("aria-label")).toContain("Open note");
    expect(openNote?.classList.contains("internal-link")).toBe(true);
    expect(openNote?.getAttribute("href")).toBe("Calendar/Exam.md");
    expect(openNote?.dataset.href).toBe("Calendar/Exam.md");
    openNote?.click();
    expect(vi.mocked(currentActions.open)).toHaveBeenCalledWith("Calendar/Exam.md");
  });

  it("renders the same stored wall-clock range in the selected 12-hour format", async () => {
    const currentSettings = settings();
    currentSettings.timeFormat = "12-hour";
    const view = new LinkCalendarView(
      {} as never,
      () => currentSettings,
      () => snapshot(),
      actions(),
    );
    document.body.append(view.contentEl);
    await view.onOpen();

    view.contentEl.querySelector<HTMLButtonElement>("[data-event-id]")?.click();
    await settle();

    expect(view.contentEl.querySelector(".link-calendar__agenda-time")?.textContent).toBe(
      "4:00 PM–5:30 PM",
    );
  });

  it("exposes month-grid selection semantics without a duplicate date button", async () => {
    const { view } = await openView(snapshot());
    const grid = view.contentEl.querySelector('[role="grid"]');
    const startingDay = view.contentEl.querySelector<HTMLElement>(
      '[role="gridcell"][aria-label="2026-08-25"]',
    );
    startingDay?.click();
    await settle();
    const selected = view.contentEl.querySelector('[role="gridcell"][aria-selected="true"]');
    const today = view.contentEl.querySelector('[role="gridcell"][aria-current="date"]');

    expect(grid?.getAttribute("aria-label")).toBe("August 2026");
    expect(selected?.getAttribute("tabindex")).toBe("0");
    expect(selected?.querySelector("button.link-calendar__day-number")).toBeNull();
    expect(today).not.toBeNull();

    selected?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    await settle();
    const next = view.contentEl.querySelector('[role="gridcell"][aria-selected="true"]');
    expect(next?.getAttribute("aria-label")).toMatch(/^2026-08-26(?:,|$)/);
    expect(document.activeElement).toBe(next);
  });

  it("returns to today from both the visible action and the public command target", async () => {
    const { view } = await openView(snapshot());
    const today = view.contentEl.querySelector<HTMLElement>('[role="gridcell"][aria-current="date"]');
    expect(today).not.toBeNull();

    view.contentEl.querySelector<HTMLButtonElement>(".link-calendar__today")?.click();
    await settle();
    expect(view.contentEl.querySelector('[role="gridcell"][aria-selected="true"]')?.getAttribute("aria-current"))
      .toBe("date");

    view.showToday(true);
    await settle();
    expect(document.activeElement?.getAttribute("aria-current")).toBe("date");
  });

  it("moves the selected agenda date with the displayed month", async () => {
    const { view } = await openView(snapshot());
    view.contentEl.querySelector<HTMLButtonElement>('[title="Next month"]')?.click();
    await settle();

    expect(view.contentEl.querySelector('[role="grid"]')?.getAttribute("aria-label")).toBe(
      "September 2026",
    );
    expect(view.contentEl.querySelector('[role="gridcell"][aria-selected="true"]')?.getAttribute("aria-label"))
      .toMatch(/^2026-09-25(?:,|$)/);
    expect(view.contentEl.querySelector(".link-calendar__side-date")?.textContent).toContain(
      "September 25, 2026",
    );
  });

  it("renders bounded one-line event titles with a readable overflow row", async () => {
    const events = Array.from({ length: 5 }, (_, index) => ({
      ...calendarEvent(),
      id: `event-${String(index)}`,
      title: index === 0 ? "A very long event title that must remain on one line" : `Event ${String(index + 1)}`,
    }));
    const { view } = await openView(snapshot({ events }));

    expect(view.contentEl.querySelectorAll(".link-calendar__marker-label")).toHaveLength(3);
    expect(view.contentEl.querySelector(".link-calendar__marker-label")?.textContent)
      .toBe("A very long event title that must remain on one line");
    expect(view.contentEl.querySelector(".link-calendar__marker-more")?.textContent).toBe("+2 more");
  });

  it("separates the canonical note from unique mentioning notes", async () => {
    const period = {
      ...calendarEvent(),
      editable: false,
      filePath: "Career/Application.md",
      id: "period",
      kind: "period" as const,
      origin: "body" as const,
      sources: [
        { excerpt: "Frontmatter", filePath: "Career/Application.md", line: 0 },
        { excerpt: "History", filePath: "People/Minjeong.md", line: 12 },
        { excerpt: "Repeated", filePath: "People/Minjeong.md", line: 22 },
        { excerpt: "Project", filePath: "Projects/Kubernetes.md", line: 4 },
      ],
      title: "KRAFTON application",
    };
    const { view } = await openView(snapshot({ events: [period] }));

    view.revealPath(period.filePath);

    expect(view.contentEl.textContent).toContain("Source note");
    expect(view.contentEl.textContent).toContain("Mentioned in 2 notes");
    expect(view.contentEl.querySelectorAll(".link-calendar__agenda-source-row button"))
      .toHaveLength(3);
  });

  it("distinguishes a filtered-empty month and restores it without changing notes", async () => {
    const { view } = await openView(snapshot());
    const search = view.contentEl.querySelector<HTMLInputElement>(".link-calendar__search input");
    if (!search) throw new Error("Search input did not render");
    search.value = "no matching note";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 100));

    expect(view.contentEl.querySelector(".is-filtered-empty")?.textContent).toContain(
      "No notes match these filters",
    );
    view.contentEl.querySelector<HTMLButtonElement>(".is-filtered-empty button")?.click();
    expect(view.contentEl.querySelectorAll("[data-event-id]")).toHaveLength(1);
  });

  it("opens the Markdown page with the keyboard and restores marker focus after Escape", async () => {
    const currentActions = actions();
    const { view } = await openView(snapshot(), currentActions);
    const marker = view.contentEl.querySelector<HTMLButtonElement>("[data-event-id]");
    marker?.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "Enter",
      metaKey: true,
    }));
    expect(vi.mocked(currentActions.open)).toHaveBeenCalledWith("Calendar/Exam.md");

    marker?.click();
    await settle();
    view.contentEl.querySelector<HTMLElement>(".link-calendar__side")?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
    );
    await settle();

    expect(view.contentEl.querySelector(".link-calendar__side")).toBeNull();
    expect(document.activeElement?.getAttribute("data-event-id")).toBe(calendarEvent().id);
  });

  it("does not expose a second relationship or metadata browser", async () => {
    const { view } = await openView(snapshot());
    view.contentEl.querySelector<HTMLButtonElement>("[data-event-id]")?.click();
    await settle();

    expect(view.contentEl.textContent).not.toContain("Jane Doe");
    expect(view.contentEl.textContent).not.toContain("Study plan");
    expect(view.contentEl.querySelector(".link-calendar__relation-link")).toBeNull();
  });
});
