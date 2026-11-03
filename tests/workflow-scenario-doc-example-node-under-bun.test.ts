import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeUnderBun, runDocExamples, UNDER_BUN } from "../src/core/verification/doc-examples.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";

// Bench round 88 (#2678): pokerank (plain JavaScript, `bun test` and bun-launched eslint and
// prettier) documented every README example as `node bin/pokerank.js ...`. node is no program the
// run's checks start, so the host ran none of them, and the broken first example (#2648) passed.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const fence = "```";

const POKERANK = {
  "package.json": JSON.stringify({ name: "pokerank", type: "module", bin: { pokerank: "bin/pokerank.js" } }),
  "bin/pokerank.js": [
    'import { readFileSync } from "node:fs";',
    "const [cmd, file] = process.argv.slice(2);",
    'if (cmd !== "showdown") { console.log("usage: pokerank showdown FILE"); process.exit(2); }',
    'const board = readFileSync(file, "utf8").split("\\n")[0].split(" ").slice(1);',
    'console.log(board.length === 5 ? "ann wins" : `pokerank: ${file}:1: board needs 5 cards`);',
    "",
  ].join("\n"),
  "hand.txt": "board 2c 7d 9h Jc Kd\nseat ann 100 Ah Kh\n",
};

async function readmeRun(readme: string, executables: string[]) {
  const root = mkdtempSync(join(tmpdir(), "baked-node-under-bun-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(POKERANK)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return runDocExamples(new ProcessScope(), [{ path: "README.md", text: readme }], {
    root,
    files: Object.keys(POKERANK),
    executables,
    signal: new AbortController().signal,
    sandbox: () => null,
  });
}

describe("scenario: R88 pokerank, a README's node examples in a bun project (#2678)", () => {
  test("the examples run under bun: a right output matches, a wrong one is a mismatch, with the note", async () => {
    const readme = [
      "Run a showdown:",
      "",
      `${fence}console`,
      "$ node bin/pokerank.js showdown hand.txt",
      "ann wins",
      "$ node bin/pokerank.js deal",
      "usage: pokerank deal FILE",
      fence,
    ].join("\n");
    const results = await readmeRun(readme, ["bun"]);
    expect(results.map((r) => r.status)).toEqual(["match", "mismatch"]);
    for (const result of results) expect(result.reason).toBe(UNDER_BUN);
    expect(results[1]?.firstDifference).toMatchObject({ expected: "usage: pokerank deal FILE", actual: "usage: pokerank showdown FILE" });
  });

  test("node asked about itself, and a project whose checks start node, are left as they were", async () => {
    const readme = [`${fence}console`, "$ node --version", "v22.0.0", fence].join("\n");
    const [version] = await readmeRun(readme, ["bun"]);
    expect(version?.status).toBe("not_run");
    expect(version?.reason).toContain("node is not a program the run's checks");
    // Checks that start no bun give no alias: node stays refused.
    const [refused] = await readmeRun([`${fence}console`, "$ node bin/pokerank.js showdown hand.txt", "ann wins", fence].join("\n"), ["cargo"]);
    expect(refused?.status).toBe("not_run");
  });

  test("the alias rule", () => {
    expect(nodeUnderBun(["node", "bin/x.js"], ["bun"])).toBe(true);
    expect(nodeUnderBun(["node", "bin/x.js"], ["bun", "node"])).toBe(false);
    expect(nodeUnderBun(["node", "-e", "1"], ["bun"])).toBe(false);
    expect(nodeUnderBun(["node"], ["bun"])).toBe(false);
    expect(nodeUnderBun(["deno", "run", "x.ts"], ["bun"])).toBe(false);
  });
});
