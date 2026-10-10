# Privacy and telemetry

## What leaves your machine

- **The model provider you select** receives the assembled context: conversation, tool results and the code the agent read. Nothing goes to any other model service.
- **Web search and page fetching** contact their services (Brave or DuckDuckGo, Jina Reader) when the agent searches; each search asks first.
- **MCP servers** you configure receive the tool calls addressed to them.
- **Installing** language servers, skills or other optional tools, and listing a provider's models, use the network.
- **Telemetry** is not sent anywhere unless you configure a receiver (below).

Everything else stays local: config, sessions, memory, the repository graph and workflow runs (see [architecture](architecture.md#storage)). Keys are kept in the OS credential store ([configuration](configuration.md#provider-keys)).

## Telemetry

BAKED records one anonymous event when a session starts and writes it to `telemetry/events.jsonl` in the global data directory (`~/.baked/`, `%LOCALAPPDATA%\baked\` on Windows). The log keeps about 1 MB plus one rotated file. `baked telemetry` (or `--json`) summarizes it. The first run prints a one-line notice with the log path and how to opt out.

| Field | Example |
| --- | --- |
| `event` | `session_start` |
| `surface` | `tui`, `headless` |
| `version`, `os`, `arch`, `install` | release, platform, architecture, install method |
| `family`, `model` | model family, and the public base model name only when it matches a known public model of a built-in provider; anything else is `other` |
| `id` | a random UUID in `anon-id.json`, identifying an install, not a person |

Never recorded: prompts, code, file contents, paths, the working directory, host or user names, keys or tokens, custom model or provider names, IP addresses.

**Opt out** with any one of `"telemetry": false` in config, `BAKED_TELEMETRY=0` or `DO_NOT_TRACK=1`. Then nothing is written and no ID is created or read.

**Receiver.** With `telemetryUrl` in config or `BAKED_TELEMETRY_URL`, each event is also sent as a fire-and-forget GET with a 1.5 s timeout. Recording never blocks startup or shows an error. The client is `src/core/telemetry.ts`; an optional Cloudflare Worker receiver is in [`telemetry-worker/`](../telemetry-worker/README.md).
