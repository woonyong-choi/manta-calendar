# Link Calendar Navigator demo

The current frames were captured in Obsidian 1.13.7 on September 8, 2026 from a public-only sample Vault. Capture through the official CLI after checking the Vault name, loaded asset hashes, and document visibility. The raw 1920×1111 screenshots are padded to 1984×1116 without cropping or reconstructing UI.

The recipe reads the overview and agenda PNGs directly from `docs/media/`; only the additional empty-month frame lives here. This avoids storing duplicate source captures. Generated GIF output remains ignored.

Run `npm run demo:build` to reproduce `demo/dist/link-calendar-demo.gif`. Promote the inspected result to `docs/media/` and update `docs/release-media.json` only after verifying dimensions, hashes, and the captured build. Google OAuth is not shown in these captures.
