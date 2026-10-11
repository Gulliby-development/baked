# Extensions

## MCP servers

BAKED connects to MCP servers and offers their tools next to the built-in ones as `mcp__<server>__<tool>`. Add `mcpServers` to the global or project config; a project entry overrides a global one with the same name.

```json
{
  "mcpServers": [
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." }
    },
    {
      "name": "remote",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  ]
}
```

| Field | Does |
| --- | --- |
| `name` | Display name and tool prefix (required) |
| `transport` | `stdio` (default, a local subprocess), `http` (Streamable HTTP) or `sse` (legacy) |
| `command`, `args`, `env` | The subprocess for `stdio` |
| `url`, `headers` | The endpoint for `http` and `sse` |
| `timeout` | Per tool call, in ms (default 30000) |
| `disabled` | Keep the entry but do not connect |

Servers connect at startup, at most 5 at a time; a failed one is retried 3 times with backoff, and a crashed `stdio` server restarts. `/mcp` shows status and tools: type to filter, `Ctrl+A` adds, `Ctrl+D` deletes, `Ctrl+T` toggles, `Ctrl+R` retries, `Tab` switches to the tool browser. Headless runs connect the same servers.

## Hooks

Hooks run shell commands at lifecycle events. The format is the one Claude Code uses, so existing `.claude/settings.json` hooks work unchanged. Sources are merged in this order, and every matching hook runs:

1. `~/.claude/settings.json`
2. `.claude/settings.json`
3. `.claude/settings.local.json`
4. the global BAKED `config.json`
5. `.baked/config.json`

`"disableAllHooks": true` in any of them turns hooks off. `/hooks` lists active hooks and toggles them for the session.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./scripts/check-command.sh", "if": "Bash(rm -rf *)" }]
      }
    ]
  }
}
```

| Event | Fires | Matcher |
| --- | --- | --- |
| `PreToolUse` | Before a tool runs | Tool name |
| `PostToolUse`, `PostToolUseFailure` | After a tool succeeds or fails | Tool name |
| `UserPromptSubmit` | On a user message | |
| `Stop`, `StopFailure` | When a turn ends | |
| `SessionStart`, `SessionEnd` | At session boundaries | |
| `PreCompact`, `PostCompact` | Around compaction | |
| `SubagentStart`, `SubagentStop` | When a dispatched agent starts or ends | |
| `Notification` | System notifications | |
| `RunAttention` | When a workflow run starts waiting for a person ([runtime guide](workflows/runtime.md#notifications-when-a-run-waits)) | Request kind or blocked reason |

Tool names follow Claude Code (`Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob`, `WebSearch`, `Agent`); BAKED maps its own tools to them. A hook entry may set `async`, `timeout` (seconds, default 10), `once` (once per session) and `if` (a glob on the first string argument, such as `Edit(*.ts)`).

A hook receives JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`; `run_attention` for `RunAttention`). Exit code `0` is success, `2` blocks the call, anything else logs a warning. On stdout, a `PreToolUse` hook may return `hookSpecificOutput` with `permissionDecision: "deny"`, an `updatedInput` or `additionalContext`; a `PostToolUse` hook may return `additionalContext`. Hooks are stopped with the agent on `Ctrl+X`.

## Skills

A skill is a folder with a `SKILL.md` (frontmatter `name` and `description`, then instructions) and optional supporting files. BAKED looks for skills in:

| Scope | Folders |
| --- | --- |
| Global | `~/.baked/skills/`, `~/.agents/skills/`, `~/.claude/skills/` |
| Project | `.baked/skills/`, `.agents/skills/`, `.claude/skills/` |

A project skill wins over a global one with the same name; symlinked collections are deduplicated. `Ctrl+S` or `/skills` opens the manager: **Search** the [skills.sh](https://skills.sh) catalog (installed with `bunx skills`, `npx` as the fallback), **Installed** skills, and **Active** skills of this session, which can be toggled. An active skill's content goes into the system prompt, so keep `SKILL.md` short. With `agentFeatures.agentSkills` on, the agent can search, install and load skills itself; installing asks for approval.

Workflow agents use skills from `baked/skills/ID/SKILL.md` in the repository, frozen by hash; see the [runtime guide](workflows/runtime.md#import-export-and-retention).

## Custom commands

See [custom commands](custom-commands.md).
