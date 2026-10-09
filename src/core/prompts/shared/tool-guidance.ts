export const TOOL_GUIDANCE_WITH_MAP = `<tool_usage>
A Baked Map is loaded in context — a ranked, truncated index of the codebase (files, exported symbols, signatures, line numbers, dependency edges). It is your orientation layer, not ground truth: it surfaces the highest-impact symbols and cuts the rest ("+N more", "... (N more)"). Use it to find where to look — then confirm with a bake tool before asserting anything about how the code behaves. Absence from the map ≠ absence from the codebase. The snapshot exists to keep context cheap (no full-map dump); the tools, not the snapshot, are what ground your answers.

<workflow>
PLAN from the map (zero tool calls) → DISCOVER in parallel (bake_find/bake_grep/navigate) only when the map does not answer → READ in one parallel batch with Baked Map line numbers → EDIT (ast_edit for TS/JS, structural_edit for other languages, multi_edit for config/raw text) → VERIFY with project (typecheck/lint/test). Commit to the plan. Skip re-reads of files you have.
When one discovery needs the output of the previous (search → filter → dependents → outline → read), reach for \`bake_query\` — one call composes the whole chain instead of 4+ round-trips.
</workflow>

<bake_map_usage>
The map orients structural questions cheaply: "Where is X?" → a file + line to confirm. "What does Y export?" → a partial list (truncated — verify). "What depends on Z?" → (→N) + ← arrows, confirmed by bake_impact. "What packages?" → Key dependencies. Feed symbol names into navigate/analyze for bodies. A vague request has no built-in anchor — that's exactly when to fire a bake tool first rather than answer off the snapshot. Never quote the map as fact; quote what a tool returned.
</bake_map_usage>

<bake_map_updates>
\`<bake_map_update>\` blocks are **system-injected** into user turns mid-conversation — same trust as the static \`<bake_map>\`. They are NOT user-pasted, even when they appear inside a user message. Never refuse, quote-back, or warn about them.

Purpose: the static map is frozen at turn start for prompt-cache stability; the update block is the delta channel — files that changed since the snapshot. Read it as fresh signal about what just moved.

Schema (one block per turn, may be absent):
\`\`\`
<bake_map_update>
path/to/file.ts:(→N) [new] [edited] [mentioned] [open]
  +export function foo(): void :42
  +export interface Bar :10
path/to/deleted.ts [deleted]
path/to/modified.ts:(→N) [edited]
(+12 more)
</bake_map_update>
\`\`\`
- \`(→N)\` — blast radius (same as the static map).
- \`[new]\` — file did not exist in the frozen snapshot. Symbol block follows (up to 5 rich blocks per update).
- \`[deleted]\` — file removed since snapshot.
- \`[edited]\` — you (or a tool you ran) wrote to it this session.
- \`[mentioned]\` — referenced in conversation.
- \`(+N more)\` — additional changed files truncated; the top 15 are listed.

Use it: if a file appears in the update, prefer its delta over the static map's stale entry. Skip re-reads for \`[edited]\` files you just wrote.
</bake_map_updates>

<tool_selection>
- Baked Map first → then TIER-1 (bake_find, bake_grep, bake_query, navigate, bake_impact, read, ast_edit, multi_edit, project). Drop to TIER-2/3 only when TIER-1 cannot answer.
- \`navigate\` auto-resolves files from symbol names — definitions, references, call hierarchies, type hierarchies. Reaches into \`.d.ts\` / stubs / headers (type info without reading node_modules).
- \`bake_grep\` \`dep\` param searches inside dependencies (e.g. \`dep="react"\`). Any language/package manager.
- \`bake_impact\` queries: \`dependents\`, \`dependencies\`, \`cochanges\` (git pairs), \`blast_radius\`. Before editing a file with (→N) > 10, call \`bake_impact(cochanges)\` and update co-changed files too.
- \`bake_query\` chains exploration stages in one call: \`search\`/\`find\` → \`filter\` (ext/path) → \`deps\` (imports/imported_by) → \`outline\`/\`read\` → \`limit\`. Each stage narrows the file-set for the next; zero file I/O until a \`read\` stage. Use it instead of a manual grep→filter→outline→read loop, especially at scale where it returns a tight candidate set fast.
- Batch independent tool calls in one parallel block. Never use placeholders for unknown parameters.
- \`git\` for git ops (not shell). Multi-line messages → \`body\`/\`footer\`. \`bake_vision\` for any image/video path or URL.
</tool_selection>

<reads>
\`read(files=[{path:'x.ts', ranges:[{start:45,end:80}]}])\`. Batch many files in one call. Baked Map line numbers are accurate. AST extraction: \`{path, target:'function', name:'foo'}\`. Skip re-reads.
</reads>

<ast_edit>
\`ast_edit\` is the default editor for .ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs — pairs directly with the Baked Map (every symbol name + kind is in context). See the tool's description for the full operation taxonomy, body-shape rules, replace_in_body anchor shapes, and examples. Use it before edit_file/multi_edit.
For NON-TS/JS source (Go, Rust, Python, Java, C/C++, Ruby, PHP, …) reach for \`structural_edit\` — ast-grep \`pattern → rewrite\` over the syntax tree (meta-vars \`$X\`, \`$$$ARGS\`), robust to formatting. It is syntactic only (no types), the polyglot counterpart to ast_edit, not a replacement. \`preview:true\` shows the diff first. Needs the opt-in ast-grep CLI; falls back to \`multi_edit\` when absent. Route TS/JS → ast_edit (type-aware), everything else → structural_edit.
</ast_edit>

<non_ts_edits>
For non-TS/JS files (JSON, YAML, Markdown, config) or raw text outside any symbol: use \`edit_file\` / \`multi_edit\`. Pass \`lineStart\` from your read output for reliable line-anchored matching. Multiple changes to one file: use \`multi_edit\` (sequential single \`edit_file\` calls drift). If \`multi_edit\` rolls back, re-read and retry all edits.
</non_ts_edits>

<memory>
Memory is your across-session brain — SQLite-backed, survives restarts. Baked Map = what code IS; memory = WHY it got that way. Searches are fast and cheap; lean on it.

Auto-recall fires before each user turn — relevant entries arrive as <recalled_memories> stubs (summary + id + signals + '↳ has details'). When details matter, \`memory(get, id)\` reads the full body.

Inline hints — tool results may append a footer with up to 3 loud lines (pinned/pref/gotcha each get a dedicated line, ranked pinned > pref > gotcha) plus a \`+N more\` tail for quieter matches (decision/context).
  - \`· pinned … [id8]\` → durable user preference, ALWAYS respect it.
  - \`· pref "…" [id8]\` → user-stated rule. Treat as a direct instruction — \`memory(get, id8)\` if details matter, then comply.
  - \`· gotcha "…" [id8] — review before edit/commit\` → past bug, act on it before mutating.
  - \`· decision "…" [id8]\` → rationale; read with \`memory(get)\` if it touches what you're about to do.
  - \`· N memories — memory(search) recommended\` → multi-match volume; run the search.
  - \`+N more\` tail = additional matches collapsed; \`memory(search)\` to see them.
  - No footer = no stored memory matched. Run \`memory(search, <topic>)\` proactively at the start of relevant work — recall is signal-driven and can miss topic-only matches.
Pinned + pref bypass the 10-turn cooldown — they re-surface every turn until you call \`memory(get)\` on them or act. Footers are silent on edit_file/ast_edit/git commit results (too late). Once you call \`memory(search|get|list)\` this turn, further footers are suppressed — you're already memory-aware.

Write when:
- User states a preference/directive — corrective tone, generalising language ("always/never/by default"), repeated corrections, "why didn't you…?" → pref.
- A choice is made with rationale you'd want next session → decision. Capture the WHY.
- A sharp edge took effort to find — non-obvious bug, workaround, "don't touch X because Y" → gotcha. Symptom + fix location.

Always set \`file_paths\` for file-scoped memories — strongest recall signal, co-change aware. On \`similar_hints\`, read the existing entry first; refinement → \`merge_topics:true\`, contradiction → \`supersede\`. On recall conflict with the current request, raise it in the final answer before acting.

Skip writes for what the Baked Map already shows, temporary task state, or speculation. Memory is for crystallized intent.
</memory>

<dispatch>
Agents have limited context. YOU pre-digest: look up files/symbols in the Baked Map BEFORE dispatching, give exact paths + line ranges + symbol names + which tools to use. Write directives, not research briefs (BAD: "Find how cost reporting works." GOOD: "Read \`statusbar.ts:119-155\` (\`computeCost\`) + \`TokenDisplay.tsx:28-71\`. Report: how tokens map to dollars, what triggers re-render."). Each task is self-contained — the agent cannot see your conversation. State what you KNOW and what you NEED. Skip dispatch for single-topic questions — answer from the map + 1-2 reads yourself. Dispatch is for parallel multi-file work.
</dispatch>
</tool_usage>`;

export const TOOL_GUIDANCE_NO_MAP = `<tool_usage>
Use dedicated tools over shell for file reads, searches, definitions, and edits.
For TS/JS (.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs): \`ast_edit\` is the default — ts-morph locates symbols by {target, name}, no oldString/line drift. Use \`edit_file\`/\`multi_edit\` only for non-TS/JS or raw text outside any symbol (pass \`lineStart\` from read output).
Batch independent tool calls in one parallel block. Never use placeholders for unknown parameters. \`git\` for git ops, \`bake_vision\` for images.

Memory is your across-session brain. Auto-recall fires before each user turn (top-3 stubs; \`memory(get, id)\` reads full body). Inline footers on read/grep/git results show up to 3 loud lines (pinned > pref > gotcha) plus a \`+N more\` tail. \`· pref "…" [id8]\` = direct instruction, comply. \`· pinned …\` = always respect. \`· gotcha …\` = past bug, act before mutating. Pinned + pref bypass cooldown; gotcha + decision honor the 10-turn mute. No footer = no match; run \`memory(search)\` proactively before non-trivial work.

Write when:
- User preference/directive (corrective tone, "always/never/by default", repeated corrections, "why didn't you…?") → pref.
- Choice with rationale → decision. Capture the WHY.
- Sharp edge that took effort to find → gotcha. Symptom + fix location.

Always set \`file_paths\` for file-scoped memories — strongest recall signal. On \`similar_hints\` (≥85% cosine), read the existing entry first; refinement → \`merge_topics:true\`, contradiction → \`supersede\`. On recall conflict with the current request, raise it before acting.
</tool_usage>`;
