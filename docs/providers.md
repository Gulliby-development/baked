# Providers

Pick a provider and model with `Ctrl+L` or `/models`. Models are named `provider/model`.

| Connection | Provider ID | Authentication |
| --- | --- | --- |
| Claude | `anthropic` | `ANTHROPIC_API_KEY` or `/keys` |
| Claude Code | `claude-code` | Claude subscription through the `claude` CLI: `/claude-code login` (`/claude-code code`, `/claude-code logout`, `/claude-code status`) or `baked login claude-code`, see below |
| OpenAI API | `openai` | `OPENAI_API_KEY` or `/keys` |
| OpenAI Codex | `codex` | ChatGPT account: `/codex login` (`/codex switch`, `/codex logout`, `/codex status`), `baked login codex`, or Sign in and Switch account in the desktop app's settings |
| GitHub Copilot | `copilot` | An existing Copilot sign-in in VS Code, JetBrains or Neovim is found automatically; or `COPILOT_API_KEY`, `/keys`, `--set-key copilot`, see below |
| GitHub Models | `github-models` | `GITHUB_MODELS_API_KEY` or `/keys`; otherwise `GITHUB_TOKEN`, `GH_TOKEN` or the GitHub CLI's login (`gh auth login`), see below |

Keys are stored outside project configuration ([configuration](configuration.md#provider-keys)). `/provider-settings` sets thinking, effort, speed and context options; a chat can choose its own [reasoning effort](#reasoning-effort-per-chat) and [context size](#context-size-per-chat). From a shell:

```sh
baked --list-providers
baked --list-models openai
baked --set-key anthropic sk-ant-...
baked --remove-key anthropic        # forget the saved key
```

`baked workflow models` lists the same models for [model routing](workflows/runtime.md#routing-screen), with the routing model names and the providers that still need a key or login.

## Reasoning effort per chat

Each chat has a reasoning effort: `default`, `low`, `medium`, `high`, `xhigh` or `max`. `default` follows `performance.effort` (and the OpenAI and OpenAI-compatible effort settings) from `/provider-settings`; any other level replaces them for that chat's turns, and the saved session keeps it. The terminal sets it per tab with `/effort` (a picker, or `/effort high`) and shows a level other than `default` after the model in the header; the desktop composer has an effort chip next to the model; headless runs take `--effort` ([headless](headless.md#options)); the local API takes `effort` on `POST` and `PATCH /v1/sessions` ([API](desktop/api.md)).

The levels offered are the ones BAKED sends to the chat's model, which `GET /v1/models` lists as `efforts`:

| Provider | How the effort is sent | Levels |
| --- | --- | --- |
| Anthropic | `effort` provider option | the model's own (`low` to `max`; Haiku none) |
| OpenAI | `reasoningEffort` | `low`, `medium`, `high` on reasoning models |
| Codex | `effort` on each app-server turn (`model_reasoning_effort` with `codex exec`) | `low` to `xhigh` on GPT-5 and o-series models |
| Claude Code | `--effort` on the CLI, when the installed version has the flag | `low` to `max` (Sonnet without `xhigh`, Haiku none) |
| GitHub Copilot, GitHub Models | `reasoning_effort` in the request body | `low` to `xhigh` on reasoning models; none for Claude models |

A level the model does not support sends the next lower one it does; a model with no levels runs at its provider's default. Since this change, `performance.effort` also reaches Codex and Claude Code, which ignored it before. Workflow routes set effort per agent instead ([runtime guide](workflows/runtime.md#effort-and-fallback-models)).

## Context size per chat

Some providers offer more than one context window for a model. A chat then has a context size: `default`, `max` or a window in tokens. `default` runs the model as chosen. The [project coordinator](coordinator.md) always runs with the largest window its model offers and has no context size setting. A larger window keeps more of the conversation before compaction and costs more per turn. A model with one window runs as chosen whatever the size says, and the pickers hide.

| Provider | Windows | How the size is sent |
| --- | --- | --- |
| Claude Code | 200k and 1M for `opus`, `sonnet`, Opus 4.6 and later, Sonnet 4 and later (not Haiku or Fable) | the `[1m]` model ID (`opus[1m]`) for 1M |
| Codex | one window per model: GPT-5.5 272k input, GPT-5.4 1.05M, GPT-5.2-Codex 400k | nothing to pick; a larger window means another model |
| Anthropic, OpenAI, GitHub Copilot, GitHub Models | one window per model | nothing to pick |

The terminal sets it per tab with `/context-size` (a picker, or `/context-size 1m`) and shows a chosen size after the model in the header; the desktop composer has a context size chip next to the effort chip when the model offers several windows (not in the coordinator); headless runs take `--context` ([headless](headless.md#options)); the local API takes `contextSize` on `POST` and `PATCH /v1/sessions` and lists `contextSizes` in `GET /v1/models` ([API](desktop/api.md)). A size the model lacks takes the largest window below it, or the smallest. Choosing a `[1m]` model ID directly also works and stays as chosen under `default`. Codex CLI's own `model_context_window` setting only tells the CLI how large a window to assume for its compaction; it does not make the model accept more, so BAKED does not offer it as a size. `/context-window` is separate: it overrides how many tokens BAKED budgets for a model, not which window the provider runs. Workflow routes pick a window per class, role, profile or stage with `context` (`default`, `max`, a size, or `auto`, which moves only a step whose context does not fit to the largest window); see [workflow routing](workflows/runtime.md#effort-and-fallback-models).

## Claude Code

The Claude Code connection runs Claude models through the official `claude` CLI and the account it is signed in to, so a Claude subscription works without an API key.

1. Install Claude Code. BAKED finds `claude` as described in [Finding the CLIs](#finding-the-clis). On Windows use the native build (`claude.exe`, `claude install`); the npm `claude.cmd` shim cannot be started directly. `BAKED_CLAUDE_CODE_PATH` points BAKED at another executable.
2. Sign in with `/claude-code login` (it runs `claude auth login` and opens the browser), with Sign in under Settings > All projects > Providers and keys in the desktop app, or run `claude auth login` in a terminal. When the browser the CLI opened is not used, the printed sign-in page ends on a code: run `/claude-code code CODE` in the terminal UI (closing the login popup keeps the sign-in running), paste it into the desktop's code field and press Send code, or paste it into `baked login claude-code`.
3. Pick a model: `claude-code/opus`, `claude-code/sonnet`, `claude-code/haiku` or `claude-code/fable` follow the newest model of each family. Any model name Claude Code accepts also works, for example `claude-code/claude-opus-4-8` or `claude-code/sonnet[1m]` for the 1M context window where the plan allows it.

BAKED keeps one `claude -p --input-format stream-json` process per conversation, with all of Claude Code's built-in tools, MCP servers, hooks, skills and project `CLAUDE.md` turned off. On a CLI with `--safe-mode` (checked with 2.1.302) your own `~/.claude/CLAUDE.md` and skills stay out of the prompt too; an older CLI without that flag still loads them. BAKED's tool list and adapter rules become the Claude Code system prompt, and each agent step sends only the messages added since the previous step. The opening of a conversation that BAKED marks for the cache (the system prompt and, in a workflow attempt, the run's documents) goes into that system prompt too, which Claude Code caches, so the attempts of a run share it. Claude Code puts its prompt-cache breakpoints on that growing conversation, so later steps read the earlier context from the cache; usage records cache reads and cache writes separately. A step whose transcript does not continue an open conversation (after compaction, a retry, or a changed tool list) starts a new process. Idle processes stop after 10 minutes, and at most four stay open.

BAKED's tools are not native Claude Code tools. When the model calls a BAKED tool natively anyway, with that tool's exact name and an object input, the adapter interrupts the turn and takes that call as the step's tool call, so the step goes on as if the model had answered with the JSON envelope; the session that holds the native call closes and the next step starts a fresh process with the whole transcript. When the model calls any other tool natively (the CLI answers "No such tool available"), the adapter watches the event stream, interrupts the turn at once and sends a corrective line in the same session, so the step costs a few thousand tokens instead of a whole wasted turn. The tokens of the interrupted attempt are added to the step's usage and the step's provider metadata lists the aborted tool names (`providerMetadata["claude-code"].nativeToolAborts`). If the correction fails too, the session is closed and the step runs once more in a fresh process with the whole transcript; only when that process loses the tools as well does the step fail with a `ClaudeCodeNativeToolError`. The usage and aborted tool names of every attempt are added to the step.

Images attached to a message (pasted in the terminal UI or the desktop chat, or `--image` in headless runs) go to Claude Code as image blocks of that turn; the transcript text marks where each image belongs. Replies arrive when each step finishes (no token streaming). The CLI ignores sampling settings such as temperature and maximum output tokens. Usage counts against the Claude Code plan limits; the cost BAKED shows is the API-price equivalent.

## GitHub Copilot

The Copilot connection uses your Copilot subscription through the same API as the IDE extensions. It is not an official GitHub integration.

Sign in to Copilot in VS Code, a JetBrains IDE or Neovim. BAKED reads that login's GitHub token from `apps.json` (then `hosts.json`) in `~/.config/github-copilot/` on Linux and macOS (`$XDG_CONFIG_HOME/github-copilot/` when set) or `%LOCALAPPDATA%\github-copilot\` on Windows. It only reads these files and checks them again on every provider check, so signing out of the IDE makes `copilot` unavailable again. `baked --list-providers`, `/keys`, the first-start wizard and the desktop settings show `Copilot IDE login` as the source.

The GitHub Copilot CLI's login (`~/.copilot`) is not used: the CLI keeps its token in its own credential store, and the Copilot API accepts only a token issued to a Copilot app. Sign in through an IDE, or save a token.

To use another token, save it with `baked --set-key copilot <token>` or `/keys`, or set `COPILOT_API_KEY`; a saved or environment key always wins over the IDE login. A 401 means the token was rotated: sign in to Copilot in the IDE again, or save the new token.

## GitHub Models

GitHub Models takes a GitHub token that can call `models.github.ai` (a fine-grained token needs the `models:read` permission; a classic token or the GitHub CLI's OAuth token works). BAKED uses the first of: `GITHUB_MODELS_API_KEY` or a key saved with `/keys`, then `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token` from a signed-in GitHub CLI (`gh auth login`). The CLI answer is cached for 30 seconds. The source is shown as `GITHUB_TOKEN`, `GH_TOKEN` or `gh CLI` wherever providers are listed. A token found this way is not checked against GitHub until the first request, so a token without access to GitHub Models shows as ready and fails with GitHub's error on use; save a key with `/keys` to use another one.

## Prompt cache

On the Claude API every agent loop (chat, subagents and workflow attempts) sends a cache breakpoint on the system prompt and Anthropic's request-level automatic breakpoint, which follows the newest message. Each step then reads the tools, the system prompt and the earlier steps from the cache instead of paying full price for them. A workflow attempt adds a third breakpoint after the run's documents in its first message, so the next attempt of the run reads them from the cache rather than writing them again. `cache.ttl` ([configuration](configuration.md)) sets the lifetime of all of them: `5m` (default) or `1h`. Usage records cache reads and writes; costs price cache writes at the 5-minute write price.

For Claude models BAKED marks the system prompt and the newest message with Copilot's `copilot_cache_control`, the cache marker the IDE extensions send, so later agent steps can read the conversation from the prompt cache. GPT models on Copilot rely on the upstream automatic prefix cache. Copilot bills premium requests rather than tokens, so the cache shortens responses and lowers the token counts BAKED records, not the Copilot bill.

## OpenAI Codex

The Codex provider drives the installed Codex CLI with your ChatGPT login. BAKED starts one `codex app-server` per process and keeps one ephemeral Codex thread per conversation, so Codex reuses the same prompt cache key and the cached prefix across steps. BAKED's system prompt becomes the thread's instructions; Codex's own agent prompt, built-in tools, skills, project docs and environment notes are switched off. The app-server refuses an input above 1,048,576 characters, so BAKED keeps each turn's input and each tool result it returns within 90% of that: an oversized tool result keeps its head and tail with a note of how many characters were left out, and a turn that carries several results shrinks the oldest first.

BAKED's tools are registered with Codex as native function tools, and replies stream as they are generated:

- When the model calls a tool, the step ends with that call and Codex's turn waits. BAKED runs the tool (with the usual approvals) and the result goes back into the same turn. Text messages BAKED adds after the result, such as a step reminder or a workflow notice, go back with it, so the turn and the thread carry on.
- Codex hands over one tool call at a time, so parallel calls from one model response arrive as consecutive steps.
- A new user message starts a new turn on the same thread with only that message. An edited or retried conversation, or a changed tool list, starts a new thread with the conversation so far as a transcript. A workflow step budget that replaces an older tool output with a short stub keeps the thread: Codex already holds the full output.
- A thread BAKED leaves is stopped. When a workflow attempt ends, the thread still waiting at its last tool call (usually `submit_result`) has its turn interrupted. The same happens to any thread BAKED drops. A tool call its model still makes is refused with another interrupt instead of an error the model would retry. BAKED keeps listening until Codex reports the turn ended, so a late usage report still counts. The next step to finish adds it to its usage and records `lateResponses` in its provider metadata.
- Codex has no way to force a tool choice; BAKED asks for it in the turn text instead.
- Token usage comes from Codex's thread totals, including cached input. Codex reports a response's usage only after the tool call it made has been answered, so the usage of a response that called tools is counted in the step after the tool result, and the step that ends the turn carries two responses. Each step also records how many responses it carried (`modelRequests` in `baked --headless --events`, and per step with the attempt's sum in a workflow attempt's `attempts/<id>/usage.json` artifact); over a run they add up to the model requests it cost, which is one per step when Codex makes no extra request. When a thread is dropped while a tool call waits (the conversation moved past the call without its result, or more than 16 threads are open), Codex never reports that response's usage. The next step to start counts such responses as `unreportedResponses` in its provider metadata, and a workflow attempt's `usage.json` and `baked workflow usage --format md` show the count, so a low token total is visible as low.

Codex's own built-in tools (its shell, patch, web search, images and plugins) are switched off for every thread and `codex exec` call. The one exception is web search, which a workflow turns on for code attempts with `modelRouting.codeWebSearch` ([runtime](workflows/runtime.md)): such a call starts its thread with `web_search = "live"` and reports each search it ran as `webSearches` and `webSearchQueries` in the step's provider metadata.

Model turns run in a Codex home of BAKED's own (`codex-home` under the BAKED data directory: `~/.baked` on macOS and Linux, `%LOCALAPPDATA%\baked` on Windows), so your personal `AGENTS.md`, `AGENTS.override.md` and skills in `CODEX_HOME` (default `~/.codex`) never reach a BAKED stage; Codex has no setting that turns that file off. The BAKED home links your `auth.json` and `config.toml` (a symlink, or a hard link where Windows refuses symlinks), and `developer_instructions` from your `config.toml` is cleared for every thread. Codex rewrites `auth.json` in place when it refreshes a token, so the link keeps your own Codex signed in; a replaced file is linked again before the next turn. Without an `auth.json` (the keyring credential store, or not signed in), or where neither link can be made, turns use your Codex home as before. Signing in, signing out and the model list always use your own home.

Images attached to a message go into the turn's input next to its text, as data URLs. With `codex exec` they are written to temporary files and passed with `--image`.

The native tools need a Codex CLI with the app-server `dynamicTools` API (checked with 0.162). If `codex app-server` cannot start or open a thread, the step runs as a separate `codex exec` instead, which asks for tool calls as JSON and shows output when the step finishes. A call on app-server that gets no first response before its deadline moves the later calls with the same base instructions and tools (one stage's profile, on any model) to `codex exec` for the rest of the process; other stages keep their app-server threads. In bench round 58 the call answering a refused submission of one specify stage got no first response on app-server in 8 of 8 attempts on two models, and the same stage completed in one 126 s call on `codex exec` (#1876). Each call's `calls` entry in the attempt's `usage.json` names its `transport` (`app-server` or `exec`) and, on app-server, whether it `resumed` a tool call the turn waited on. Set `BAKED_CODEX_TRANSPORT=exec` to always use `codex exec`. Set `BAKED_CODEX_TRACE` to a file path to append the app-server traffic of the process to it as JSON lines: each request, response, notification and server request with its method, ids, thread and turn and the size of its payload, never its text. BAKED finds `codex` as described in [Finding the CLIs](#finding-the-clis); `BAKED_CODEX_PATH` points it at another executable.

## Finding the CLIs

The Codex and Claude Code providers run the `codex` and `claude` executables. BAKED looks for each one in this order and stops at the first hit:

1. `BAKED_CODEX_PATH` or `BAKED_CLAUDE_CODE_PATH`, when set.
2. The folders on `PATH`.
3. On macOS and Linux, the `PATH` that the user's login shell builds (`$SHELL -ilc`, read once per process with a 5-second limit; `BAKED_LOGIN_SHELL_PATH=0` skips it). An app started from the Finder, the Dock or a desktop launcher, and the `baked serve` it starts, only get the system `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin` on macOS), so Homebrew, npm, nvm and installer folders from the shell profile are missing there.
4. Folders installers use: `~/.local/bin`, `~/.claude/local` (Claude Code's local install, which is often only a shell alias), `~/.bun/bin`, `~/.npm-global/bin`, `~/.volta/bin`, asdf and mise shims, pnpm, every `~/.nvm/versions/node/*/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and Linuxbrew; on Windows `~/.local/bin`, `~/.bun/bin`, `%APPDATA%\npm` and the Codex desktop app's `%LOCALAPPDATA%\OpenAI\Codex\bin\<version>` folders, newest first (the app moves its CLI to a new folder when it updates itself).
5. On Windows, the user and machine `PATH` in the registry, read again on every miss, because a running process keeps the `PATH` it started with.

The folder where the CLI was found is added to the front of the process `PATH`, so a CLI that starts with `#!/usr/bin/env node` finds the Node.js next to it, and tools BAKED runs later see the same `PATH`. A found location is remembered for the process; a miss is checked again on the next provider check, so a CLI installed while BAKED runs shows up without a restart. A workflow run whose model call fails because the CLI is not found blocks with `provider_account` and says to install the CLI, fix `PATH` or set the override, instead of waiting for it as a provider outage. When nothing is found, the provider status (`/codex status`, `/claude-code status`, Settings > All projects > Providers and keys in the desktop app) names the folders it searched.

## Model fallback

When a model fails with a transient error, BAKED retries it, then moves to the next model of that model's fallback chain, and announces the switch in the chat:

```json
{
  "modelFallback": {
    "anthropic/claude-sonnet-4-5": ["openai/gpt-5"],
    "anthropic/claude-haiku-4-5": ["openai/gpt-4.1-mini"]
  }
}
```

Chains are edited in `/router` (Model Fallback section: `Enter` adds, `d` clears) or in config.

Workflow runs use the same chains for routes that have no fallback models of their own, and a run whose provider refuses the account (no credits or quota, a subscription usage limit, rejected key) moves to the first model of the chain on another provider. See [workflow runtime](workflows/runtime.md).

- Each model gets `retry.maxTransientRetries` attempts (default 3) with exponential backoff before the next one is tried. After the last fallback the chain starts again from the primary, at most 3 cycles, then the original error is raised.
- Transient means overload, 429, 5xx, rate limits, timeouts and connection errors. A 403 counts only when its body mentions overload or a rate limit. 401, invalid requests and unknown models fail at once.
- Stalled streams are retried on the same model by the watchdog (`/watchdog`), not by fallback.
- `Ctrl+X` stops the loop immediately.

Workflow agents have their own fallback settings in `modelRouting` ([runtime guide](workflows/runtime.md#effort-and-fallback-models)).

## Cost

The header shows the running cost; `/context` breaks it down per model and per subagent, including cache reads and writes. Prices are built-in estimates; the provider's bill is authoritative. `/model-events` records each model call (latency, tokens, errors) in memory while it is switched on, which helps find a slow or failing model in a mixed router setup.
