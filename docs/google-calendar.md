# Google Calendar integration

Manta Calendar's Google integration is optional and supports desktop Obsidian on macOS and Windows. Sending selected Markdown events is the default; two-way synchronization is enabled by choosing a writable incoming source.

## User flow

1. Configure a folder source in Manta Calendar.
2. Enable Google Calendar in plugin settings.
3. Select **Connect Google Calendar** and approve the single requested permission in the browser.
4. Keep Obsidian open on the same computer. The browser shows success after Google credentials have been validated and saved, or a retry message if connecting fails. Return to Obsidian to check the destination calendar. No link or code needs to be copied.
5. Enable one or more source mappings to allow sending their events. Read-only editing and `access: local-only` are separate settings. An explicit `external_sync: deny` prevents sending a selected note.
6. Optionally choose **Two-way sync destination** to receive new Google events and Google edits. Existing settings remain send-only until you opt in.
7. Select **Sync now**.

The plugin creates one dedicated secondary calendar named **Manta Calendar**. End users need only their own Google account; no domain, server, or Google developer credentials are required. Each computer signs in separately.

**Upgrading from 3.x:** sign in once again. Existing calendar identifiers, source selections, installation identity, and event mappings are kept. The old relay token is ignored, and old authorization links cannot finish a version 4 connection. Reconnecting does not sync events or replace an unavailable calendar automatically.

## What sync owns

| Item | Behavior |
| --- | --- |
| Direction | Configured Markdown source → Google by default; optional two-way sync in the dedicated calendar |
| Trigger | Explicit **Sync now** command |
| Included | Events from selected configured folder profiles, excluding notes marked `external_sync: deny` |
| Excluded | Automatic body-index events, primary calendar, unrelated calendars, guests |
| Created fields | Summary, start, end, private ownership marker |
| Reminders | New events use that calendar's default reminders; later remote reminder changes are preserved |
| Preserved fields | Google-side description, reminders, and other fields not owned by the plugin |
| Remote edit | Send-only: conflict. Two-way: updates the writable note if it has not changed; simultaneous edits preserve both versions |
| Google-created event | Two-way: creates one stable-ID note in the chosen writable source; retry does not duplicate it |
| Note content | Imports change mapped title/date/time/all-day properties only; body and unrelated properties remain intact |
| Unsupported imports | Recurring/special events, sub-minute times, invalid ranges, incomplete or overlapping property maps are reported and preserved |
| Local deletion | Leaves the remote event untouched |
| Google deletion | Reports a conflict and preserves the note |
| Unavailable calendar | Stops sync; an explicit recovery action can create an empty replacement while keeping old mappings |
| Obsidian closed | No new sync; existing Google notifications continue normally |

Stable local keys and deterministic Google event IDs make a retry idempotent. A 409 response is adopted only when the remote private ownership marker matches; otherwise it is reported as a conflict. A mapping without an ETag is rejected, so updates can never fall back to an unconditional overwrite.

## Direct desktop authorization

Google documents the [Desktop app loopback flow](https://developers.google.com/identity/protocols/oauth2/native-app#redirect-uri_loopback) for macOS and Windows. Version 4 uses that flow:

1. Obsidian starts a temporary HTTP listener at `127.0.0.1` on a random available port. It is reachable only from the same computer.
2. The default browser opens Google's authorization page with the public Desktop app client ID, a PKCE S256 challenge, and random state.
3. After consent, Google redirects the browser to that local callback. The listener accepts one matching response and closes.
4. Obsidian exchanges the code and its in-memory PKCE verifier directly at `oauth2.googleapis.com`. Refresh and revocation requests also go directly to Google.
5. The refresh token stays in Obsidian `SecretStorage`; access tokens remain in memory. Calendar API requests go directly to Google Calendar.

No maintainer domain, Cloudflare Worker, or shared Manta service receives authorization codes, tokens, or calendar requests. The callback page loads no external resources and contains no authorization parameters. Cancelling, unloading the plugin, or waiting ten minutes closes the listener. See [PRIVACY.md](../PRIVACY.md).

Obsidian must remain open to complete sign-in or run a manual sync. Existing Google events and Google's notifications remain available when it is closed. Mobile Obsidian is not supported; this does not prevent using Google's own mobile calendar app.

## App registration and release

The maintainer registers a **Desktop app** OAuth client in the application's Google Cloud project, enables the Calendar API, and maintains the OAuth consent screen. Public releases need an external production audience; a testing-only audience is not a generally available integration. Google consent-screen metadata and branding review are separate publishing requirements. An informational homepage is not a callback or a token relay.

Only the public client ID and the declared `desktop` type belong in `google-oauth-client.json`. Google also requires the Desktop app's `client_secret` for token exchange and refresh, even with PKCE. Supply it through `MANTA_GOOGLE_DESKTOP_CLIENT_SECRET`; official builds use the repository's GitHub Actions secret. Never commit this value or downloaded credential JSON. Never substitute a web application credential. Fork maintainers register their own Desktop app and supply its matching build values.

The Desktop registration value is embedded in the release bundle. [Google's installed-app documentation](https://developers.google.com/identity/protocols/oauth2#installed) explains that this value cannot be confidential in a distributed app. It identifies the app and cannot replace user consent, the one-use code, the PKCE verifier, or a user's refresh token. Each user's tokens remain on that user's computer. A build environment variable keeps the registration out of Git history; it does not make the released bundle secret.

A missing Desktop registration value disables Google sign-in in development builds. `npm run verify` still checks local functionality and the network boundary; `npm run verify:release` requires the complete registration and rejects unexpected OAuth credentials or network origins. CI also runs real loopback socket tests on macOS and Windows. Those tests simulate Google responses; a real Google sign-in, token refresh after restart, and access to the existing dedicated calendar must be verified separately before publishing an OAuth change.

## Legacy versions and rollback

Version 3.x used a Cloudflare OAuth relay. Its source and manual deployment workflow have been removed from version 4. The deployed legacy Worker and Google web client are separate infrastructure; this source change does not delete or reconfigure them. Removing that infrastructure requires a deliberate migration decision for existing 3.x installations. New version 4 installations do not contact it.

Upgrades preserve obsolete relay credentials in Obsidian SecretStorage for rollback, but never read or transmit them. Do not revoke the old Google grant automatically after the new sign-in: [Google revocation](https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke) invalidates all clients' tokens in the same project. Users can remove obsolete saved secrets through Obsidian and manage app access in their Google Account.

A plugin rollback can reinstall the previous official assets while preserving Markdown and existing Google events. A 3.x rollback resumes that version's relay dependency. Disconnecting in version 4 revokes the Google grant before removing the direct credential and mappings; failure preserves them for retry. It never deletes remote events.

## Connection recovery

If the saved calendar is unavailable after upgrading from 3.x or changing accounts, **Create calendar if unavailable** first checks that calendar. A 404 response permits creating an empty **Manta Calendar** only for this explicit action; other errors stop recovery. A 404 means the current connection cannot find or access the calendar; it does not prove deletion. Existing calendars, events, source selections, authorization and per-calendar mappings are preserved. Recovery does not sync events. A later **Sync now** sends allowed notes to the new calendar; it does not move or remove events from the old calendar.

The settings page shows a refreshable connection stage. **Waiting** means approval has not yet returned to this computer; **Exchanging** means Obsidian is contacting Google for credentials. Neither means the destination calendar is ready. Keep Obsidian open, finish approval in the same computer's browser, and return to the originating Vault. Cancel and reconnect if a request expires or the browser closes. If a firewall blocks the local callback, allow Obsidian's loopback connection rather than disabling the firewall. Share only OS, browser, Obsidian version, and connection stage in issue reports; never share callback URLs or tokens.
