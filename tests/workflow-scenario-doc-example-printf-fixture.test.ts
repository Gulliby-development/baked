import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { printfText, redirectFixture, runDocExamples } from "../src/core/verification/doc-examples.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";

// Bench round 88 (#2693): pokerank's README wrote its input with `printf '...' > hand.txt` and
// then ran the program on it. The host ran neither line ("needs a shell"), so the doubled `\\n`
// of the printf line (#2648) left no host evidence.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const fence = "```";

const COUNTER = {
  "package.json": JSON.stringify({ name: "linecount", type: "module" }),
  // Prints how many lines its file has, or the first line it cannot read.
  "cli.js": [
    'import { readFileSync } from "node:fs";',
    "const lines = readFileSync(process.argv[2], 'utf8').split('\\n').filter(Boolean);",
    "const bad = lines.find((l) => !/^seat \\w+$/.test(l));",
    "console.log(bad ? `bad line: ${bad}` : `${lines.length} seats`);",
    "",
  ].join("\n"),
};

async function readmeRun(lines: string[]) {
  const root = mkdtempSync(join(tmpdir(), "baked-printf-fixture-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(COUNTER)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return runDocExamples(new ProcessScope(), [{ path: "README.md", text: [`${fence}console`, ...lines, fence].join("\n") }], {
    root,
    files: Object.keys(COUNTER),
    executables: ["bun"],
    signal: new AbortController().signal,
    sandbox: () => null,
  });
}

describe("scenario: R88 pokerank, a README writes its example's input with printf (#2693)", () => {
  test("the host writes the file and the example after it reads it: a right README matches", async () => {
    const results = await readmeRun(["$ printf 'seat ann\\nseat bob\\n' > seats.txt", "$ bun cli.js seats.txt", "2 seats"]);
    expect(results.map((r) => r.status)).toEqual(["match", "match"]);
    expect(results[0]?.reason).toBe("written by the host without a shell: seats.txt");
    expect(results[1]?.inputs).toEqual([{ path: "seats.txt", content: "seat ann\nseat bob\n" }]);
  });

  test("a doubled backslash in the printf line is a mismatch whose repro can carry the file", async () => {
    const results = await readmeRun(["$ printf 'seat ann\\\\nseat bob\\n' > seats.txt", "$ bun cli.js seats.txt", "2 seats"]);
    expect(results.map((r) => r.status)).toEqual(["match", "mismatch"]);
    expect(results[1]?.firstDifference).toMatchObject({ expected: "2 seats", actual: "bad line: seat ann\\nseat bob" });
    expect(results[1]?.inputs).toEqual([{ path: "seats.txt", content: "seat ann\\nseat bob\n" }]);
  });

  test("echo and >> append; a line that shows output after a redirect is a mismatch", async () => {
    const results = await readmeRun(["$ echo seat ann > seats.txt", "$ echo seat bob >> seats.txt", "$ bun cli.js seats.txt", "2 seats", "$ echo seat cy > more.txt", "done"]);
    expect(results.map((r) => r.status)).toEqual(["match", "match", "match", "mismatch"]);
  });

  test("what is no fixture write stays a shell line", () => {
    expect(redirectFixture("printf '%s\\n' a > out.txt")).toBeNull();
    expect(redirectFixture("echo -e 'a\\nb' > out.txt")).toBeNull();
    expect(redirectFixture("printf 'a' > ../out.txt")).toBeNull();
    expect(redirectFixture("printf 'a' > /etc/out.txt")).toBeNull();
    expect(redirectFixture("cat a.txt > b.txt")).toBeNull();
    expect(redirectFixture("printf 'a > b' | tee x.txt")).toBeNull();
    expect(redirectFixture("printf 'x > y\\n' > out.txt")).toEqual({ path: "out.txt", content: "x > y\n", append: false });
  });

  test("printf escapes", () => {
    expect(printfText("a\\tb\\\\c\\101\\q 100%%")).toBe("a\tb\\cA\\q 100%");
    expect(printfText("%d")).toBeNull();
  });
});
