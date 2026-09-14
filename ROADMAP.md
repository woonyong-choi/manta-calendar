# Roadmap

Manta Calendar remains a focused navigator over dated Markdown. The original note is canonical; the local calendar index has no second database, telemetry, or remote AI. Google Calendar is optional and off by default. An explicitly selected writable folder can receive changes from the dedicated Google calendar; automatic body-date indexing stays read-only.

## Available

- Zero-setup, Vault-wide indexing of explicit Markdown body events, periods, history entries, and deadlines.
- Optional configured sources for deliberately mapped frontmatter date properties.
- Canonical-target temporal deduplication with source-note provenance.
- Synced month and selected-day navigation, direct note links, keyboard access, and responsive panes.
- Optional folder profiles with recognition preview, read-only defaults, conflict-checked writes, and one-step Undo.
- Opt-in manual synchronization with an app-created Google calendar: selected folder profiles send mapped events; choosing a writable two-way destination also imports new non-recurring events and mapped edits.
- Least-privilege OAuth with PKCE, Obsidian SecretStorage, deterministic upserts, ETag conflict stops, and no inferred remote deletion.

## In progress

- Review first-open discoverability and narrow-panel navigation, informed by an [external Android first-open report](https://github.com/liamcain/obsidian-calendar-plugin/issues/312). This is a comparison scenario, not a confirmed defect here.

## Under consideration

- Improve diagnostics for mixed date formats without guessing or rewriting values.
- Test more third-party theme and accessibility combinations.
- Broader recurrence support only after identity and conflict behavior is specified; current sync does not import recurrence or propagate deletions.

## Next: dates, permissions and recovery

Date formats, time zones and all-day boundaries should remain explicit. Improve the first empty month, source mapping preview, narrow day panels and sync conflict explanations. A planned external AI tool should propose date changes before applying the same permission, revision and sync checks as the UI.

Align type sizes, spacing, neutral surfaces, keyboard focus and status wording with the other Manta tools. Keep this plugin useful on its own. Measure first-use completion, manual corrections, recovery and repeat use against the same public inputs before claiming an improvement. These are planned changes.

[Shared product direction and release criteria](https://github.com/woonyong-choi/manta-diagrams/blob/main/docs/product-direction.md)

## Out of scope

- Replacing Google Calendar or another shared calendar.
- Reading or mutating the primary calendar, unrelated calendars, guests, invitations, or scheduling availability.
- Claiming continuous background sync while Obsidian is closed.
- Unrequested note rewriting, remote AI, telemetry, or a second event database.
- Propagating deletions or overwriting simultaneous edits during Google sync.

Use [Issues](https://github.com/woonyong-choi/manta-calendar/issues/new/choose) for reproducible bugs and use cases. Broader questions belong in [Discussions](https://github.com/woonyong-choi/manta-calendar/discussions).
