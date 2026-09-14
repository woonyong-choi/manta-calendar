# Privacy policy

Last updated: 2026-09-14 · Applies to version 4.0.0 and later.

For version 3.x, see the [previous privacy policy](https://github.com/woonyong-choi/manta-calendar/blob/3.6.6/PRIVACY.md).

Manta Calendar is an open-source Obsidian plugin. Its calendar index runs locally by default. Google Calendar integration is optional and disabled until a user explicitly enables and connects it.

## Google user data accessed

The integration requests only `https://www.googleapis.com/auth/calendar.app.created`. This permission lets the plugin create a dedicated **Link Calendar** secondary calendar and create, read, or update events in calendars created by this application. It does not grant access to a user's primary calendar or unrelated calendars.

Notes with `external_sync: deny` are excluded even when their source is selected for sync. Existing mappings and previously created remote events are preserved when sending a note is prohibited. Read-only editing and `access: local-only` do not prohibit a sync explicitly enabled through source selection.

During an explicit sync, the plugin sends only the title, start, and end of events from folder sources the user selected. It also writes private ownership identifiers used to make retries deterministic and prevent cross-event overwrites. Note bodies, unrelated notes, guests, contacts, and existing calendar events are not sent.

## Storage and sharing

When two-way synchronization is explicitly enabled, the plugin reads events from the dedicated calendar and stores supported event titles, dates and times in the selected writable Obsidian source. Imported notes include calendar and event IDs to recover interrupted imports without duplication. Existing note bodies and unrelated properties are preserved; Google descriptions, attendees and reminders are not imported into notes. This does not expand the OAuth permission or grant access to primary or unrelated calendars.

- The Google refresh token is stored locally with Obsidian `SecretStorage`.
- Calendar mapping identifiers and sync fingerprints are stored in the plugin's local settings.
- Access tokens are held in memory only.
- The default browser returns a one-use authorization code to a temporary listener on the same computer (`127.0.0.1`). The listener accepts only the matching connection and closes after completion, cancellation, or ten minutes.
- Code exchange, token refresh, and revocation go directly from Obsidian to Google. No maintainer domain, Cloudflare Worker, or Manta service receives the code or tokens.
- Google event data goes directly between the user's Obsidian app and Google Calendar.
- No Google user data is sold, used for advertising, shared with data brokers, or used to train AI models.
- The plugin does not use analytics or telemetry.

Google processes data under its own terms and privacy policy when the user chooses this integration.

## Retention and deletion

Disconnecting in plugin settings asks Google to revoke the grant, then removes the direct connection's locally stored token and mappings. If revocation fails, the connection is retained so the user can retry. Google revocation applies across clients in the same Google Cloud project and can require other installations to reconnect. Events already written to the dedicated Google calendar remain under the user's control; the plugin never treats local deletion as permission to delete a remote event. Users can delete the dedicated calendar in Google Calendar at any time.

Upgrading from 3.x requires a new direct sign-in. Version 4 never reads or sends the old relay token. The obsolete secret is left in Obsidian SecretStorage for rollback; uninstalling plugin files does not establish that Obsidian has erased secrets. Users can manage saved secrets in Obsidian and revoke access in their Google Account. Existing calendar mappings and notes remain intact during the upgrade.

## Security

OAuth uses Authorization Code with PKCE (S256), random in-memory state, an exact loopback callback, and no token-bearing URLs. Remote edits are protected by ETag conflict checks. See [SECURITY.md](SECURITY.md) for implementation details and vulnerability reporting.

## Contact

For privacy questions, open a non-sensitive [GitHub Discussion](https://github.com/woonyong-choi/manta-calendar/discussions). Do not include private Vault content or credentials. Security-sensitive reports should use GitHub private vulnerability reporting.
