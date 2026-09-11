import { TFile, TFolder } from "obsidian";
import { describe, expect, it } from "vitest";

import {
  CalendarIndex,
  detectSourceFolder,
  inspectSourceHealth,
  matchesProfile,
  readField,
  selectProfile,
  selectProfileFromFrontmatter,
} from "../src/index";
import { createProfile } from "../src/model";
import { canCreateWithProfile, eventFrontmatter } from "../src/policy";

function fixture() {
  const files = [
    testFile("Calendar/Alpha.md"),
    testFile("Calendar/Bad.md"),
    testFile("People/Jane.md"),
  ];
  const folders = folderTree(files);
  const caches = new Map<string, {
    frontmatter: Record<string, unknown>;
    frontmatterLinks?: { link: string }[];
    links: { link: string }[];
  }>([
    ["Calendar/Alpha.md", {
      frontmatter: {
        Date: "2026-08-18",
        End: "2026-08-19",
        "Start Date": "2026-08-18T16:00:00+09:00",
        "End Date": "2026-08-18T17:30:00+09:00",
        "All Day": false,
        Title: "Alpha event",
        Category: "Learning",
        People: ["[[Jane]]"],
        Related: "[[People/Jane]]",
      },
      links: [{ link: "People/Jane" }],
      frontmatterLinks: [{ link: "Jane" }],
    }],
    ["Calendar/Bad.md", { frontmatter: { Date: "2026-99-99" }, links: [] }],
    ["People/Jane.md", { frontmatter: {}, links: [{ link: "Calendar/Alpha" }] }],
  ]);
  const vault = {
    getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
    getFolderByPath: (path: string) => folders.get(path) ?? null,
  };
  const metadataCache = {
    getFileCache: (file: { path: string }) => caches.get(file.path) ?? null,
    getFirstLinkpathDest: (link: string) => {
      const normalized = link.endsWith(".md") ? link : `${link}.md`;
      const file = files.find((candidate) =>
        candidate.path === normalized || candidate.basename === link);
      return file ?? null;
    },
    resolvedLinks: { "People/Jane.md": { "Calendar/Alpha.md": 1 } },
  };
  const profile = createProfile("Calendar");
  profile.id = "calendar";
  profile.editable = true;
  profile.properties = {
    allDay: "All Day",
    category: "Category",
    end: "End",
    endTime: "End Date",
    start: "Date",
    startTime: "Start Date",
    title: "Title",
  };
  return { caches, files, metadataCache, profile, vault };
}

it.each(["disable", "remove", "rebuild"])("discards a pending body read after %s", async (operation) => {
  const f = fixture();
  const file = testFile("Calendar/Alpha.md");
  let deliver!: (value: string) => void;
  const read = new Promise<string>(resolve => { deliver = resolve; });
  const index = new CalendarIndex({ ...f.vault, cachedRead: () => read } as never, f.metadataCache as never, [], true);
  const pending = index.updateBody(file);
  if (operation === "disable") index.setConfiguration([], false);
  else if (operation === "remove") index.remove(file.path);
  else index.rebuild();
  deliver("- Meeting · 2026-09-10");
  await pending;
  expect(index.snapshot().events).toEqual([]);
});

it("keeps the latest body read when an older response arrives after a rebuild", async () => {
  const f = fixture();
  const file = testFile("Calendar/Alpha.md");
  const replies: ((value: string) => void)[] = [];
  const index = new CalendarIndex({ ...f.vault, cachedRead: () => new Promise<string>(resolve => replies.push(resolve)) } as never, f.metadataCache as never, [], true);
  const oldRead = index.updateBody(file);
  index.rebuild();
  const newRead = index.updateBody(file);
  const [older, newer] = replies;
  if (!older || !newer) throw new Error("Both reads must have started");
  newer("- New meeting · 2026-09-11");
  await newRead;
  older("- Old meeting · 2026-09-10");
  await oldRead;
  expect(index.snapshot().events.map(event => event.startDate)).toEqual(["2026-09-11"]);
});

it("refreshes sync inputs from saved notes while metadata is missing or stale", async () => {
  const f = fixture();
  const vault = { ...f.vault, read: async (file: TFile) => file.path.endsWith("Alpha.md")
    ? '---\n{"Date":"2026-09-10","Title":"Freshly saved"}\n---\nBody remains here'
    : '---\n{}\n---\n' };
  const index = new CalendarIndex(vault as never, f.metadataCache as never, [f.profile]);
  index.rebuild();
  f.caches.delete("Calendar/Alpha.md");
  await index.refreshSources([f.profile.id]);
  expect(index.snapshot().events.find(event => event.filePath === "Calendar/Alpha.md")).toMatchObject({ title: "Freshly saved", startDate: "2026-09-10" });
});

function testFile(path: string): TFile {
  const file = new TFile();
  file.path = path;
  file.basename = path.split("/").at(-1)?.replace(/\.md$/, "") ?? "";
  file.extension = "md";
  return file;
}

function folderTree(files: TFile[]): Map<string, TFolder> {
  const folders = new Map<string, TFolder>();
  for (const file of files) {
    const path = file.path.split("/").slice(0, -1).join("/");
    let folder = folders.get(path);
    if (!folder) {
      folder = new TFolder();
      folder.path = path;
      folder.name = path.split("/").at(-1) ?? path;
      folder.children = [];
      folders.set(path, folder);
    }
    file.parent = folder;
    folder.children.push(file);
  }
  return folders;
}

describe("CalendarIndex", () => {
  it("merges body evidence without changing the mapped event or sharing snapshot arrays", async () => {
    const { files, metadataCache, profile, vault } = fixture();
    const evidenceFile = files[2];
    if (!evidenceFile) throw new Error("missing body evidence fixture");
    const index = new CalendarIndex({
      ...vault,
      cachedRead: async () => "- [[Calendar/Alpha|First mention]] · 2026-08-18 → 2026-08-19\n- [[Calendar/Alpha|Second mention]] · 2026-08-18 → 2026-08-19",
    } as never, metadataCache as never, [profile]);
    index.rebuild();
    await index.updateBody(evidenceFile);

    const snapshot = index.snapshot();
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      title: "Alpha event", origin: "profile", editable: true,
      startTime: "2026-08-18T16:00:00+09:00", category: "Learning",
    });
    expect(snapshot.events[0]?.sources.map(source => [source.filePath, source.line])).toEqual([
      ["Calendar/Alpha.md", 0], ["People/Jane.md", 1], ["People/Jane.md", 2],
    ]);
    const expected = structuredClone(snapshot);
    expect(index.snapshot()).toEqual(expected);
    snapshot.events[0]?.sources.pop();
    expect(index.snapshot()).toEqual(expected);
  });

  it("keeps explicit external sync denial independent from edit permission", () => {
    const { caches, metadataCache, profile, vault } = fixture();
    const cached = caches.get("Calendar/Alpha.md");
    if (!cached) throw new Error("missing calendar fixture");
    cached.frontmatter.access = "local-only";
    cached.frontmatter.external_sync = "deny";
    const index = new CalendarIndex(vault as never, metadataCache as never, [profile]);
    index.rebuild();
    expect(index.snapshot().events[0]).toMatchObject({ editable: true, externalSync: "deny" });
  });

  it("indexes mapped properties, links, and diagnostics once", () => {
    const { metadataCache, profile, vault } = fixture();
    const index = new CalendarIndex(vault as never, metadataCache as never, [profile]);
    index.rebuild();
    const snapshot = index.snapshot();
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      title: "Alpha event",
      startDate: "2026-08-18",
      endDate: "2026-08-19",
      category: "Learning",
      editable: true,
      allDay: false,
      startTime: "2026-08-18T16:00:00+09:00",
      endTime: "2026-08-18T17:30:00+09:00",
    });
    expect(snapshot.diagnostics).toEqual([
      { code: "invalid-date", filePath: "Calendar/Bad.md", profileId: "calendar" },
    ]);
    expect(index.sourceHealth("calendar")).toEqual({
      invalid: 1,
      missing: 0,
      total: 2,
      valid: 1,
    });
  });

  it("updates and removes one file without rescanning source folders", () => {
    const { files, metadataCache, profile, vault } = fixture();
    let scans = 0;
    const getFolderByPath = vault.getFolderByPath;
    vault.getFolderByPath = (path: string) => {
      scans += 1;
      return getFolderByPath(path);
    };
    const index = new CalendarIndex(vault as never, metadataCache as never, [profile]);
    index.rebuild();
    expect(scans).toBe(1);
    index.update(files[0] as never);
    index.remove(files[1]?.path ?? "");
    expect(scans).toBe(1);
    expect(index.snapshot().diagnostics).toHaveLength(0);
  });

  it("uses the frontmatter written by a mutation before MetadataCache catches up", () => {
    const { files, metadataCache, profile, vault } = fixture();
    const index = new CalendarIndex(vault as never, metadataCache as never, [profile]);
    index.rebuild();

    index.update(files[0] as never, {
      Date: "2026-08-25",
      Title: "Moved immediately",
    });

    expect(index.snapshot().events[0]).toMatchObject({
      startDate: "2026-08-25",
      title: "Moved immediately",
    });
  });

  it("matches a tag-constrained source with mutation frontmatter", () => {
    const { files, metadataCache, profile, vault } = fixture();
    profile.tag = "calendar";
    const index = new CalendarIndex(vault as never, metadataCache as never, [profile]);

    index.update(files[0] as never, { Date: "2026-08-18", tags: ["calendar"] });

    expect(index.snapshot().events).toHaveLength(1);
  });

  it("rejects invalid explicit ends and spans longer than 370 days", () => {
    const { caches, files, metadataCache, profile, vault } = fixture();
    const added = [
      testFile("Calendar/Backward.md"),
      testFile("Calendar/Invalid-end.md"),
      testFile("Calendar/Too-long.md"),
    ];
    files.push(...added);
    const folder = vault.getFolderByPath("Calendar");
    if (!folder) throw new Error("Calendar fixture folder is missing");
    for (const file of added) {
      file.parent = folder;
      folder.children.push(file);
    }
    caches.set("Calendar/Backward.md", {
      frontmatter: { Date: "2026-08-18", End: "2026-08-17" },
      links: [],
    });
    caches.set("Calendar/Invalid-end.md", {
      frontmatter: { Date: "2026-08-18", End: "invalid" },
      links: [],
    });
    caches.set("Calendar/Too-long.md", {
      frontmatter: { Date: "2026-01-01", End: "2027-01-06" },
      links: [],
    });
    const index = new CalendarIndex(vault as never, metadataCache as never, [profile]);

    index.rebuild();

    expect(index.snapshot().diagnostics).toEqual(expect.arrayContaining([
      { code: "end-before-start", filePath: "Calendar/Backward.md", profileId: "calendar" },
      { code: "invalid-end", filePath: "Calendar/Invalid-end.md", profileId: "calendar" },
      { code: "event-too-long", filePath: "Calendar/Too-long.md", profileId: "calendar" },
    ]));
    expect(index.snapshot().events.map((item) => item.filePath)).not.toContain("Calendar/Invalid-end.md");
    expect(index.snapshot().events.map((item) => item.filePath)).not.toContain("Calendar/Too-long.md");
  });

  it("merges repeated body timeline links and keeps frontmatter automatic dates out", async () => {
    const target = testFile("Career/Application.md");
    const person = testFile("People/Minjeong.md");
    const project = testFile("Projects/Kubernetes.md");
    const archived = testFile("_sources/Legacy.md");
    const files = [target, person, project, archived];
    const caches = new Map<string, { frontmatter: Record<string, unknown>; links: { link: string }[] }>([
      [target.path, {
        frontmatter: {
          ended_on: "2026-08-27",
          started_on: "2026-08-02",
          title: "KRAFTON AI Engineer intern application",
        },
        links: [],
      }],
      [person.path, { frontmatter: {}, links: [{ link: "Career/Application" }] }],
      [project.path, { frontmatter: {}, links: [{ link: "Career/Application" }] }],
      [archived.path, { frontmatter: {}, links: [{ link: "Career/Application" }] }],
    ]);
    const bodies = new Map<string, string>([
      [target.path, "---\nstarted_on: 2026-08-02\nended_on: 2026-08-27\ncreated: 2026-08-01\n---\n# Application"],
      [person.path, "- [[Career/Application|KRAFTON application]] · 2026-08-02 09:00 → 2026-08-27 18:00"],
      [project.path, "- [[Career/Application]] · 2026-08-02 09:00 → 2026-08-27 18:00"],
      [archived.path, "- [[Career/Application]] · 2026-08-02 → 2026-08-27"],
    ]);
    const vault = {
      cachedRead: async (file: TFile) => bodies.get(file.path) ?? "",
      getFolderByPath: () => null,
      getMarkdownFiles: () => files,
    };
    const metadataCache = {
      getFileCache: (file: TFile) => caches.get(file.path) ?? null,
      getFirstLinkpathDest: (link: string) => {
        const normalized = link.endsWith(".md") ? link : `${link}.md`;
        return files.find((file) => file.path === normalized) ?? null;
      },
    };
    const index = new CalendarIndex(vault as never, metadataCache as never, [], true);

    index.rebuild();
    await index.rebuildBodies();

    const periods = index.snapshot().events.filter((event) => event.kind === "period");
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({
      filePath: "Career/Application.md",
      origin: "body",
      startDate: "2026-08-02",
      startTime: "09:00",
      endDate: "2026-08-27",
      endTime: "18:00",
      title: "KRAFTON AI Engineer intern application",
    });
    expect(periods[0]?.sources.map((source) => source.filePath)).toEqual([
      "People/Minjeong.md",
      "Projects/Kubernetes.md",
    ]);
  });

  it("does not promote an archived link target to the canonical timeline note", async () => {
    const active = testFile("History/Event.md");
    const archived = testFile("wiki/private/_sources/Raw.md");
    const files = [active, archived];
    const bodies = new Map<string, string>([
      [active.path, "- 2026-09-01 · [[wiki/private/_sources/Raw|raw evidence]]"],
      [archived.path, "- 2026-09-01 · source"],
    ]);
    const vault = {
      cachedRead: async (file: TFile) => bodies.get(file.path) ?? "",
      getFolderByPath: () => null,
      getMarkdownFiles: () => files,
    };
    const metadataCache = {
      getFileCache: () => ({ frontmatter: {} }),
      getFirstLinkpathDest: () => archived,
    };
    const index = new CalendarIndex(vault as never, metadataCache as never, [], true);

    index.rebuild();
    await index.rebuildBodies();

    expect(index.snapshot().events).toEqual([
      expect.objectContaining({
        filePath: "History/Event.md",
        kind: "history",
        title: "Event",
      }),
    ]);
  });
});

describe("source detection", () => {
  it("inspects only the selected folder and ranks valid date properties", () => {
    const { caches, metadataCache, vault } = fixture();
    const alpha = caches.get("Calendar/Alpha.md");
    const bad = caches.get("Calendar/Bad.md");
    if (!alpha || !bad) throw new Error("Calendar fixture caches are missing");
    alpha.frontmatter.Modified = "2026-08-20";
    bad.frontmatter.Modified = "2026-08-21";

    const detection = detectSourceFolder(vault as never, metadataCache as never, "Calendar", true);

    expect(detection.noteCount).toBe(2);
    expect(detection.datedNoteCount).toBe(1);
    expect(detection.dateProperties[0]).toEqual({ count: 1, name: "Date" });
    expect(detection.dateProperties).toContainEqual({ count: 2, name: "Modified" });
    expect(detection.suggestedStart).toBe("Date");
  });

  it("reports valid, missing, and invalid configured dates per source", () => {
    const { metadataCache, profile, vault } = fixture();
    const health = inspectSourceHealth(vault as never, metadataCache as never, profile);
    expect(health).toEqual({ invalid: 1, missing: 0, total: 2, valid: 1 });
  });

  it("does not scan unrelated folders while detecting a source", () => {
    const { metadataCache, vault } = fixture();

    const detection = detectSourceFolder(vault as never, metadataCache as never, "People", true);

    expect(detection.noteCount).toBe(1);
    expect(detection.datedNoteCount).toBe(0);
    expect(detection.suggestedStart).toBe("");
  });
});

describe("profile matching", () => {
  it("supports folder and tag constraints", () => {
    const profile = createProfile("Calendar");
    profile.tag = "work";
    expect(matchesProfile(
      { path: "Calendar/A.md" },
      { tags: [{ tag: "#work", position: {} as never }] },
      profile,
    )).toBe(true);
    expect(matchesProfile({ path: "Archive/A.md" }, { tags: [{ tag: "#work", position: {} as never }] }, profile)).toBe(false);
  });

  it("does not treat a root note with the folder name as part of the folder", () => {
    const profile = createProfile("Calendar");
    expect(matchesProfile({ path: "Calendar.md" }, { frontmatter: {} }, profile)).toBe(false);
    expect(matchesProfile({ path: "Calendar/A.md" }, { frontmatter: {} }, profile)).toBe(true);
  });

  it("maps property names case-insensitively", () => {
    expect(readField({ "Start Date": "2026-08-18" }, "start date")).toBe("2026-08-18");
  });

  it("prefers the most specific source and read-only on an exact overlap", () => {
    const broad = createProfile("inbox");
    broad.id = "broad";
    const generated = createProfile("Generated/Calendar");
    generated.id = "generated";
    generated.editable = false;
    const conflicting = createProfile("Generated/Calendar");
    conflicting.id = "writable-conflict";
    conflicting.editable = true;

    expect(selectProfile(
      { path: "Generated/Calendar/A.md" },
      { frontmatter: {} },
      [broad, conflicting, generated],
    )?.id).toBe("generated");
  });

  it("rechecks generated frontmatter against overlapping sources before creation", () => {
    const writable = createProfile("Calendar");
    writable.id = "writable";
    writable.editable = true;
    const readOnly = createProfile("Calendar");
    readOnly.id = "read-only";
    readOnly.editable = false;
    const frontmatter = eventFrontmatter(writable, {
      category: "Learning",
      date: "2026-08-18",
      title: "Program orientation",
    });
    const selected = selectProfileFromFrontmatter(
      { path: "Calendar/2026-08-18 Program orientation.md" },
      frontmatter,
      [writable, readOnly],
    );

    expect(selected?.id).toBe("read-only");
    expect(canCreateWithProfile(writable, selected)).toBe(false);
  });

  it("uses current frontmatter only for mutation ownership", () => {
    const profile = createProfile("Calendar");
    profile.tag = "calendar";

    expect(selectProfileFromFrontmatter(
      { path: "Calendar/Event.md" },
      { date: "2026-08-18", tags: [] },
      [profile],
    )).toBeUndefined();
  });

  it("keeps inline-tag-only matches read-only", () => {
    const { files, metadataCache, profile, vault } = fixture();
    profile.tag = "calendar";
    metadataCache.getFileCache = (file: { path: string }) => file.path === "Calendar/Alpha.md"
      ? {
          frontmatter: { Date: "2026-08-18" },
          links: [],
          tags: [{ tag: "#calendar" }],
        }
      : null;
    const index = new CalendarIndex(vault as never, metadataCache as never, [profile]);

    index.update(files[0] as never);

    expect(index.snapshot().events[0]?.editable).toBe(false);
  });
});
