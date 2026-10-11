# Providers

Pick a provider and model with `Ctrl+L` or `/models`. Models are named `provider/model`.

| Connection | Provider ID | Authentication |
| --- | --- | --- |
| Claude | `anthropic` | `ANTHROPIC_API_KEY` or `/keys` |
| OpenAI API | `openai` | `OPENAI_API_KEY` or `/keys` |
| OpenAI Codex | `codex` | ChatGPT account: `/codex login` (`/codex switch`, `/codex logout`, `/codex status`) |
| GitHub Copilot | `copilot` | `COPILOT_API_KEY`, `/keys` or `--set-key copilot`, see below |
| GitHub Models | `github-models` | `GITHUB_MODELS_API_KEY` or `/keys` |

Keys are stored outside project configuration ([configuration](configuration.md#provider-keys)). `/provider-settings` sets thinking, effort, speed and context options. From a shell:

```sh
baked --list-providers
baked --list-models openai
baked --set-key anthropic sk-ant-...
```

## GitHub Copilot

The Copilot connection uses your Copilot subscription through the same API as the IDE extensions. It is not an official GitHub integration.

1. Sign in to Copilot in VS Code or a JetBrains IDE.
2. Copy the OAuth token: `jq -r '."github.com".oauth_token' ~/.config/github-copilot/apps.json` (on Windows `~\AppData\Local\github-copilot\apps.json`).
3. Save it with `baked --set-key copilot <token>` or `/keys`.

A 401 means the token was rotated; copy it again.

## Prompt cache

On the Claude API every agent loop (chat, subagents and workflow attempts) sends a cache breakpoint on the system prompt and Anthropic's request-level automatic breakpoint, which follows the newest message. Each step then reads the tools, the system prompt and the earlier steps from the cache instead of paying full price for them. `cache.ttl` ([configuration](configuration.md)) sets the lifetime of both: `5m` (default) or `1h`. Usage records cache reads and writes; costs price cache writes at the 5-minute write price.

For Claude models BAKED marks the system prompt and the newest message with Copilot's `copilot_cache_control`, the cache marker the IDE extensions send, so later agent steps can read the conversation from the prompt cache. GPT models on Copilot rely on the upstream automatic prefix cache. Copilot bills premium requests rather than tokens, so the cache shortens responses and lowers the token counts BAKED records, not the Copilot bill.

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

Workflow runs use the same chains for routes that have no fallback models of their own, and a run whose provider refuses the account (no credits or quota, rejected key) moves to the first model of the chain on another provider. See [workflow runtime](workflows/runtime.md).

- Each model gets `retry.maxTransientRetries` attempts (default 3) with exponential backoff before the next one is tried. After the last fallback the chain starts again from the primary, at most 3 cycles, then the original error is raised.
- Transient means overload, 429, 5xx, rate limits, timeouts and connection errors. A 403 counts only when its body mentions overload or a rate limit. 401, invalid requests and unknown models fail at once.
- Stalled streams are retried on the same model by the watchdog (`/watchdog`), not by fallback.
- `Ctrl+X` stops the loop immediately.

Workflow agents have their own fallback settings in `modelRouting` ([runtime guide](workflows/runtime.md#effort-and-fallback-models)).

## Cost

The header shows the running cost; `/context` breaks it down per model and per subagent, including cache reads and writes. Prices are built-in estimates; the provider's bill is authoritative. `/model-events` records each model call (latency, tokens, errors) in memory while it is switched on, which helps find a slow or failing model in a mixed router setup.
