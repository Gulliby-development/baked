# OS sandbox

BAKED can run the commands it starts on the agent's behalf inside an operating-system sandbox. A sandboxed command writes only inside the project (plus temp and package caches), cannot read the usual credential stores, and, when the network is denied, reaches only loopback (Linux and macOS; Windows does not isolate the network yet). The sandbox is off by default; turn it on with the `sandbox` setting.

## What runs in it

| Process | Sandboxed | Writable | Network |
| --- | --- | --- | --- |
| Chat `shell` tool, including the pre-commit lint of `git commit -m` | yes | the project root and an approved outside `cwd` | `sandboxNetwork` (default allow) |
| Chat `project` tool (test, lint, build, typecheck, run) | yes | the project root | `sandboxNetwork` |
| Workflow checks, wait-stage polls, the check baseline measurement, the whole-unit checks at the end of a task, the test runs of mutation testing, `request_check`, `apply_fix` and the host fixer pass | yes | the run root (the project or its worktree) | the policy's `network`: only `allow` grants it |
| Review repros and `run_probe` | yes | the run root | the policy's `network` |
| AI acceptance applications, declared commands and promoted tests | yes | the gate's `capabilities.writePaths` only; the workspace stays read-only | shared while the gate grants `listenPorts` or `outboundHosts`, else the policy's `network` |
| `baked workflow gate run` (a gate outside any run) | yes | the project root | denied |

Not sandboxed in this slice: the SAST scanner (Semgrep reads the changed code, it does not run it), the start-up smoke test of each check before a run (stopped as soon as it spawns, in an empty scratch directory), hooks (the user configures them, so the user is the trust boundary), the formatter run after edits, Git commands BAKED runs itself, the Chromium of the browser driver, and the tools of the Claude Code and Codex providers, which run inside their own CLIs (Codex passes its own `--sandbox`).

## Modes

| Mode | Backend available | No backend |
| --- | --- | --- |
| `off` (default) | commands run unsandboxed | commands run unsandboxed |
| `auto` | commands run sandboxed | commands run unsandboxed; the first chat command of a process gets the note `[sandbox] <reason>; ran without OS sandbox` and the error log records it; check evidence records `backend: "none"` with the reason |
| `required` | commands run sandboxed | commands are refused before they start |

The mode comes from the global config (`~/.baked/config.json`). A project config (`.baked/config.json`, which a cloned repository can ship) can only raise it: the effective mode is the stricter of the two, ranked `off` < `auto` < `required`. A repository therefore cannot turn the sandbox off.

A workflow run freezes its mode in the run policy (`sandbox: "auto" | "required"`; absent means off). `baked workflow run --sandbox MODE`, the `sandbox` field of `POST /v1/workflow/runs` and the OS sandbox select of the desktop New run screen set it for one run; otherwise the stricter of the policy's value and the configured mode applies. With `required` and no backend, the run does not start: `prepareStart` refuses with the same message `baked workflow doctor` shows. A check refused this way is recorded as inconclusive with reason `sandbox_unavailable`. Every check artifact of a sandboxed run stores the `sandbox` that applied (`backend`, `mode`, `network`, and `reason` when it fell back).

Auto approval treats a weaker sandbox like a wider capability: a policy whose sandbox dropped below the approved one (for example from `required` to `auto`) is reported as `sandbox weakened from required to auto` and waits for a person. The approval digest names the sandbox mode.

## Settings and commands

| Where | How |
| --- | --- |
| Config | `"sandbox": "off" \| "auto" \| "required"` and `"sandboxNetwork": "allow" \| "deny"` in the global config ([configuration](configuration.md)) |
| Terminal UI | `/sandbox` opens a picker; `/sandbox off\|auto\|required` saves the mode globally; `/sandbox status` prints mode, backend and network |
| Headless | `baked --headless --sandbox MODE ...` replaces the global mode for that process (the project config can still raise it); `baked sandbox status [--json]` prints the status and exits 1 when the sandbox is required but unavailable |
| Workflows | `baked workflow run --sandbox MODE`; `baked workflow doctor` reports a `sandbox` line |
| Local API | `GET /v1/diagnostics/sandbox`; the settings in `GET\|PATCH /v1/settings` (Tools page, section Sandbox); `sandbox` in the start body ([desktop API](desktop/api.md)) |
| Desktop | Chat settings, Tools page; Diagnostics, Sandbox panel; New run, OS sandbox select |

## Backends

### Linux: bubblewrap

BAKED needs `bwrap` on `PATH` and probes it once per process (`bwrap --ro-bind / / --unshare-net --die-with-parent true`). A binary that is installed but cannot create user namespaces (inside many containers, or under Ubuntu 24.04's AppArmor restriction) is reported as unavailable: "user namespaces are blocked (container or AppArmor)".

A command runs as:

```
bwrap --die-with-parent --unshare-pid --unshare-ipc [--unshare-net]
  --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp
  --bind <writable> ...  --bind-try <cache> ...
  --ro-bind <protected> ...  --tmpfs <credential dir> ...  --ro-bind /dev/null <credential file> ...
  --chdir <cwd> -- <program> <args>
```

The whole host is readable, so toolchains, `node_modules`, `~/.bun`, `~/.cargo/bin` and the installed BAKED binary resolve. `/tmp` is private to the command (`TMPDIR=/tmp`); a workspace under `/tmp` is bound back on top of it. `--unshare-net` keeps a working loopback, so tests that bind `127.0.0.1` still pass. Stopping a command stops `bwrap`, which ends the command's PID namespace and everything in it.

### macOS: seatbelt

BAKED uses `/usr/bin/sandbox-exec` with a generated profile: everything is allowed except writes outside the writable paths, `/private/tmp`, `/private/var/folders`, `/dev/null`, `/dev/tty`, `/dev/fd` and the caches; protected paths are denied writes after the allows, credential paths are denied reads and writes, and without network everything but loopback and Unix sockets is denied. Paths reach the profile as `-D` parameters and are resolved to their real paths (`/tmp` is `/private/tmp`). Apple marks `sandbox-exec` deprecated; it still ships with macOS.

### Windows: restricted token

Windows has no sandbox program, so BAKED starts its own launcher: the BAKED binary with the hidden subcommand `__sandbox-exec` (from source, Bun runs `src/core/platform/windows-sandbox-launcher.ts`). The command and the paths to prepare travel as one base64 argument. The launcher:

1. labels the file system (see below), skipping paths that already carry the right label;
2. creates a restricted copy of the user's token: no privileges except bypass traverse checking, the Administrators group deny-only, and the low integrity level;
3. starts the command with that token (`CreateProcessAsUserW`, suspended) inside a job object that kills every process of the job when the launcher exits and blocks the clipboard, desktop switching, display and system settings and `ExitWindows`;
4. waits for it and exits with its status. A launcher that cannot start the command exits 125 with `baked sandbox: <reason>` on stderr.

Writes rely on Windows integrity levels: a low-integrity process cannot write an object labeled medium, which is the implicit label of every file. The launcher gives a low label (inherited by everything below) to the writable roots, the package caches and the private temp directory `%TEMP%\baked-sandbox-low`, which becomes the command's `TEMP` and `TMP`. Inside the writable roots, `.git/hooks`, `.git/config`, `.baked` and `baked/` get an explicit medium label back. Credential stores get a medium label with no-read-up, so the command cannot read them while the user's own programs (medium integrity) still can. Labels are stored on disk and stay after the command ends; the first command in a large project takes longer while Windows applies the label to every file below it.

BAKED probes the launcher once per process by running `cmd.exe /d /c exit 0` through it. Stopping a command stops the launcher (`taskkill /T`), and closing its job ends whatever the command left running.

The Windows backend does not isolate the network: a launch whose request denies it records `network: true` with the reason `the Windows backend does not isolate the network`, and `baked sandbox status` says so. Issue #785 tracks network isolation and browser profiles.

## What is hidden and protected

Credential stores in the home directory are replaced by an empty directory or an empty file when they exist (both the path and its real path, so a symlinked dotfile is covered):

- directories: `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.kube`, `~/.gnupg`, `~/.config/gh`, `~/.config/github-copilot`, `~/.codex`, `~/.claude`, `~/.docker`, `~/.password-store`, `~/.local/share/keyrings`, `~/.mozilla`, the Chrome, Chromium, Brave and Edge profiles, `$XDG_RUNTIME_DIR` (Linux); on macOS also `~/Library/Keychains`, `~/Library/Cookies` and the Chrome, Firefox and Brave profiles under `~/Library/Application Support`; on Windows also `%USERPROFILE%\AppData\Roaming\GitHub CLI` (browser profiles under `AppData` stay readable there);
- files: `~/.netrc`, `~/.npmrc`, `~/.yarnrc.yml`, `~/.pypirc`, `~/.git-credentials`, `~/.config/git/credentials`, `~/.docker/config.json`, and BAKED's own `~/.baked/secrets.json` and `~/.baked/secrets.dat`. The rest of `~/.baked` (installed binary, language servers) stays readable.

On Windows the home directory is `%USERPROFILE%`, and the stores are not replaced but labeled no-read-up (see [Windows](#windows-restricted-token)).

`SSH_AUTH_SOCK`, `GPG_AGENT_INFO` and `DBUS_SESSION_BUS_ADDRESS` are removed from the command's environment, so it cannot reach the SSH agent or the keyring over D-Bus.

Inside a writable workspace these stay read-only: `.git/hooks`, `.git/config`, `.baked` and, for workflow processes, `baked/` (workflow definitions). BAKED runs Git unsandboxed, so a hook, `core.hooksPath` or `core.fsmonitor` written by a sandboxed command would otherwise run on the host. On Linux and Windows a missing `.git/hooks` is created before the command starts so it can be made read-only.

Package caches stay writable when they exist: `~/.bun/install/cache`, `~/.cache/bun`, `~/.cache/go-build`, `~/.cache/pip`, `~/.npm`, `~/.cargo/registry`, `~/.cargo/git`, `$GOMODCACHE` (or `~/go/pkg/mod`), on macOS `~/Library/Caches`, and on Windows `AppData\Local\npm-cache`, `AppData\Local\pip\Cache` and `AppData\Local\go-build`.

## Limits

- Commands that need credentials fail in the sandbox: `git push` over SSH, `gh`, and installs from private registries configured in `~/.npmrc`. Run them with the sandbox off, or outside BAKED.
- With the network denied, cold-cache builds fail: `bun install`, `go test` and `cargo test` download modules on first use. Allow the network for the run (`network: "allow"` in the policy) or warm the caches first.
- An AI acceptance gate that grants ports or hosts shares the host network: the host browser and the filter proxy must reach the application, so only its file system is isolated.
- In a worktree run, the Git common directory (`<project>/.git/worktrees/<id>`) is not writable, so commands that write Git state in worktree checks fail; read-only Git works.
- Windows: the network is not isolated, browser profiles stay readable, and the integrity labels BAKED sets on the project, the caches and the credential stores stay on disk (a low label lets any low-integrity program write there). Issue #785 tracks the network.
- Submodule configs (`.git/modules/*/config`) are not protected yet, and macOS keychain access is blocked only at file level (the `security` tool's Mach service is not denied).
- Follow-up issue #625 tracks making `auto` the default after a soak, protecting submodule configs, a writable worktree Git common directory and the keychain Mach lookup.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `bwrap is not installed` | Install bubblewrap: `sudo apt install bubblewrap` (Debian, Ubuntu), `sudo dnf install bubblewrap` (Fedora). |
| `user namespaces are blocked (container or AppArmor)` | Ubuntu 24.04 restricts unprivileged user namespaces: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or add an AppArmor profile for `bwrap`. Inside Docker, run the container with user namespaces allowed or use `auto`. |
| `Sandbox required but unavailable` | The mode is `required` and no backend works here. Fix the backend, or lower the global mode; a project config that sets `required` cannot be lowered from the global config. |
| A command cannot write a file | It writes outside the project, temp and caches. Run it with the sandbox off, or, in a workflow, declare the path through the check's working directory. |
| `the sandbox launcher does not start: ...` (Windows) | The launcher could not label a path or create the restricted process; the message names the Windows call and its error code. Error 5 (access denied) on a label means the user cannot change that file's security (for example a file owned by another account); take ownership or use `auto`. |
| A command cannot reach the network | `sandboxNetwork` is `deny` (chat) or the run policy's `network` is not `allow`. |
