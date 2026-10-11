# Desktop app

Date: 2026-10-10. Technical design. Status: proposed; implementation starts with the scaffold while this document is open for review.

Sources: the desktop mockups in Claude Design (15 screens), the multi-project analysis of 2026-10-10 (one `baked serve` per project), the local API in `src/core/api/server.ts`, projects-lite ([projects](../projects.md)) and the known-projects list (`src/core/projects/known.ts`).

## Goal

A desktop app for BAKED, like the desktop apps of Claude and Codex, over the same core as the terminal UI and the headless CLI:

- Several projects open side by side. Each project is a folder with its own sessions, workflow runs, memory and settings; runs in background projects keep going.
- Chat with the agent is the main screen of a project.
- Everything that waits for a person (approvals, clarifications, delivery plans, tool approvals in chat) is collected in one "Needs you" list and raised as a system notification.
- Workflow runs, initiatives, acceptance and usage are readable and actionable without a terminal.
- Project setup (gates, instructions, working set) is visible inside the project, separate from app settings and from settings shared by all projects.

## Non-goals

- Several projects inside one backend process. `getCwd()` and the intelligence singletons make that a large refactor (see the multi-project analysis); the desktop runs one backend per project instead.
- A second agent implementation. The app never runs models, tools or workflows itself; it renders the core's durable state and sends the person's decisions back.
- Remote or multi-user access. The backend stays on 127.0.0.1 with a per-start token.
- Publishing to npm or an app store. Builds ship as GitHub release assets like the CLI.

## Shell: Electron

The default is **Electron** with a React renderer built by Vite.

| | Electron | Tauri | Electrobun |
| --- | --- | --- | --- |
| Renderer | Chromium, identical on every OS | system WebView (WebView2, WKWebView, WebKitGTK) | system WebView or bundled CEF |
| Main process | Node.js | Rust | Bun |
| Toolchain in CI | Node/Bun only | Rust plus per-OS WebView dependencies | Bun, young project |
| Installer size | about 100 MB plus the `baked` binary | about 10 MB plus the binary | small |
| UI testing | Playwright drives Electron (`_electron.launch`) | WebDriver only | none established |
| Used by | Claude desktop, Codex desktop, VS Code | | |

Reasons for Electron:

1. One rendering engine on Windows, macOS and Linux. The mockups rely on CSS that differs between WebKitGTK and Chromium, and Linux WebKitGTK is the most common source of Tauri bugs.
2. Playwright, already the browser driver of the AI acceptance gate, launches and drives Electron apps. BAKED can run acceptance checks against its own desktop app.
3. The main process only supervises child processes and proxies HTTP, which Node does well; no Rust toolchain enters CI.
4. The size cost is accepted: the app bundles the `baked` binary either way.

The main process runs on Electron's Node.js; everything else (install, scripts, tests, builds) uses Bun, as the rest of the repository does.

## Architecture

```
┌──────────────────── Electron app ────────────────────┐
│ renderer (React, sandboxed, no Node)                  │
│   window.baked.request / subscribe  (preload bridge)  │
│                      │ IPC                            │
│ main process                                          │
│   ProjectSupervisor ── one backend per open project   │
│   ApiProxy (token stays here)                         │
│   AttentionHub ── notifications, tray badge           │
│   AppSettings (userData/settings.json)                │
└──────┬───────────────────┬───────────────────────────┘
       │ spawn, HTTP       │ spawn, HTTP
  baked serve --cwd A   baked serve --cwd B   …
```

### Main process

- **ProjectSupervisor.** Reads the project list with `baked projects list --json` (no backend needed). Opening a project spawns `baked serve --cwd <folder> --port 0 --token-file <userData>/tokens/<hash>.token`, waits for the one JSON line `{"url","port","tokenFile"}` on stdout, reads the token and checks `GET /v1/health`. A backend that exits unexpectedly is restarted with backoff (1 s, 2 s, 4 s … up to 30 s, five tries, then the project shows "backend stopped" with a Restart button and the last stderr lines). Closing a project or quitting sends SIGTERM (on Windows, `taskkill /T` after a grace period); the backend pauses its active drives and resumes them on the next start, as the CLI does today.
- **Backend binary.** Packaged builds bundle the `baked` binary for their platform under `resources/bin/`. In development the app runs `bun <repo>/src/boot.tsx serve`. App settings can point to another `baked` (for example one on PATH).
- **ApiProxy.** The renderer never sees a URL or a token. It calls `request(projectPath, method, path, body)` and `subscribe(projectPath, path, lastEventId)`; main checks that the path starts with `/v1/` and the method is GET or POST, adds the bearer token and forwards the call. Server-Sent Events are parsed in main and forwarded as IPC messages; main reconnects with `Last-Event-ID` after a backend restart, so a renderer subscription survives one. Because main's `fetch` sends no `Origin`, `baked serve` needs no `--allow-origin` and no CORS change.
- **AttentionHub.** Subscribes to `GET /v1/attention` of every running backend, merges the lists into "Needs you", raises a system notification for each new blocking item (advisory items only when the user opted in), and sets the dock or taskbar badge.
- **AppSettings.** Settings of this app only (theme, density, language, notifications, tray, which `baked` to run, open projects and window state) in `<userData>/settings.json`. Agents and runs never read it.
- **Tray.** When "Keep runs going in the tray" is on, closing the window keeps backends with active runs alive; quitting from the tray stops them.

### Renderer

- React 19, Vite, TypeScript strict. Colours come from design tokens in `src/renderer/styles/tokens.css` (the dark TUI palette: `#191410` ground, `#ff9d52` accent; IBM Plex Sans and Plex Mono, bundled as files so the app works offline). A light theme follows the TUI's light tokens.
- Visual style: neobrutalism. Controls and panels have a 2px ink outline (`--ink`) and a hard offset shadow (`--shadow`, `--shadow-sm`); a button moves into its shadow on hover. Native checkboxes and selects get the same outline (`app.css`): a ticked box fills with the accent, and a select draws its own chevron (`--chevron` per theme). Status colours appear as colour blocks (`--fill-accent`, `--fill-ok`, `--fill-warn`, `--fill-err`, `--fill-info`) that always carry `--on-fill` text, so they read in both themes.
- Components: [shadcn/ui](https://ui.shadcn.com) on [Base UI](https://base-ui.com) primitives, styled after [neobrutalism.dev](https://www.neobrutalism.dev) (MIT). They live in `src/renderer/components/ui/` and are styled with Tailwind CSS v4; `components.json` lets the shadcn CLI add more. `src/renderer/styles/index.css` is the stylesheet entry: it maps the kit's token names (`main`, `background`, `border`, `shadow`, …) onto BAKED's tokens and loads Tailwind without its preflight. The shell (title bar, sidebar) and the project home are built from these components. The other screens keep their own stylesheets (`chat.css`, `runs.css`, …), which draw the same outline, shadow and fill tokens; `app.css` sits in a `legacy` layer below Tailwind's utilities, and screen stylesheets that a screen imports itself are unlayered.
- Routing by URL hash: `#/projects`, `#/attention`, `#/p/<projectKey>/{overview,chat/<sessionId>,runs/<runId>,initiatives,acceptance,usage,setup/{gates,instructions,working-set}}`, `#/settings/{app,global}`. `projectKey` is a short hash of the folder path.
- Data access goes through one typed `BakedClient` interface. Two implementations: `IpcClient` (the real one) and `MockClient` (fixtures plus a scripted chat stream). The renderer runs in a plain browser against `MockClient` (`bun run dev:web`), so screens can be built and reviewed before the chat API lands.
- Security: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, a strict Content-Security-Policy (no remote scripts, no `eval`), navigation and new windows blocked, external links opened by main only for `https:` URLs.

## Backend API

The app uses the existing endpoints as they are:

| Screen | Endpoints |
| --- | --- |
| All projects, sidebar | `baked projects list --json` before any backend; `GET /v1/projects` after |
| Project home | `GET /v1/projects/current`, `GET /v1/workflow/runs`, `GET /v1/workflow/doctor` |
| Needs you | `GET /v1/attention` (SSE) per project; decisions via `POST /v1/workflow/runs/:id/{approve,reject,answer}` then `resume` |
| Runs, writers | `GET /v1/workflow/runs/:id`, `/events` (SSE), `/usage`, `/artifacts`; `POST …/{pause,resume,cancel,extend,reroute,undo}` |
| New run, quick task | `GET /v1/workflow/{definitions,profiles,estimate}`, `POST /v1/workflow/runs` |
| Acceptance | run artifacts and acceptance requests from attention |
| Working set | `GET`/`POST /v1/projects/current/working-set` |

Chat, prompts (tool approvals), setup, usage and initiatives are specified in [`api.md`](api.md), owned by the API work; the desktop does not change the API. Session prompts appear in `/v1/attention` with source `chat`, so "Needs you" and notifications cover them.

`MockClient` follows that contract. Screens whose endpoints a backend does not have yet (an older `baked`) show "needs a newer BAKED" instead of failing.

## Screens

From the mockups; the sidebar and three settings levels follow gulliby's review of 2026-10-10.

| Screen | Content |
| --- | --- |
| Sidebar | Needs you (count), All projects; the selected project expanded with Quick task, New run, Overview, Chat, Runs, Initiatives, Acceptance, Usage and a Setup group (Gates and checks, Instructions, Working set, each with a count); other projects collapsed to one line with their state; Open folder; Settings at the bottom with backend status and version. Under Chat: New chat and the five latest chats, counted by the running backend. The sidebar stays expanded on every screen, chat included. |
| Title bar | Drawn by the app: the window has no system frame on Windows and Linux, and the bar carries BAKED's name and its own minimize, maximize/restore and close buttons; the bar drags the window and a double click maximizes it. macOS keeps its traffic lights inset in the same bar. The native menu is not shown; its shortcuts still work. |
| All projects | Project cards: open, running in the background or closed, branch, sessions, active runs, items waiting; open folder, pin, forget. |
| Needs you | Blocking and advisory items of all open projects with project tags and a filter; the selected item's detail with its actions (approve, reject, answer, deliver). |
| Project home | Task box with Quick, Full run and Ask in chat; recent sessions and runs; working set; doctor summary. |
| Chat | One centered column (about 820 px): messages, collapsed tool lines, inline diffs, approval cards, suggestions; compact chips for context, changed files and working set, and New chat; the title opens the list of chats; composer with model, effort and approval mode. |
| Quick task, New run | New run: goal, optional GitHub issue (its title and body become the goal and the delivered pull request closes it; see [starting from a GitHub issue](../workflows/runtime.md#starting-from-a-github-issue)), feature ID. Both: workflow and budget preset choice (built-in presets), writers, open questions (ask, or settle with recorded assumptions), model, checks, pre-run estimate. The approval decision lists the assumptions the agents made. |
| Run | Stage pipeline, approval card, tabs (overview, decision, tasks, changes, spec, plan, checks, criteria, findings, report), budget and activity. The Report tab shows the [run report](../workflows/runtime.md#run-report) in Markdown, the text delivery uses as the pull request body, with Copy and Save as .md. Pause, Resume, Cancel run, and Undo edits while the run is neither created nor running: after a confirmation it runs `baked workflow undo` and shows the `workspace-rollback` report (files restored, files left in place with the reason, or nothing to undo). The Model panel shows the run model and routed stages; while nothing executes the run it switches the run to another model (configured models are suggested) and resumes a blocked or paused run, keeping completed work. |
| Parallel writers | Writer columns with worktrees, integrator, task graph. |
| Acceptance | Criteria with verdicts and evidence; manual observation input. |
| Initiatives, Usage | Initiative features and their runs; tokens by stage and model, cost. |
| Project setup | Gates and checks, Instructions, Working set. In a folder without `baked/project.json`, Working set and the project panels say to run `baked project init` instead of showing an error. |
| Settings | This app (stored on this computer) and All projects (`~/.baked/config.json`: providers, model routing, global commands, run notifications, telemetry). |

## Repository layout and builds

```
apps/desktop/
  package.json, bun.lock, bunfig.toml, tsconfig.json, biome.json
  electron-builder.yml
  src/main/        supervisor, proxy, attention hub, settings, tray
  src/preload/     the contextBridge API
  src/renderer/    React app, screens, styles, MockClient
  src/shared/      types shared by main and renderer (BakedClient, IPC channels)
  tests/           bun:test for main-process logic and the client
```

- `apps/desktop` is its own package with its own lockfile, so `bun install` at the root does not download Electron. The root's lint, typecheck and tests keep their scope (`src/`, `tests/`); the desktop has the same checks under `apps/desktop`.
- CI: a `desktop` job in `ci.yml` runs `bun install --frozen-lockfile`, lint, typecheck, tests and the renderer and main builds in `apps/desktop` on Linux.
- Packaging: `builds.yml` gets a desktop job per platform that takes the `baked` binary its bundle job built and runs electron-builder: NSIS installer for Windows x64 and arm64, DMG and ZIP for macOS arm64 and x64, AppImage and DEB for Linux x64. Like the CLI bundles, Windows and macOS run when packaging files change, nightly and for releases. The release workflow uploads the installers as release assets.
- Code signing and notarization need certificates only gulliby can provide (an Apple Developer ID and a Windows code signing certificate). Until then builds are unsigned: macOS asks to allow the app in Privacy & Security, Windows SmartScreen warns.
- Updates: the repository is private, so the app checks GitHub releases only when a token is configured and otherwise shows its version with a link. Automatic updates come with signing.

## Plan

Each step is a pull request from its own branch; steps on one line can run in parallel.

1. This design.
2. Scaffold: Electron, preload, renderer with the sidebar, routing, design tokens, `BakedClient` with `MockClient`, ProjectSupervisor and ApiProxy, CI job.
3. In parallel, each on the scaffold: (a) All projects and Needs you with the AttentionHub and notifications; (b) Chat on the mock, switched to the real API when it lands; (c) Project home, Quick task and New run; (d) Runs, writers and acceptance; (e) Initiatives and Usage; (f) Project setup and Settings.
4. Packaging in `builds.yml` and release assets.
5. Playwright smoke test of the packaged app on Linux.

## Open questions

- Signing certificates (gulliby).
- Whether chat tool approvals also go to the OS notification by default (proposed: yes, they block the turn).
- Hand checks on Windows and macOS (gulliby's devices), as for the CLI builds.
