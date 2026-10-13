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

Servers connect at startup, at most 5 at a time; a failed one is retried 3 times with backoff, and a crashed `stdio` server restarts. `/mcp` shows status and tools: type to filter, `Ctrl+A` adds, `Ctrl+D` deletes, `Ctrl+T` toggles, `Ctrl+R` retries, `Tab` switches to the tool browser. The desktop app has the same in a project's MCP servers page, over the local API's [`/v1/mcp`](desktop/api.md#mcp-servers). Headless runs connect the same servers; `baked mcp list` prints them (`--json` for scripts, `--check` connects each enabled one, lists its tools and exits 1 when one fails), and `baked mcp enable|disable|remove NAME [--scope global|project]` changes the config. Workflow agents use MCP tools only where a profile and the run policy grant them ([MCP tools](workflows/runtime.md#mcp-tools)).

## Hooks

Hooks run shell commands at lifecycle events. The format is the one Claude Code uses, so existing `.claude/settings.json` hooks work unchanged. Sources are merged in this order, and every matching hook runs:

1. `~/.claude/settings.json`
2. `.claude/settings.json`
3. `.claude/settings.local.json`
4. the global BAKED `config.json`
5. `.baked/config.json`

`"disableAllHooks": true` in any of them turns hooks off. `/hooks` lists active hooks and toggles them for the session. In the desktop app, the project's Hooks section lists them with their files and switches an event off until the project's backend restarts (`GET /v1/hooks`, `POST /v1/hooks/session` in the [desktop API](desktop/api.md)); neither writes a file, and hooks are added or changed only in the files above.

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
| `UserPromptSubmit` | Before a typed message goes to the model; exit code `2` drops the message and shows the reason | |
| `Stop`, `StopFailure` | When a turn completes or fails (not when it is interrupted) | |
| `SessionStart`, `SessionEnd` | When a chat session starts, resumes, is cleared, compacted or forked (desktop chats), and when it ends | `SessionStart`: `startup`, `resume`, `clear`, `compact`, `fork`; `SessionEnd`: `clear`, `prompt_input_exit`, `other` |
| `PreCompact`, `PostCompact` | Around compaction | `manual` (`/compact`, the desktop Compact button) or `auto` (the context filled up) |
| `SubagentStart`, `SubagentStop` | When a subagent the turn dispatched starts or ends, in the terminal app, the headless CLI and desktop chats | The subagent's role: `explore`, `code`, `investigate` |
| `Notification` | When BAKED asks for a permission or a question, and when a workflow run starts waiting | `permission_prompt`, `question`, `run_attention` |
| `RunAttention` | When a workflow run starts waiting for a person ([runtime guide](workflows/runtime.md#notifications-when-a-run-waits)) | Request kind or blocked reason |

Tool names follow Claude Code (`Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob`, `WebSearch`, `Agent`); BAKED maps its own tools to them. A hook entry may set `async`, `timeout` (seconds, default 10), `once` (once per session) and `if` (a glob on the first string argument, such as `Edit(*.ts)`).

A hook receives JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`; `prompt` for `UserPromptSubmit`, `source` for `SessionStart`, `reason` for `SessionEnd`, `message`, `title` and `notification_type` for `Notification`, `trigger` for `PreCompact` and `PostCompact`, `agent_id` and `agent_type` for `SubagentStart` and `SubagentStop`, `stop_hook_active` for `Stop` and `SubagentStop`, `error` for `StopFailure`, `run_attention` for `RunAttention`). Exit code `0` is success, `2` blocks the call, anything else logs a warning. On stdout, a `PreToolUse` hook may return `hookSpecificOutput` with `permissionDecision: "deny"`, an `updatedInput` or `additionalContext`; a `PostToolUse` hook may return `additionalContext`. `additionalContext` from `SessionStart` and `UserPromptSubmit` hooks, or their plain (non-JSON) stdout, is sent to the model ahead of the next message, in the terminal app, the headless CLI and desktop chats alike. Hooks are stopped with the agent on `Ctrl+X`.

## Skills

A skill is a folder with a `SKILL.md` (frontmatter `name` and `description`, then instructions) and optional supporting files. BAKED looks for skills in:

| Scope | Folders |
| --- | --- |
| Global | `~/.baked/skills/`, `~/.agents/skills/`, `~/.claude/skills/` |
| Project | `.baked/skills/`, `.agents/skills/`, `.claude/skills/` |

A project skill wins over a global one with the same name; symlinked collections are deduplicated. `Ctrl+S` or `/skills` opens the manager: **Search** the [skills.sh](https://skills.sh) catalog (installed with `bunx skills`, `npx` as the fallback), **Installed** skills, and **Active** skills of this session, which can be toggled. An active skill's content goes into the system prompt, so keep `SKILL.md` short. In the desktop app the project's **Skills** screen does the same: installed project and global skills with Open and Remove, and the skills.sh catalog with Install for this project or all projects. With `agentFeatures.agentSkills` on, the agent can search, install and load skills itself; installing asks for approval.

Workflow agents use skills from `baked/skills/ID/SKILL.md` in the repository, frozen by hash; see the [runtime guide](workflows/runtime.md#import-export-and-retention).

## Custom commands

See [custom commands](custom-commands.md).
