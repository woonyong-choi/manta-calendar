# Privacy policy

Last updated: 2026-09-09

Public web copy: [link-calendar-oauth.woonyong.com/privacy](https://link-calendar-oauth.woonyong.com/privacy)

Link Calendar Navigator is an open-source Obsidian plugin. Its calendar index runs locally by default. Google Calendar integration is optional and disabled until a user explicitly enables and connects it.

## Google user data accessed

The integration requests only `https://www.googleapis.com/auth/calendar.app.created`. This permission lets the plugin create a dedicated **Link Calendar** secondary calendar and create, read, or update events in calendars created by this application. It does not grant access to a user's primary calendar or unrelated calendars.

Notes with `external_sync: deny` are excluded even when their source is selected for sync. Existing mappings and previously created remote events are preserved when sending a note is prohibited. Read-only editing and `access: local-only` do not prohibit a sync explicitly enabled through source selection.

During an explicit sync, the plugin sends only the title, start, and end of events from folder sources the user selected. It also writes private ownership identifiers used to make retries deterministic and prevent cross-event overwrites. Note bodies, unrelated notes, guests, contacts, and existing calendar events are not sent.

## Storage and sharing

When two-way synchronization is explicitly enabled, the plugin reads events from the dedicated calendar and stores supported event titles, dates and times in the selected writable Obsidian source. Imported notes include calendar and event IDs to recover interrupted imports without duplication. Existing note bodies and unrelated properties are preserved; Google descriptions, attendees and reminders are not imported into notes. This does not expand the OAuth permission or grant access to primary or unrelated calendars.

- The Google refresh token is stored locally with Obsidian `SecretStorage`.
- Calendar mapping identifiers and sync fingerprints are stored in the plugin's local settings.
- Access tokens are held in memory only.
- OAuth codes and tokens pass through the Link Calendar OAuth relay for exchange, refresh, and revocation. The relay does not persist them.
- Google event data goes directly between the user's Obsidian app and Google Calendar.
- No Google user data is sold, used for advertising, shared with data brokers, or used to train AI models.
- The plugin and relay do not use analytics or telemetry.

Google processes data under its own terms and privacy policy when the user chooses this integration.

## Retention and deletion

Disconnecting in plugin settings asks Google to revoke the grant and removes locally stored tokens and mappings. Uninstalling the plugin removes its local settings according to Obsidian's behavior. Events already written to the dedicated Google calendar remain under the user's control; the plugin never treats local deletion as permission to delete a remote event. Users can delete the dedicated calendar in Google Calendar at any time.

## Security

OAuth uses Authorization Code with PKCE, signed short-lived state, an exact redirect URI, and no token-bearing URLs. Remote edits are protected by ETag conflict checks. See [SECURITY.md](SECURITY.md) for implementation details and vulnerability reporting.

## Contact

For privacy questions, open a non-sensitive [GitHub Discussion](https://github.com/woonyong-kr/obsidian-link-calendar-navigator/discussions). Do not include private Vault content or credentials. Security-sensitive reports should use GitHub private vulnerability reporting.
