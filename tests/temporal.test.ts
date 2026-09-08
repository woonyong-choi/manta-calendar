import { describe, expect, it } from "vitest";

import { extractMarkdownTemporal } from "../src/temporal";

describe("automatic temporal extraction", () => {
  it("extracts structured body dates while ignoring frontmatter, code, quotes, and URLs", () => {
    const candidates = extractMarkdownTemporal(
      "People/Minjeong.md",
      "Minjeong",
      `---
updated: 2026-08-30
---
## 날짜별 이력

- 2026-08-04 → 2026-08-17 · [[Projects/Kubernetes|Kubernetes 장애 복구]]
- 2026-08-24 → 진행 중 · [[Interview/Data Foundation]]
- 2026-09-02 예정 · [[Calendar/Final interview|최종 면접 동행]]
- 2026-09-10 마감 · [[Career/Application]]
- 2026-08-25 · 결과 확인

\`2026-01-01\`
> 2026-02-02 인용
https://example.com/2026-03-03
\`\`\`
2026-04-04
\`\`\`
<!-- 2026-05-05 -->`,
      "2026-09-01",
    );

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "period",
        linkPath: "Projects/Kubernetes",
        startDate: "2026-08-04",
        endDate: "2026-08-17",
      }),
      expect.objectContaining({
        kind: "period",
        ongoing: true,
        startDate: "2026-08-24",
        endDate: "2026-09-01",
      }),
      expect.objectContaining({ kind: "event", startDate: "2026-09-02" }),
      expect.objectContaining({ kind: "deadline", startDate: "2026-09-10" }),
      expect.objectContaining({ kind: "history", startDate: "2026-08-25" }),
    ]));
    expect(candidates.map((candidate) => candidate.startDate)).not.toEqual(expect.arrayContaining([
      "2026-01-01",
      "2026-02-02",
      "2026-03-03",
      "2026-04-04",
      "2026-05-05",
      "2026-08-30",
    ]));
  });

  it("ignores maintenance frontmatter and arbitrary prose dates", () => {
    const candidates = extractMarkdownTemporal(
      "Notes/Decision.md",
      "Decision",
      "---\ncreated: 2026-08-24\nupdated: 2026-08-25\n---\n2026-08-26에 원본을 다시 검토했다.",
    );

    expect(candidates).toEqual([]);
  });

  it("preserves explicit wall-clock time ranges in body timeline entries", () => {
    const candidates = extractMarkdownTemporal(
      "Calendar/Timeline.md",
      "Timeline",
      [
        "- 2026-09-15 14:00–15:00 예정 · [[Meetings/Design review]]",
        "- 2026-09-16 09:30 마감 · [[Career/Application]]",
        "- 2026-09-17T16:00 → 2026-09-18T17:30 · [[Projects/Release]]",
        "- 2026-09-19 08:15 · [[Health/Run]]",
      ].join("\n"),
    );

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "event",
        startDate: "2026-09-15",
        startTime: "14:00",
        endTime: "15:00",
      }),
      expect.objectContaining({
        kind: "deadline",
        startDate: "2026-09-16",
        startTime: "09:30",
        endTime: "",
      }),
      expect.objectContaining({
        kind: "period",
        startDate: "2026-09-17",
        startTime: "16:00",
        endDate: "2026-09-18",
        endTime: "17:30",
      }),
      expect.objectContaining({
        kind: "history",
        startDate: "2026-09-19",
        startTime: "08:15",
        endTime: "",
      }),
    ]));
  });

  it("rejects invalid, reversed, or end-only body times without changing date-only entries", () => {
    const candidates = extractMarkdownTemporal(
      "Calendar/Invalid.md",
      "Invalid",
      [
        "- 2026-09-20 25:00 예정 · [[Invalid hour]]",
        "- 2026-09-21 15:00–14:00 예정 · [[Reversed meeting]]",
        "- 2026-09-22 → 2026-09-22 17:00 · [[End only]]",
        "- 2026-09-23 예정 · [[Date only]]",
      ].join("\n"),
    );

    expect(candidates).toEqual([
      expect.objectContaining({ startDate: "2026-09-23", startTime: "", endTime: "" }),
    ]);
  });
});

for (const [opening, inner, closing] of [["````markdown", "```", "````"], ["~~~md", "```", "~~~"], ["````", "```", ""]]) {
  it(`keeps nested fences inside ${String(opening)} out of the calendar`, () => {
    const markdown = [opening, inner, "- 2026-09-08 [[Example]]", inner, closing].join("\n");
    expect(extractMarkdownTemporal("Test.md", "Test", markdown)).toEqual([]);
  });
}
it("resumes dates after a valid closing fence", () => {
  expect(extractMarkdownTemporal("Test.md", "Test", ["````md", "```", "`````", "- 2026-09-09 Visible"].join("\n"))).toHaveLength(1);
});
