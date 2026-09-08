# Contributing

## Quality gate

```bash
npm ci
npm run verify
```

The default build uses the versioned public relay origin; Google Calendar remains off until the user connects and selects sources. Custom development builds can override `LINK_CALENDAR_GOOGLE_RELAY_URL`. Production release verification additionally requires that live relay to pass its protocol health check.

Changes to date parsing, source capabilities, file mutation, OAuth, or remote projection require a regression test. Network code must remain inside the Google adapters, default off, and least privilege. Never commit credentials, tokens, telemetry, request-body logging, Vault-external paths, or direct filesystem writes. UI changes must be checked in Obsidian light and dark themes at desktop and narrow widths.

The OAuth relay has its own no-dependency test gate:

```bash
npm run test:oauth
```

`npm test` includes the view and presentation tests once. `npm run test:visual` checks the public HTML fixture without rerunning those unit tests. Use `npm run test:coverage` only when investigating coverage.

For UI changes, use a public sample Vault: add the empty-state date example, select the day, open its note, and check today/selection distinction, keyboard navigation, Escape focus restoration, and light/dark narrow layouts. Reuse unchanged, already verified results. A new OAuth flow needs actual connection/cancellation/expiration evidence; relay health alone is not authentication evidence.

## Release contract

The version in `manifest.json`, `package.json`, and `versions.json` must match. A GitHub release tag uses the exact version without a `v` prefix and contains `main.js`, `manifest.json`, and `styles.css` as individual assets.

The minimum Obsidian version is 1.13.0 because the settings tab uses the declarative settings API. Do not lower it without adding and testing a complete legacy `display()` implementation.
