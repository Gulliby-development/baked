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
- Visual style: neobrutalism. Controls and panels have a 2px ink outline (`--ink`) and a hard offset shadow (`--shadow`, `--shadow-sm`); a button moves into its shadow on hover. Native checkboxes and selects get the same outline (`base.css`): a ticked box fills with the accent, and a select draws its own chevron (`--chevron` per theme). Where Chromium supports a customizable select (`appearance: base-select`), its option list is drawn in the same style and the hovered or focused option takes the accent fill instead of the platform blue. Scrollbars are an ink-outlined block thumb without arrow buttons that fills with the accent on hover. The window itself never scrolls: screens scroll inside `<main>`, which is the positioning context for visually hidden labels so they cannot stretch the page. Status colours appear as colour blocks (`--fill-accent`, `--fill-ok`, `--fill-warn`, `--fill-err`, `--fill-info`) that always carry `--on-fill` text, so they read in both themes.
- Components: [shadcn/ui](https://ui.shadcn.com) on [Base UI](https://base-ui.com) primitives, styled after [neobrutalism.dev](https://www.neobrutalism.dev) (MIT). They live in `src/renderer/components/ui/` and are styled with Tailwind CSS v4; `components.json` lets the shadcn CLI add more. `src/renderer/styles/index.css` is the stylesheet entry: it maps the kit's token names (`main`, `background`, `border`, `shadow`, …) onto BAKED's tokens and loads Tailwind without its preflight. Every screen is built from these components and Tailwind utilities; there are no per-screen stylesheets. Besides the kit, `components/ui/` holds the app's own building blocks (`Alert` for notices, `Empty` for placeholders, `SegmentGroup`/`Segment` for joined toggles, `Dot` for status dots, `Dialog` for editing in a popup, `Tooltip` and `Hint` (a small **?** that explains a term), and the compact `primary`/`secondary` button variants with size `md`), and `src/renderer/lib/styles.ts` holds shared class strings for layout and text patterns (`PAGE`, `LABEL`, `PANEL`, `TABLE`, …); combine them with `cn` so a screen's own utilities win. `styles/base.css` keeps only element defaults (page font and colours, links, focus outline, native text inputs, selects, checkboxes and scrollbars) in a `base` layer below the utilities.
- Routing by URL hash: `#/projects`, `#/attention`, `#/p/<projectKey>/{overview,chat/<sessionId>,runs/<runId>,initiatives,acceptance,usage,setup/{gates,instructions,working-set}}`, `#/settings/{app,providers,routing,commands,notifications,telemetry}` (the older `#/settings/global` opens Providers and keys). `projectKey` is a short hash of the folder path.
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
| Run memory | `GET`/`POST /v1/workflow/memory` |

Chat, prompts (tool approvals), setup, usage and initiatives are specified in [`api.md`](api.md), owned by the API work; the desktop does not change the API. Session prompts appear in `/v1/attention` with source `chat`, so "Needs you" and notifications cover them.

`MockClient` follows that contract. Screens whose endpoints a backend does not have yet (an older `baked`) show "needs a newer BAKED" instead of failing.

## Screens

From the mockups; the sidebar and three settings levels follow gulliby's review of 2026-10-10.

| Screen | Content |
| --- | --- |
| Sidebar | Needs you (count), All projects; the selected project expanded with Quick task, New run, Overview, Initiatives, Chat, Runs, Usage, Code graph and a Setup group (Gates and checks, Instructions, Working set, each with a count, and Run memory); other projects collapsed to one line with their state; Open folder; Settings at the bottom with backend status and version. Under Chat: New chat and the five latest chats, counted by the running backend. Under Runs: Acceptance. The sidebar stays expanded on every screen, chat included. |
| Title bar | Drawn by the app: the window has no system frame on Windows and Linux, and the bar carries BAKED's name and its own minimize, maximize/restore and close buttons; the bar drags the window and a double click maximizes it. macOS keeps its traffic lights inset in the same bar. The native menu is not shown; its shortcuts still work. |
| All projects | Project cards: open, running in the background or closed, branch, sessions, active runs, items waiting; open folder, pin, forget. |
| Needs you | Blocking and advisory items of all open projects with project tags and a filter; the selected item's detail with its actions (approve, reject, answer, deliver). When nothing waits, one full-width empty state replaces the list and detail panes. |
| Project home | Task box with Quick, Full run and Ask in chat; recent sessions and runs; working set; doctor summary. |
| Chat | One centered column (about 820 px): messages, collapsed tool lines, inline diffs, approval cards, suggestions; compact chips for context, changed files and working set, and New chat; the context chip's panel has **Compact now**, which summarizes the older messages (`POST /v1/sessions/ID/compact`; disabled while a turn runs) and leaves a note in the transcript; the changed-files chip shows the lines added and removed since the last commit (`GET /v1/sessions/ID/diff`) with a per-file list, or only the file names when the server has no `diff-stats` capability; the title opens the list of chats; composer with model, effort and approval mode, where **Plan first** (plan mode) is offered when the server lists the `plan-mode` capability: the proposed plan shows in the transcript with **Execute**, **Clear context and execute**, **Revise** (asks what should change) and **Cancel**, Needs you offers Execute and Cancel plan for it, and the plan's checklist follows its steps while it runs; `@` in the composer lists files, folders and symbols (`GET /v1/mentions`), a message starting with `!` runs a command, and what they attached shows under the message. With the server's `images` capability, images pasted or dropped onto the composer attach to the message (up to 4; larger images and other formats the browser can read are re-encoded as JPEG to fit 3.5 MiB) and show as thumbnails in the composer, with a remove button, and under the message in the transcript, where a click opens the full image ([`api.md`](api.md#images)). **Undo** and **Redo** chips in the header (servers with the `chat-undo` capability; disabled while a turn runs): Undo asks for a confirmation, drops the last turn and restores the files it edited; Redo puts the oldest undone turn back with its files; each shows what was restored, files left in place and the backup tag above the conversation until dismissed or the next message ([`api.md`](api.md) undo and redo). Hovering an answer shows "Fork from here", which opens a new chat from that point, with only the chat or with the files rolled back too ([`api.md`](api.md) fork), and shows what was restored at the top of the new chat. |
| Quick task, New run | New run has three steps. 1, What to bake: the goal, or a GitHub issue (its title and body become the goal and the delivered pull request closes it; see [starting from a GitHub issue](../workflows/runtime.md#starting-from-a-github-issue)). 2, Recipe: workflow cards (quick, standard, sdd, and "More workflows" for the other presets and the project's definitions), each with a mini line of its stages where round dots are approvals a person gives. 3, Bake: one readiness strip with the doctor result and the estimate against the budget, "Details" opening the full doctor and estimate panels, and the folded "Oven settings" (budget preset, worktree and writers, open questions, feature ID, run model) whose summary line shows the current choices; they open on their own when the feature ID is invalid. Quick task keeps one form with the same workflow, budget, writers, questions and model choices. The approval decision lists the assumptions the agents made. |
| Run | The run is a conveyor: each stage is a station on a belt, labelled with its type (agent, writers, checks, approval, review) and the contract it makes, with a bar that fills while the contract forms; a dashed Done station ends the line. When a stage finishes, its contract rides the belt to the next station; the loops that send work back (checks failed, review asked for changes) are lanes under the belt, and a contract carried back travels along its lane. Stations show their round after a loop. The belt rolls while the run executes; every animation stops under reduced motion. Clicking a station shows its card (what it does, the contracts it takes and makes, "Your part") and its sections; the default station is the one that needs you, then the working one. Decisions that wait for you (approval, questions, evidence, recovery, delivery) sit above the card on every station. Sections per station: approval opens Decision, Spec, Plan; spec and plan stages open Spec and Criteria or Plan; writers open Tasks and Changes; checks open Checks and Criteria; review opens Findings; Done opens Overview, Report and Criteria; "Other sections" reaches the rest. The header line shows tokens against the budget, cost, active time and the run model; "Budget, model and activity" opens the Budget, Model and Activity panels, which open on their own when the run stops on its budget or its provider. The line comes from the definition's `line` in `GET /v1/workflow/definitions`; with an older backend each stage's role is guessed from its ID. The Report tab shows the [run report](../workflows/runtime.md#run-report) in Markdown, the text delivery uses as the pull request body, with Copy and Save as .md. Pause, Resume, Cancel run, and Undo edits while the run is neither created nor running: after a confirmation it runs `baked workflow undo` and shows the `workspace-rollback` report (files restored, files left in place with the reason, or nothing to undo). The Model panel shows the run model and routed stages; while nothing executes the run it switches the run to another model (configured models are suggested) and resumes a blocked or paused run, keeping completed work. |
| Parallel writers | Writer columns with worktrees, integrator, task graph. |
| Acceptance | Criteria with verdicts and evidence; manual observation input. |
| Initiatives, Usage | Initiative features and their runs, and the initiative's model with a switch to another one (features started later use it, stopped runs move to it, and the initiative continues; offered while no feature run executes); tokens by stage and model, cost. |
| Code graph | The project's code graph (servers with the `code-graph` capability). It starts with the big folders and the most depended-on files; small files sit in piles and extra folders in a "more folders" block. Clicking a folder or pile opens it in place: its blocks grow out of it inside a dashed frame, the rest fades, and the view flies to it; the frame's tab or Esc closes it. Lines are imports, dashed when only types are used; each block shows its strongest few, a selected block shows all of them, and clicking a line explains it (imported names, call sites, how often Git changed both files together). Folders show a waffle of their files with key files dark; tones follow the top-level folders and tests have their own. The canvas pans and zooms (labels hide when zoomed far out), blocks can be dragged, and Find a file opens the folders around it. Tests and Type edges hide test files and type-only links. The right panel shows the project summary, a block's biggest files or a file's links. While the project is first indexed the section says so and fills in when the index is ready. Motion stops under reduced motion. |
| Project setup | Gates and checks, Instructions, Working set, Run memory. Run memory (servers with the `run-memory` capability) lists what new workflow runs read, grouped as notes, answers, assumptions and checks, with Add note, Edit, Forget (Delete for a note) and Restore, a Forgotten list and "What the next run reads" with the exact text ([project memory](../workflows/runtime.md#viewing-and-editing-project-memory)). In a folder without `baked/project.json`, Working set and the project panels say to run `baked project init` instead of showing an error. |
| Settings | A settings menu on the left: This app (Appearance and behavior, stored on this computer) and one page per part of All projects (`~/.baked/config.json`): Providers and keys, Model routing, Global commands, Run notifications and Telemetry, so no page needs a long scroll. Model routing lists the same entries as the TUI [routing screen](../workflows/runtime.md#routing-screen) under plain names: Model names (classes), Agent roles (roles), Workflow steps of a chosen workflow (stages), Agent profiles (profiles) and Independent review. Each entry shows the route All projects sets, the route the project's `.baked/config.json` sets, and what new runs use (model, effort, fallback models and the setting that chose it). A **?** next to a term explains it on hover or keyboard focus (what a class, role, step or profile is, the built-in `$active`, `$fast`, `$coding` and `$review`, effort, fallback models, the two files). **Save changes to** picks which file Edit, Clear and Add model name change; with several open projects, a Project choice picks whose config is shown and resolved. Edit and Add model name open a dialog with Model, Effort (inherit, model default, low to max) and Fallback models, naming the file and the `modelRouting` key it writes. The backend refuses what a run start would refuse and the dialog lists the reasons; nothing is written then. Under Providers and keys, Claude Code and Codex have Sign in and Sign out: Sign in runs the CLI's own login, which opens the browser, shows its progress, and offers Open sign-in page and Cancel until it ends. The CLI keeps the credentials, as when you sign in from a terminal. A CLI that is not installed shows the command to run once it is. GitHub Copilot has no sign-in of its own: paste the OAuth token of a signed-in IDE with Set key ([providers](../providers.md#github-copilot)). |

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
