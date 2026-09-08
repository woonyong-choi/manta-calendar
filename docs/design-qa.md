# Link Calendar Navigator design QA

> Historical review below predates the current onboarding, selection, and connection-recovery changes. It is not acceptance evidence for the current candidate.

## Historical evidence

- Dark public-safe fixture, now stored at 1600×900: `docs/media/link-calendar-overview.png`
- Light public-safe fixture, now stored at 1600×900: `docs/media/link-calendar-agenda.png`
- Obsidian 1.13.7 dark runtime at 1115×768 with 2026-08-29 selected
- Obsidian 1.13.7 public demo onboarding: selecting `Calendar` found 7 Markdown documents, detected `date`, and previewed the exact 5 documents that would appear before saving the read-only source
- Local-only 2480×565 side-by-side comparison with the supplied 1487×1059 product reference
- Keyboard focus, `Escape` restoration, month-grid ARIA semantics, narrow drawer, reduced motion, high contrast, and forced colours through DOM and CSS tests

## Fidelity review

| Surface | Result | Evidence |
|---|---|---|
| Information hierarchy | passed | Month grid stays dominant; the selected date opens one adjacent time-ordered agenda. |
| Typography and density | passed | Dates, times, titles, and direct note links are the only event text. |
| Shape and separation | passed | Calendar weeks and agenda entries use hairlines; event cards, chips, badges, shadows, and selected-event panels are absent. |
| Colour and state | passed | Quiet kind accents distinguish event-title rows while today and the selected date retain the host accent. |
| Canonical navigation | passed | Each agenda title is the familiar underlined internal link itself; activation opens the original Markdown note without a separate icon action. |
| Guided source setup | passed | Folder selection opens a preview before any source is saved, offers four document presets, detects date-property candidates with counts, and defaults every new source to read-only. |
| Return to today | passed | A visible `Today` action and the command-palette action both return to the current month and focus the current date. |
| Responsive layout | passed | The agenda remains adjacent at wide widths and becomes a bounded overlay only when the host pane cannot preserve both surfaces. |
| Light and dark themes | passed | Both captures retain divider visibility, readable muted text, and the same hierarchy without plugin-owned card colours. |

## Removed UI

- Note body preview
- Metadata property sheet
- Backlinks and linked-note browser
- People, project, and related-note facets
- Connected-note badges
- Duplicated event detail card

## Iterations

1. Rejected coloured month cards and the duplicated selected-event detail panel.
2. Replaced ambiguous dots with up to three one-line titles and a readable overflow row.
3. Replaced agenda cards with `time → canonical note link` rows and moved all times to compact 24-hour ranges.
4. Removed the ambiguous arrow icon and made the visible agenda title the direct internal link.

Historical review result: passed. Current candidate runtime: not verified.


## Current candidate runtime smoke

Use the separate public test Vault. Copy the empty-state dated example into a test note, select its day and open the original note. Confirm today and selected day remain distinguishable. Navigate with keyboard, close the agenda with Escape and verify restored focus. Check light/dark and a narrow sidebar. Test connection waiting, callback, cancellation and expiration with a configured OAuth relay before claiming recovery. Capture fresh images and update release-media only after observing those states. DOM fixtures and configuration-enabled status do not prove runtime load.
