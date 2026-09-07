# Roadmap

Link Calendar Navigator remains a focused navigator over dated Markdown. The original note is canonical; the local calendar index has no second database, telemetry, or remote AI. Google Calendar is an optional, default-off projection for reminders rather than a new source of truth.

## Current

- Zero-setup, Vault-wide indexing of explicit Markdown body events, periods, history entries, and deadlines.
- Optional configured sources for deliberately mapped frontmatter date properties.
- Canonical-target temporal deduplication with source-note provenance.
- Synced month and selected-day navigation, direct note links, keyboard access, and responsive panes.
- Optional folder profiles with recognition preview, read-only defaults, conflict-checked writes, and one-step Undo.
- Opt-in, manual, one-way synchronization from selected folder profiles to an app-created Google calendar.
- Least-privilege OAuth with PKCE, Obsidian SecretStorage, deterministic upserts, ETag conflict stops, and no inferred remote deletion.

## Next candidates

- Improve diagnostics for mixed date formats without guessing or rewriting values.
- Test more third-party theme and accessibility combinations.
- Extend deterministic date-form diagnostics without adding heuristic guessing.
- Evaluate two-way synchronization only after identity, deletion, recurrence, offline conflict, and background-delivery contracts are separately proven.

## Out of scope

- Replacing Google Calendar or another shared calendar.
- Reading or mutating the primary calendar, unrelated calendars, guests, invitations, or scheduling availability.
- Claiming continuous background sync while Obsidian is closed.
- Automatic note rewriting, remote AI, telemetry, or a second event database.

Use [Issues](https://github.com/woonyong-kr/obsidian-link-calendar-navigator/issues/new/choose) for reproducible bugs and use cases. Broader questions belong in [Discussions](https://github.com/woonyong-kr/obsidian-link-calendar-navigator/discussions).
