# BAKED desktop

The desktop app for BAKED: an Electron shell whose main process runs one `baked serve` per open
project and proxies the renderer's API calls to it. The design is in
[`docs/desktop/app.md`](../../docs/desktop/app.md); the API contract is
[`docs/desktop/api.md`](../../docs/desktop/api.md).

## Development

```sh
cd apps/desktop
bun install
bun run dev        # Electron with the renderer from Vite; backends run from this checkout
bun run dev:web    # the renderer alone in a browser, with sample data instead of backends
```

`bun run dev` runs each project's backend as `bun ../../src/boot.tsx serve`, so install the
repository's dependencies at the root first. Settings → BAKED executable points the app at another
`baked` instead.

## Checks

```sh
bun run lint
bun run typecheck
bun test
bun run build      # out/main, out/preload and out/renderer
```

## UI tests

```sh
bun run e2e                                   # vite build, then Playwright against vite preview
bunx playwright test e2e/chat.e2e.ts --headed # one file, in a visible window
bunx playwright test --debug -g "theme"       # step through one test in the inspector
bunx playwright show-report                   # the HTML report of the last run
bunx playwright show-trace test-results/<test>/trace.zip
```

The specs in `e2e/` drive the built renderer in Chromium with the mock bridge
(`src/renderer/client/mock*.ts`) in place of Electron, so they need no backend. Each test opens a
route with a mock scenario (`?mock=default|empty|start-failure|older|uninitialized`, see
`client/mock.ts`), starts the page clock at a fixed time, and fails on any uncaught renderer error.
Find elements by role and accessible name (`getByRole`), as `scripts/smoke.ts` does, not by CSS
selectors.

No browser is downloaded: the tests use the installed Google Chrome (`channel: "chrome"`). Set
`BAKED_E2E_CHROMIUM` to a Chromium executable to use that instead, for example
`BAKED_E2E_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` in a container. A failed
test keeps a screenshot and a trace in `test-results/`; in CI they are uploaded as the
`desktop-ui-report` artifact.

`bun run e2e:electron` builds the app and launches it from `out/` with Playwright's Electron
support (Linux: run it under `xvfb-run -a`). Each test gets a throwaway home whose settings point
the BAKED executable at `tests/fixtures/fake-serve.ts` (through a small shell wrapper), so it
covers preload IPC, the bearer token, backend start, crash and restart, project open and close,
and attention streams that drop and resume with `Last-Event-ID`, without a real `baked`. The
fake's known projects live in the file named by `FAKE_BAKED_PROJECTS`, and
`BAKED_DESKTOP_RESTART_DELAYS_MS` shortens the restart backoff. The chat scenario
(`e2e/electron/chat.electron.ts`) runs the repository's own `baked serve` from source instead,
with `BAKED_TEST_SCRIPT` pointing at a JSON chat script, so it needs `bun install` at the
repository root too. Install the Electron binary first
(`bun install` without `ELECTRON_SKIP_BINARY_DOWNLOAD`).

`apps/desktop` is its own package with its own lockfile: the root `bun install` does not download
Electron, and the root checks do not cover this folder.

## Packaging

```sh
cd apps/desktop
bun install                                   # without ELECTRON_SKIP_BINARY_DOWNLOAD
bun run package -- --baked <path-to-baked>    # or BAKED_BINARY=<path>; add --arch x64|arm64 to cross-package
xvfb-run -a bun run smoke                     # Linux: launches dist/linux-unpacked and checks the window
bun run smoke                                 # Windows and macOS: no display server needed
```

The smoke test starts the unpacked build (`dist/linux-unpacked/baked-desktop`,
`dist/win-unpacked/BAKED.exe`, `dist/mac-arm64/BAKED.app` or `dist/mac/BAKED.app`) under a
throwaway home, registers a folder with the bundled `baked` from `resources/bin`, and checks that
All projects shows it. CI runs it after packaging on linux-x64, windows-x64 and darwin-arm64 (the
builds made for the runner's own architecture), with the same gating as packaging: nightly,
workflow_dispatch and pull requests that touch packaging files.

`scripts/package.ts` builds the app, copies the `baked` binary to `resources/bin` (with the
`deps/` folder next to it, as in the release bundles from `scripts/bundle.sh` and
`scripts/bundle-windows.ps1`) and runs electron-builder (`electron-builder.yml`) for the current
platform: an NSIS installer on Windows, a DMG and a ZIP on macOS, an AppImage and a DEB on Linux.
`--target portable` builds a Windows exe that runs without installing
(`baked-desktop-<version>-win-x64-portable.exe`) instead of the installer; CI does not build it.
Installers land in `dist/` and carry the repository's version. Take the binary from an unpacked
bundle (for example `dist/bundle/baked-<version>-linux-x64/baked` after
`bash scripts/bundle.sh x64 linux` at the root): workflows need its `deps/` folder.
`build/icon.png` (1024 px, the oven logo exported from `build/icon.svg`) is the app icon;
electron-builder derives the Windows, macOS and Linux icons from it.

Builds are unsigned. macOS gets an ad-hoc signature, so the first launch has to be allowed under
System Settings → Privacy & Security; Windows SmartScreen warns about an unknown publisher.

`scripts/smoke.ts` registers a temporary project with the bundled `baked` under a throwaway home,
launches the unpacked app with Playwright and waits for All projects, the sidebar and that
project's card. `--app <executable>` points it at another build.

In CI the `desktop` jobs in `.github/workflows/builds.yml` package Linux x64 on every pull
request, and Windows x64 and arm64 and macOS arm64 and x64 when packaging files change, nightly
and for releases. Each takes the bundle its platform's bundle job built; the Linux job also runs
the smoke test. Releases attach the installers.

## Layout

- `src/main/`: the Electron main process. `supervisor.ts` keeps the project list and one
  `Backend` (`backend.ts`) per open project, adds the bearer token to every request and streams
  Server-Sent Events with reconnects. `attention.ts` merges the attention lists of all open
  projects for "Needs you" and system notifications; a notification click opens its item at
  `#/attention/PROJECT_KEY/ITEM_ID`. `tray.ts` hides the window to a tray icon on close while
  "keep running in tray" is on and a run is active, and keeps the dock or taskbar badge at the
  number of blocking items. `project-actions.ts` pins, unpins and forgets folders through any
  running backend, or through `baked projects` when none runs.
- `src/preload/`: the `window.baked` bridge (`src/shared/bridge.ts`), the only way the sandboxed
  renderer reaches the main process.
- `src/renderer/`: the React app. `client/mock.ts` replaces the bridge with fixtures outside
  Electron.
- `build/`: app icons, exported from the SVG next to each PNG ([brand](../../docs/brand.md)).
  `tray.png` and `tray@2x.png` come from `tray.svg`; macOS uses `trayTemplate.png` and
  `trayTemplate@2x.png` from `trayTemplate.svg`.
- `tests/`: `bun:test` tests; `tests/fixtures/fake-serve.ts` stands in for `baked serve`.
