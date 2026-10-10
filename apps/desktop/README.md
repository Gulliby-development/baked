# BAKED desktop

The desktop app for BAKED: an Electron shell whose main process runs one `baked serve` per open
project and proxies the renderer's API calls to it. The design is in
[`design/desktop-app.md`](../../design/desktop-app.md).

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

`apps/desktop` is its own package with its own lockfile: the root `bun install` does not download
Electron, and the root checks do not cover this folder.

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
- `build/`: app icons. `tray.png` and `tray@2x.png` are rendered from `tray.svg`.
- `tests/`: `bun:test` tests; `tests/fixtures/fake-serve.ts` stands in for `baked serve`.
