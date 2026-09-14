# Manta Calendar design contract

## Product boundary

Manta Calendar is a derived navigation surface over canonical Markdown.

- It derives a read-only timeline from explicit Markdown body date forms across active Vault notes.
- Explicit body entries may include 24-hour wall-clock times; display format is a presentation preference and never converts the authored clock value.
- It reads bodies only for local date extraction; it does not copy bodies or create relationship, layout, or event databases.
- Hidden, archive, backup, retired, and source-reference paths do not participate in the automatic index.
- Optional source profiles are the only path for custom frontmatter property mappings and explicitly guarded writes.
- One timeline identity is canonical target, start date, end date, and temporal kind. Matching sources are merged.
- Every agenda result exposes a direct action to the canonical note.
- Manta Calendar owns presentation state only: visible month, selected date, search query, source filter, and open/closed agenda.

## Information hierarchy

1. Month and navigation controls.
2. Seven-column month grid.
3. Selected-date agenda.
4. Direct canonical note link and compact provenance links.
5. Collapsed diagnostics only when invalid configured-source notes exist.

The agenda may show only the canonical note and the unique notes that supplied the same temporal identity. It must not become a note preview, property inspector, general backlink browser, people directory, project browser, or second knowledge graph.

## Visual rules

- Match the published Wiki code-block canvas: `#ffffff` in light mode and `#0d1117` in dark mode; panels use the same canvas. Forced colors use system Canvas.
- Use Obsidian semantic variables for text, borders, accent, focus, type, radius, motion, and contrast.
- Use quiet kind accents on compact event-title rows; category never changes the month hierarchy.
- Keep month cells free of cards; reveal up to three single-line titles with ellipsis and one readable overflow row.
- Present the agenda as a typographic timeline: time, temporal kind, canonical title, then compact provenance.
- Use icons for icon-only actions, with accessible names and tooltips.
- Keep touch/click targets at the shared control height.
- On narrower desktop panes, float the agenda as a bounded drawer; on the narrowest panes, anchor it to the bottom.
- Respect reduced motion and forced colors.

## Interaction rules

- Selecting a day opens its agenda even when it is empty.
- Selecting an event title opens the agenda for that date.
- Selecting the direct note link opens the Markdown note.
- Selecting a provenance source opens that mentioning Markdown note.
- `Cmd/Ctrl + Enter` opens a focused event title's note directly.
- Arrow keys move the selected day. `Enter` and `Space` open its agenda.
- `Escape` closes the agenda and restores focus.

## Release gates

- TypeScript, lint, unused-code, unit, DOM, visual-fixture, production-build, and release checks pass.
- The generated CSS contains no removed preview, property-sheet, or relation UI.
- Dark and light Obsidian runtime checks confirm hierarchy, contrast, focus, resizing, and direct note navigation.
- The installed bundle hash and enabled plugin state match the release assets.
