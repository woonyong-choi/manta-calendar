# Security policy

## Supported versions

Security fixes target the latest published release.

## Local data boundary

Manta Calendar runs locally inside Obsidian by default. Its automatic read-only index scans active Markdown while excluding hidden and archive/reference paths. Optional configured sources remain read-only by default; local writes require an explicit per-source setting and use Obsidian's Vault API. The plugin has no telemetry, remote AI, or persistent event database.

## Optional Google Calendar boundary

Google Calendar is disabled by default. Enabling it does not write remotely until the user connects an account, maps at least one configured folder source, and runs sync.

- OAuth uses a public Google Desktop app client with Authorization Code and PKCE (S256). The system browser returns only to `127.0.0.1` on an ephemeral port, at `/oauth/callback`.
- The listener validates the method, exact host and path, random state, and duplicate callback parameters. It accepts one response and closes after completion, cancellation, plugin unload, or ten minutes. It never listens on a LAN interface.
- State, the PKCE verifier, and the authorization code remain in memory. The callback page has no external resources, no caching, and no callback parameters in its HTML.
- The plugin requests only `calendar.app.created`, so it can create and access the dedicated calendar and its events, not primary or unrelated calendars.
- Refresh tokens are stored through Obsidian `SecretStorage`, never `data.json`, URLs, source code, or logs.
- Token exchange, refresh, and revocation go directly to Google over HTTPS. The bundle contains a public client ID and no client secret. No Manta domain or Cloudflare Worker participates in version 4 authentication.
- Event requests go directly from Obsidian to Google Calendar. No token or request body is logged.
- The direct refresh token is bound to its client ID in SecretStorage. Legacy relay credentials are ignored. Late responses cannot restore a disconnected account.
- Every persisted mapping requires an ETag; updates use the previous ETag and stop on missing or remote-changed values.
- Missing local events never cause remote deletion.

The desktop-only manifest excludes Obsidian mobile. Builds and releases check the configured public client ID, direct Google endpoints, desktop requirement, and absence of relay URLs or secret material. Integration tests exercise real loopback sockets on macOS and Windows; an actual Google sign-in remains a separate release validation.

See [PRIVACY.md](PRIVACY.md) for the user-facing Google data disclosure and [docs/google-calendar.md](docs/google-calendar.md) for the exact synchronization contract.

## Reporting

Do not include private Vault content in a public issue. Report reproducible non-sensitive bugs through [GitHub Issues](https://github.com/woonyong-choi/manta-calendar/issues/new/choose). For a vulnerability that cannot be described safely in public, use GitHub's private vulnerability reporting for this repository.
