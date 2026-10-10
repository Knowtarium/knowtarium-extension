# Knowtarium Web Clipper

A browser extension that saves the page you're on to your Knowtarium inbox: its link and title,
an optional note and a category. Chrome first; Edge takes the same build. Saved pages are signed
and encrypted in the extension, and only your own devices can open them.

## What it can and can't do

- **Permissions:** `activeTab` (the current tab's link and title, only after you click the button
  or press the shortcut) and `storage`. No host permissions, no content scripts, no access to
  other tabs, no background alarms.
- **Write-only.** The extension never holds a workspace key. It signs each clip with its own
  Ed25519 key, which the workspace owner vouched for when pairing, and seals it to the workspace's
  inbox key, which the owner signed. It can add clips to one workspace and can't read a single
  note, not even the clips it sent. Knowtarium's server queues sealed clips it can't open; the
  web app (or an agent, where the folder allows it) files each one as a note in `Inbox/` or
  `Inbox/<category>/`.
- **Nothing about the page is read** beyond its link and title: no page text, selection or
  screenshot.

The design, with every field and limit, is Knowtarium's web clipper design; the code here follows
it and imports only `knowtarium/clip`, the SDK's light entry that can seal and verify but opens
nothing except the pairing payload.

## Using it

1. Click the Knowtarium button and **Connect to Knowtarium**. A tab opens with a code, and
   Knowtarium opens next to it.
2. In Knowtarium, check that it shows the same code, tick "This code matches my extension",
   pick the workspace and allow.
3. To save a page: click the button (or press **Alt+Shift+S**, changeable in the browser's
   extension shortcuts), add a note or pick a category if you like, then **Save**.

Without a network, a clip waits in the extension (at most 100) and is sent the next time the
popup opens or the browser starts. **Disconnect** in the popup revokes the extension and clears
everything it stored.

## Development

Needs Node.js 24 (`.nvmrc`) and pnpm 12.

```sh
pnpm install
pnpm build:dev     # dist/ for the local sync API (http://localhost:8790) and web app (http://localhost:3005)
pnpm dev           # the same, rebuilt on every change
```

Load `dist/` as an unpacked extension (`chrome://extensions`, Developer mode, Load unpacked).

| Build       | Command              | API                                  | Web app                              | Fixed key |
| ----------- | -------------------- | ------------------------------------ | ------------------------------------ | --------- |
| Development | `pnpm build:dev`     | `http://localhost:8790`              | `http://localhost:3005`              | yes       |
| Staging     | `pnpm build:staging` | `https://api-staging.knowtarium.com` | `https://app-staging.knowtarium.com` | yes       |
| Production  | `pnpm build`         | `https://api.knowtarium.com`         | `https://app.knowtarium.com`         | no        |

Development and staging builds carry a fixed public `key`, so the unpacked extension always has
the ID `idkngjlbfganidcddemgehcepgeeeiig`. The local and staging APIs list its origin,
`chrome-extension://idkngjlbfganidcddemgehcepgeeeiig`, in `EXTENSION_ORIGINS`. Store builds have
no `key`: the stores assign the ID.

**The SDK.** Until `knowtarium` publishes the clipper, the extension links the SDK from a
checkout next to it (`"knowtarium": "link:../app-clipper"`, built with `pnpm build` there). The
build bundles libsodium from this project's lockfile only (`libsodium-wrappers` 0.8.4 over
`libsodium` 0.8.4, the standard build, never the sumo one); `build/libsodium-guard.ts` fails the
build otherwise.

## Tests

```sh
pnpm check         # lint, format check, typecheck and the Vitest suite
pnpm e2e           # Playwright: skipped unless KNOWTARIUM_E2E_EXTENSION is set
```

The Vitest suite plays the web app's side with the SDK's own crypto: pairing against a fake API
(including a swapped inbox key and an `extension_key` naming another key, both refused), saving
and the queue (same sealed bytes on every retry, sealing again only after a verified
`stale_inbox_key`), every error text, and both pages' markup.

The Playwright tests load the unpacked development build (`pnpm build:dev` first) in Chromium
with a mock keychain, a basic password store and a fresh profile:

- `KNOWTARIUM_E2E_EXTENSION=smoke pnpm e2e` answers the API itself: the fixed ID and the two
  permissions, the popup, and the pairing page running libsodium under the extension CSP.
- `KNOWTARIUM_E2E_EXTENSION=full pnpm e2e` also pairs through the local web app and saves a clip
  that ends up as a note. It needs the sync API and the web app running locally and a test
  account in `KNOWTARIUM_E2E_EMAIL` and `KNOWTARIUM_E2E_PASSWORD`.

`KNOWTARIUM_E2E_TMP` picks the folder for the temporary profile.

## Packing and releasing

```sh
pnpm package
```

builds for production, checks the build (no development key, exactly the two permissions, the
CSP, no inline script or eval) and writes to `release/`:

- `knowtarium-extension-chrome-<version>.zip` for the Chrome Web Store
- `knowtarium-extension-edge-<version>.zip` for Edge Add-ons (the same files)
- `SHA256SUMS`, and `size.json` with the packed size

The zips are reproducible: the same build gives the same bytes. Version 0.1.0 packs to 179.6 KiB
(488 KiB unpacked, most of it libsodium).

To release, set the version in `package.json`, commit, and push a tag `v<version>`. The Release
workflow builds that tag and attaches the zips, `SHA256SUMS` and `size.json` to its GitHub
Release, with signed build provenance and the packed size in the notes:

```sh
sha256sum -c SHA256SUMS
gh attestation verify knowtarium-extension-chrome-<version>.zip --repo Knowtarium/knowtarium-extension
```

## License

MIT, see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
