# Google Calendar integration

Link Calendar's Google integration is a narrow, optional projection for notifications. Markdown remains canonical.

## User flow

1. Configure a folder source in Link Calendar.
2. Enable Google Calendar in plugin settings.
3. Select **Connect Google Calendar** and approve the single requested permission in the browser.
4. The callback tries to reopen Obsidian automatically. If the browser blocks the app link, select **Open Obsidian** on the completion page.
5. Enable one or more source mappings to allow sending their events. Read-only editing and `access: local-only` are separate settings. An explicit `external_sync: deny` prevents sending a selected note.
6. Select **Sync now**.

The plugin creates one dedicated secondary calendar named **Link Calendar**. No Google developer credentials are required from end users.

## What sync owns

| Item | Behavior |
| --- | --- |
| Direction | Configured Markdown source → Google |
| Trigger | Explicit **Sync now** command |
| Included | Events from selected configured folder profiles, excluding notes marked `external_sync: deny` |
| Excluded | Automatic body-index events, primary calendar, unrelated calendars, guests |
| Created fields | Summary, start, end, private ownership marker |
| Reminders | New events use that calendar's default reminders; later remote reminder changes are preserved |
| Preserved fields | Google-side description, reminders, and other fields not owned by the plugin |
| Remote edit | Stops the overwrite when the stored ETag changed |
| Local deletion | Leaves the remote event untouched |
| Remote calendar deletion | Stops sync; reconnecting is required before a new dedicated calendar is created |
| Obsidian closed | No new sync; existing Google notifications continue normally |

Stable local keys and deterministic Google event IDs make a retry idempotent. A 409 response is adopted only when the remote private ownership marker matches; otherwise it is reported as a conflict. A mapping without an ETag is rejected, so updates can never fall back to an unconditional overwrite.

## OAuth and relay

The cross-platform callback uses a small Cloudflare Worker relay because Obsidian runs on desktop and mobile. The relay:

- uses Authorization Code with PKCE;
- signs state with a short expiration;
- accepts only the fixed `obsidian://link-calendar-google` return URI;
- requests only `calendar.app.created`;
- exchanges, refreshes, and revokes tokens without storing them;
- rejects malformed or oversized requests and disables observability.

After Google returns to the HTTPS callback, the relay serves a no-store completion page. It attempts the fixed Obsidian app link automatically and keeps a visible, keyboard-accessible **Open Obsidian** action as a recovery path for browsers that require a user gesture before opening another app.

The refresh token remains in Obsidian `SecretStorage`. Calendar API requests are made directly from Obsidian. See [PRIVACY.md](../PRIVACY.md).

## Maintainer deployment

The relay source is isolated under `oauth-worker/`. Provider changes should stay behind that adapter; the calendar projection and local index do not depend on Cloudflare-specific APIs.

For a public release, first configure a production Google Cloud project and OAuth consent screen. Google's [OAuth branding requirements](https://support.google.com/cloud/answer/15549049) require the application homepage and privacy policy to be public on the same verified domain owned by the maintainer, and the exact relay callback origin must be registered as an authorized redirect. Keep a separate testing project while the production brand and Calendar scope are being reviewed. Do not publish a build that presents the integration as generally available while the OAuth application is limited to test users.

Required Worker secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `STATE_SECRET` (at least 32 random characters)
- `PUBLIC_BASE_URL` (public rather than sensitive, but stored as a Worker secret so code-only deployments cannot replace it)

Required Worker configuration:

- `PLUGIN_REDIRECT_URI=obsidian://link-calendar-google`

`PUBLIC_BASE_URL` and `LINK_CALENDAR_GOOGLE_RELAY_URL` must be the same exact HTTPS origin, with no path, query, or fragment. Register `${PUBLIC_BASE_URL}/oauth/callback` as the exact Google web OAuth redirect. Never put the Google client secret or state secret into the plugin bundle.

Builds derive the public origin from the versioned custom domain in `oauth-worker/wrangler.jsonc`, so `npm ci && npm run build` reproduces the official plugin without repository variables. Custom development builds can override `LINK_CALENDAR_GOOGLE_RELAY_URL` (an empty value disables the integration). Official release verification requires the versioned origin and rejects empty, local, example, credential-bearing, query-bearing, or mismatched relay URLs before an asset can be published. OAuth secrets remain outside the plugin source and bundle.

The Worker also serves the OAuth application's public homepage at `/` and privacy policy at `/privacy`. Keep those pages aligned with `README.md` and `PRIVACY.md`; their tests are part of `npm run test:oauth`.

`npm run verify:release` also calls the deployed `/health` endpoint with a ten-second timeout and requires protocol version `1`. The release workflow cannot publish assets when the configured relay is missing, unhealthy, or incompatible.

The manual `OAuth relay` GitHub workflow runs the isolated tests, deploys only `oauth-worker/`, and rechecks the live protocol. It needs repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; Google and state secrets remain in Cloudflare and are not copied into GitHub.

## Failure and rollback

- If the relay health or protocol check fails, do not publish a plugin release.
- A relay-only regression can be rolled back to the previous Cloudflare Worker version without rebuilding the local calendar core.
- A plugin regression can be rolled back by reinstalling the previous official release; Markdown and the dedicated Google calendar remain intact.
- Revoking or disconnecting clears local authorization and mappings but does not silently delete remote events.
- Rotating `GOOGLE_CLIENT_SECRET` or `STATE_SECRET` affects new authorization flows; existing refresh grants continue only while the matching Google OAuth client remains valid.

Run the isolated gates before deployment:

```bash
npm run test:oauth
npm exec --yes wrangler@4.128.0 -- deploy --dry-run --config oauth-worker/wrangler.jsonc
```

## Connection recovery

The settings page exposes a refreshable connection stage. Waiting means browser authorization or the return to the originating Vault has not completed; it does not mean token exchange succeeded. Use the completion page's Open Obsidian action, return to the intended Vault, then refresh connection status. Expired requests must be restarted. Failed exchange is distinct from a connected account or a usable destination calendar. Share only OS, browser, Obsidian version and stage when reporting problems; do not share callback URLs or tokens. This diagnostic does not establish that the previously reported user-specific handoff failure is fixed.
