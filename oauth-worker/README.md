# Link Calendar OAuth relay

This no-dependency Cloudflare Worker provides the cross-platform Google OAuth callback for Manta Calendar. It does not store tokens, notes, events, accounts, or analytics.

See [`docs/google-calendar.md`](../docs/google-calendar.md) for the contract and deployment variables. Run tests from the repository root with `npm run test:oauth`.
