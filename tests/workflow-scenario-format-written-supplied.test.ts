import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { SUPPORTED_LANGUAGES, isNoRow } from "../src/core/intelligence/language-records.js";
import { detectLanguageFromPath } from "../src/core/intelligence/types.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { FILE_FORMATTERS, formatWrittenChecks, rangesWithout } from "../src/core/workflows/format-written.js";
import { newId } from "../src/core/workflows/store.js";
import { suppliesWhole } from "../src/core/workflows/supplied-drift.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// #2504, R81 seqmill-update: the request gave `tests/test_stats_no_header.py` as a create diff, the
// host applied it (51 lines), and the repository runs `ruff check` but no `ruff format` gate, so the
// run's checks left the formatter out. The format-written check (#1837) held the new file to
// `ruff format`, its fixer rewrapped 14 rows, and the delivered file (87 lines) left the bytes the
// brief said to write exactly. A created file the request supplies whole is now checked by an
// advisory `<gate>-supplied` check with no fixer: the formatter is recorded, the bytes are kept.

const IS_WIN = process.platform === "win32";
const bin = mkdtempSync(join(tmpdir(), "baked-fake-ruff-"));
const savedPath = process.env.PATH;
afterAll(async () => {
  process.env.PATH = savedPath;
  await removeTempDir(bin);
});
// A stand-in for `ruff format`: "x=1" is unformatted, "x = 1" formatted. `--range=S-E` formats lines
// S to E-1 and `--range=S` from line S to the end, as ruff does.
if (!IS_WIN) {
  writeFileSync(
    join(bin, "ruff"),
    `#!/bin/sh
[ "$1" = "format" ] || exit 0
shift
check=0
range=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check=1; shift;;
    --range=*) range="\${1#--range=}"; shift;;
    --help) echo "  --range <RANGE>  Format only a range of the file"; exit 0;;
    *) break;;
  esac
done
bad=0
files=""
for a in "$@"; do
  if [ -d "$a" ]; then files="$files $(find "$a" -name '*.py' | sort)"; else files="$files $a"; fi
done
for f in $files; do
  total=$(wc -l < "$f")
  start=1
  end=$total
  if [ -n "$range" ]; then
    start=\${range%%-*}
    case "$range" in *-*) end=$((\${range#*-} - 1));; esac
  fi
  if [ $check = 1 ]; then
    if sed -n "\${start},\${end}p" "$f" | grep -q 'x=1'; then echo "Would reformat: $f"; bad=1; fi
  else
    sed "\${start},\${end}{s/x=1;y=2/x = 1\\n    y = 2/;s/x=1/x = 1/;}" "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
done
exit $bad
`,
  );
  chmodSync(join(bin, "ruff"), 0o755);
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
}

// ruff is the linter only, so `ruff format --check .` is offered, not preselected.
const PROJECT = {
  "pyproject.toml": "[project]\nname = 'seqmill'\nversion = '0.1.0'\n\n[tool.ruff]\nline-length = 100\n",
  "seqmill/old.py": "x = 1\n",
};
const DIFF = ["Add this test file exactly:", "```diff", "--- /dev/null", "+++ b/tests/test_new.py", "@@ -0,0 +1 @@", "+x=1", "```"].join("\n");
const BLOCK = ["Write `tests/test_new.py` with exactly this content:", "```python", "x=1", "```"].join("\n");

describe("a created file the request supplies whole (#2504)", () => {
  test("a create diff and a whole block supply the file; a listing, another file and no request do not", () => {
    expect(suppliesWhole(DIFF, "tests/test_new.py")).toBe(true);
    expect(suppliesWhole(BLOCK, "tests/test_new.py")).toBe(true);
    expect(suppliesWhole(DIFF, "tests/test_other.py")).toBe(false);
    expect(suppliesWhole("", "tests/test_new.py")).toBe(false);
    expect(suppliesWhole("Signatures:\n```python\n# tests/test_new.py\ndef f(): ...\n```", "tests/test_new.py")).toBe(false);
  });

  // Every language with a formatter row: its fixture's code files, created and supplied, get only
  // advisory checks without a fixer; the same files the model writes keep the required, fixed check.
  const fixtures = join(import.meta.dir, "fixtures", "languages");
  for (const language of SUPPORTED_LANGUAGES)
    test(`${language}: ${isNoRow(FILE_FORMATTERS[language]) ? "no formatter row" : "advisory, never fixed"}`, () => {
      const { files } = JSON.parse(readFileSync(join(fixtures, `${language}.json`), "utf8")) as { files: Record<string, string> };
      const root = mkdtempSync(join(tmpdir(), "baked-format-supplied-"));
      try {
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), text);
        }
        const writes = Object.keys(files).filter((p) => detectLanguageFromPath(p) === language).map((path) => ({ path, action: "create" }));
        const which = (command: string) => `/usr/bin/${command}`;
        const own = formatWrittenChecks(root, [], writes, which);
        const supplied = formatWrittenChecks(root, [], writes, which, undefined, undefined, { supplied: () => true });
        if (isNoRow(FILE_FORMATTERS[language])) {
          expect(own).toEqual([]);
          expect(supplied).toEqual([]);
          return;
        }
        expect(supplied.map((c) => c.id.replace(/-supplied$/, "-written"))).toEqual(own.map((c) => c.id));
        for (const check of supplied) {
          expect(check.id).toEndWith("-supplied");
          expect(check.required).toBe(false);
          expect(check.fix).toBeUndefined();
          expect(check.fixPaths).toBeUndefined();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
});

describe("the changed lines a request supplies leave the format-written range (#2596)", () => {
  test("rangesWithout splits a range around the supplied lines and keeps a line without a word", () => {
    const text = "a\nb\nc\n}\ne\n";
    expect(rangesWithout([[1, 5]], new Set([2, 4]), text)).toEqual([[1, 1], [3, 5]]);
    expect(rangesWithout([[1, 2]], new Set([1, 2]), text)).toEqual([]);
    expect(rangesWithout([[1, 3]], new Set(), text)).toEqual([[1, 3]]);
  });

  // R84 keeplint-update: the request's modify diff added a line over ruff's limit to
  // tests/test_readme.py, `ruff format --range=66-67` rewrapped it, and supplied_drift then
  // reported the file. Every language with a range formatter: an edited file whose changed lines
  // the request supplies gets no range check; the same lines the model wrote do.
  const fixtures = join(import.meta.dir, "fixtures", "languages");
  for (const language of SUPPORTED_LANGUAGES) {
    const row = FILE_FORMATTERS[language];
    if (isNoRow(row) || !row.some((f) => f.range)) continue;
    test(`${language}: supplied changed lines are left out of the range check`, () => {
      const { files } = JSON.parse(readFileSync(join(fixtures, `${language}.json`), "utf8")) as { files: Record<string, string> };
      const root = mkdtempSync(join(tmpdir(), "baked-format-supplied-lines-"));
      try {
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), text);
        }
        const path = Object.keys(files).find((p) => detectLanguageFromPath(p) === language && /\w/.test(files[p] ?? ""));
        if (!path) throw new Error(`no ${language} file`);
        const text = files[path] ?? "";
        // The run added the file's last line with a word in it.
        const lines = text.split("\n");
        const added = lines.map((line, i) => (/\w/.test(line) ? i : -1)).filter((i) => i >= 0).at(-1) ?? 0;
        const before = lines.filter((_, i) => i !== added).join("\n");
        const writes = [{ path, action: "modify" }];
        const which = (command: string) => `/usr/bin/${command}`;
        const accepts = () => true;
        const own = formatWrittenChecks(root, [], writes, which, () => before, accepts);
        const supplied = formatWrittenChecks(root, [], writes, which, () => before, accepts, { suppliedLines: () => new Set([added + 1]) });
        expect(own.some((c) => /-lines/.test(c.id))).toBe(true);
        expect(supplied.filter((c) => /-lines/.test(c.id))).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe.skipIf(IS_WIN)("scenario: R81 seqmill-update, ruff format on a create diff the host applied (#2504)", () => {
  async function scenario(prompt: string, content: string, path = "tests/test_new.py", action = "create") {
    const f = workflowFixture();
    try {
      for (const [path, text] of Object.entries(PROJECT)) {
        mkdirSync(dirname(join(f.root, path)), { recursive: true });
        writeFileSync(join(f.root, path), text);
      }
      const original = f.executor.execute.bind(f.executor);
      f.executor.execute = async (request: ExecutionRequest) => {
        const out = await original(request);
        if (request.profile.output === "plan") {
          const plan = out.output as { markdown: string; taskGraph: { specHash: string; planHash: string; tasks: { writes: { path: string; action: string }[] }[] } };
          plan.taskGraph.tasks[0]?.writes.push({ path, action });
          plan.taskGraph.specHash = hashJson(fixtureSpec);
          plan.taskGraph.planHash = hashBytes(plan.markdown);
        }
        if (request.profile.output === "implementation") {
          mkdirSync(dirname(join(f.root, path)), { recursive: true });
          writeFileSync(join(f.root, path), content);
        }
        return out;
      };
      const run = await f.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy: f.policy });
      await f.service.drive(run.runId, new AbortController().signal);
      await f.approve(run.runId);
      const view = await f.service.drive(run.runId, new AbortController().signal);
      const checks = f.service.store.artifacts(run.runId).map((a) => a.logical_path).filter((p) => p.includes("ruff-format"));
      const drift = f.service.store.eventsOfType(run.runId, "decision.would_stop").filter((e) => e.payload.reason === "supplied_drift");
      return { view, delivered: readFileSync(join(f.root, path), "utf8"), checks, drift };
    } finally {
      await f.dispose();
    }
  }

  test("the supplied file keeps the request's bytes, and the formatter is only recorded", async () => {
    const { view, delivered, checks, drift } = await scenario(`Create ready value.\n\n${DIFF}`, "x=1\n");
    expect(view.status).toBe("completed");
    expect(delivered).toBe("x=1\n");
    expect(checks.some((p) => p.includes("ruff-format-supplied"))).toBe(true);
    expect(checks.some((p) => p.includes("ruff-format-written"))).toBe(false);
    expect(drift).toEqual([]);
  }, 60000);

  test("the same file the model writes on its own is still formatted (#1837)", async () => {
    const { view, delivered } = await scenario("Create ready value", "x=1\n");
    expect(view.status).toBe("completed");
    expect(delivered).toBe("x = 1\n");
  }, 60000);

});
