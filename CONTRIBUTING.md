# Contributing

## Quality gate

```bash
npm ci
npm run verify
```

The build uses the public Desktop app client ID in `google-oauth-client.json` and the `MANTA_GOOGLE_DESKTOP_CLIENT_SECRET` environment variable. Without the latter, local development and tests work with Google sign-in disabled. Official CI and releases receive that value from GitHub Actions secrets. Release verification requires both values. Fork maintainers register their own Desktop app and supply their own build values; end users install the release and never configure developer credentials. Never commit downloaded credential JSON or a client secret. The Desktop registration value is embedded in distributed builds and cannot be confidential; user credentials remain separate in Obsidian SecretStorage. See [the registration contract](docs/google-calendar.md#app-registration-and-release).

Changes to date parsing, source capabilities, file mutation, OAuth, or remote projection require a regression test. Network code must remain inside the Google adapters, default off, and least privilege. Never commit credentials, tokens, telemetry, request-body logging, Vault-external paths, or direct filesystem writes. UI changes must be checked in Obsidian light and dark themes at desktop and narrow widths.

Direct OAuth tests use actual loopback sockets with simulated Google responses. CI runs them on macOS and Windows:

```bash
npm run test:desktop
```

`npm test` includes the view and presentation tests once. `npm run test:visual` checks the public HTML fixture without rerunning those unit tests. Use `npm run test:coverage` only when investigating coverage.

For UI changes, use a public sample Vault: add the empty-state date example, select the day, open its note, and check today/selection distinction, keyboard navigation, Escape focus restoration, and light/dark narrow layouts. Reuse unchanged, already verified results. A new OAuth flow needs actual Google connection and restart evidence, as well as cancellation and expiration tests. Mocked token responses do not establish that a registered Google client works.

## Release contract

The version in `manifest.json`, `package.json`, and `versions.json` must match. A GitHub release tag uses the exact version without a `v` prefix and contains `main.js`, `manifest.json`, and `styles.css` as individual assets.

The minimum Obsidian version is 1.13.0 because the settings tab uses the declarative settings API. Do not lower it without adding and testing a complete legacy `display()` implementation.
