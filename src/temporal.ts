import {
  type TemporalKind,
  type TemporalSource,
  dateKey,
  fileTitle,
  localDateKey,
} from "./model";

export interface TemporalCandidate {
  category: string;
  endDate: string;
  endTime: string;
  kind: TemporalKind;
  linkPath: string;
  ongoing: boolean;
  origin: "body";
  source: TemporalSource;
  startDate: string;
  startTime: string;
  title: string;
}

const DATE_VALUE = "\\d{4}-\\d{2}-\\d{2}";
const TIME_VALUE = "(?:[01]\\d|2[0-3]):[0-5]\\d";
const RANGE_PATTERN = new RegExp(
  `(?<startDate>${DATE_VALUE})(?:[ T](?<startTime>${TIME_VALUE}))?\\s*`
    + `(?:→|->|–|—|~)\\s*(?<endValue>${DATE_VALUE}|진행\\s*중|present|ongoing)`
    + `(?:[ T](?<endTime>${TIME_VALUE}))?`,
  "iu",
);
const SCHEDULE_PATTERN = new RegExp(
  `(?<startDate>${DATE_VALUE})(?:[ T](?<startTime>${TIME_VALUE})`
    + `(?:\\s*(?:-|–|—|→)\\s*(?<endTime>${TIME_VALUE}))?)?`
    + `\\s*(?<kind>예정|마감|scheduled|deadline)`,
  "iu",
);
const ANY_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/gu;
const FOLLOWING_TIME_PATTERN = new RegExp(
  `^(?:T|\\s+)(?<startTime>${TIME_VALUE})`
    + `(?:\\s*(?:-|–|—|→)\\s*(?<endTime>${TIME_VALUE}))?`,
  "u",
);
const TIME_LIKE_PATTERN = /^(?:T|\s+)\d{1,2}:\d{2}/u;
const SCHEDULE_WORD_PATTERN = /(?:예정|마감|scheduled|deadline)/iu;
const WIKI_LINK_PATTERN = /\[\[([^|\]#]+)(?:#[^|\]]*)?(?:\|([^\]]+))?\]\]/u;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+\.md)(?:#[^)]*)?\)/iu;

export function extractMarkdownTemporal(
  filePath: string,
  basename: string,
  markdown: string,
  today = localDateKey(new Date()),
): TemporalCandidate[] {
  const candidates: TemporalCandidate[] = [];
  let inFrontmatter = markdown.startsWith("---");
  let fence: { marker: string; length: number } | null = null;
  let inComment = false;
  const lines = markdown.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const trimmed = rawLine.trim();
    if (inFrontmatter) {
      if (index > 0 && trimmed === "---") inFrontmatter = false;
      continue;
    }
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(rawLine);
    if (fence) {
      if (delimiter && delimiter[1]?.[0] === fence.marker
        && delimiter[1].length >= fence.length && !delimiter[2]?.trim()) fence = null;
      continue;
    }
    if (delimiter && !(delimiter[1]?.[0] === "`" && delimiter[2]?.includes("`"))) {
      fence = { marker: delimiter[1]?.[0] ?? "`", length: delimiter[1]?.length ?? 3 };
      continue;
    }
    if (trimmed.startsWith(">")) continue;
    let line = rawLine;
    if (inComment) {
      const end = line.indexOf("-->");
      if (end < 0) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    const commentStart = line.indexOf("<!--");
    if (commentStart >= 0) {
      const commentEnd = line.indexOf("-->", commentStart + 4);
      if (commentEnd < 0) {
        line = line.slice(0, commentStart);
        inComment = true;
      } else {
        line = line.slice(0, commentStart) + line.slice(commentEnd + 3);
      }
    }
    line = stripIgnoredInline(line);
    const range = RANGE_PATTERN.exec(line);
    if (range) {
      const startDate = dateKey(range.groups?.startDate);
      const parsedEnd = dateKey(range.groups?.endValue);
      if (!startDate) continue;
      const ongoing = !parsedEnd && isOngoing(range.groups?.endValue);
      const endDate = parsedEnd ?? (ongoing ? today : startDate);
      if (endDate < startDate) continue;
      const startTime = range.groups?.startTime ?? "";
      const endTime = parsedEnd ? range.groups?.endTime ?? "" : "";
      if (!validTimeOrder(startDate, endDate, startTime, endTime)) continue;
      candidates.push(bodyCandidate(filePath, basename, line, index + 1, {
        endDate,
        endTime,
        kind: "period",
        ongoing,
        startDate,
        startTime,
      }));
      continue;
    }
    const scheduled = SCHEDULE_PATTERN.exec(line);
    if (scheduled) {
      const startDate = dateKey(scheduled.groups?.startDate);
      if (!startDate) continue;
      const startTime = scheduled.groups?.startTime ?? "";
      const endTime = scheduled.groups?.endTime ?? "";
      if (!validTimeOrder(startDate, startDate, startTime, endTime)) continue;
      const kind = /마감|deadline/iu.test(scheduled.groups?.kind ?? "") ? "deadline" : "event";
      candidates.push(bodyCandidate(filePath, basename, line, index + 1, {
        endDate: startDate,
        endTime,
        kind,
        ongoing: false,
        startDate,
        startTime,
      }));
      continue;
    }
    if (SCHEDULE_WORD_PATTERN.test(line)) continue;
    if (!/^\s*[-*+]\s/u.test(line)) continue;
    for (const match of line.matchAll(ANY_DATE_PATTERN)) {
      const startDate = dateKey(match[0]);
      if (!startDate) continue;
      const tail = line.slice(match.index + match[0].length);
      const following = FOLLOWING_TIME_PATTERN.exec(tail);
      if (!following && TIME_LIKE_PATTERN.test(tail)) continue;
      const startTime = following?.groups?.startTime ?? "";
      const endTime = following?.groups?.endTime ?? "";
      if (!validTimeOrder(startDate, startDate, startTime, endTime)) continue;
      candidates.push(bodyCandidate(filePath, basename, line, index + 1, {
        endDate: startDate,
        endTime,
        kind: "history",
        ongoing: false,
        startDate,
        startTime,
      }));
    }
  }
  return distinctCandidates(candidates);
}

function bodyCandidate(
  filePath: string,
  basename: string,
  line: string,
  lineNumber: number,
  dates: Pick<
    TemporalCandidate,
    "endDate" | "endTime" | "kind" | "ongoing" | "startDate" | "startTime"
  >,
): TemporalCandidate {
  const link = linkedDocument(line);
  return {
    category: "",
    endDate: dates.endDate,
    endTime: dates.endTime,
    kind: dates.kind,
    linkPath: link.path,
    ongoing: dates.ongoing,
    origin: "body",
    source: temporalSource(filePath, lineNumber, compactExcerpt(line)),
    startDate: dates.startDate,
    startTime: dates.startTime,
    title: link.label || fileTitle(link.path) || basename,
  };
}

function validTimeOrder(
  startDate: string,
  endDate: string,
  startTime: string,
  endTime: string,
): boolean {
  if (!startTime) return !endTime;
  return !endTime || endDate > startDate || endTime >= startTime;
}

function linkedDocument(line: string): { label: string; path: string } {
  const wiki = WIKI_LINK_PATTERN.exec(line);
  if (wiki) {
    const path = wiki[1]?.trim() ?? "";
    return { label: wiki[2]?.trim() || fileTitle(path), path };
  }
  const markdown = MARKDOWN_LINK_PATTERN.exec(line);
  if (markdown) {
    return {
      label: markdown[1]?.trim() ?? "",
      path: decodeURIComponent((markdown[2] ?? "").trim()),
    };
  }
  return { label: "", path: "" };
}

function stripIgnoredInline(line: string): string {
  return line
    .replace(/`[^`]*`/gu, "")
    .replace(/https?:\/\/\S+/giu, "");
}

function temporalSource(filePath: string, line: number, excerpt: string): TemporalSource {
  return { excerpt: excerpt.trim(), filePath, line };
}

function compactExcerpt(line: string): string {
  return line.trim().replace(/^[-*+]\s+/u, "").slice(0, 240);
}

function isOngoing(value: unknown): boolean {
  return typeof value === "string" && /^(진행\s*중|present|ongoing)$/iu.test(value.trim());
}

function distinctCandidates(candidates: TemporalCandidate[]): TemporalCandidate[] {
  const result = new Map<string, TemporalCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.linkPath,
      candidate.source.filePath,
      candidate.source.line,
      candidate.startDate,
      candidate.endDate,
      candidate.kind,
      candidate.title,
    ].join("\u0000");
    if (!result.has(key)) result.set(key, candidate);
  }
  return [...result.values()];
}
