# Security policy

## Supported versions

Security fixes target the latest published release.

## Local data boundary

Link Calendar Navigator runs locally inside Obsidian by default. Its automatic read-only index scans active Markdown while excluding hidden and archive/reference paths. Optional configured sources remain read-only by default; local writes require an explicit per-source setting and use Obsidian's Vault API. The plugin has no telemetry, remote AI, or persistent event database.

## Optional Google Calendar boundary

Google Calendar is disabled by default. Enabling it does not write remotely until the user connects an account, maps at least one configured folder source, and runs sync.

- OAuth uses Authorization Code with PKCE and a fixed Obsidian callback.
- The relay requests only `calendar.app.created`, so it can create and access the dedicated calendar and its events, not primary or unrelated calendars.
- Refresh tokens are stored through Obsidian `SecretStorage`, never `data.json`, URLs, source code, or logs.
- The relay exchanges, refreshes, and revokes tokens without persistent storage or request-body logging.
- Event requests go directly from Obsidian to Google Calendar.
- Every persisted mapping requires an ETag; updates use the previous ETag and stop on missing or remote-changed values.
- Missing local events never cause remote deletion.

See [PRIVACY.md](PRIVACY.md) for the user-facing Google data disclosure and [docs/google-calendar.md](docs/google-calendar.md) for the exact synchronization contract.

## Reporting

Do not include private Vault content in a public issue. Report reproducible non-sensitive bugs through [GitHub Issues](https://github.com/woonyong-kr/obsidian-link-calendar-navigator/issues/new/choose). For a vulnerability that cannot be described safely in public, use GitHub's private vulnerability reporting for this repository.
