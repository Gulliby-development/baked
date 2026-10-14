import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const helper = JSON.stringify(resolve(import.meta.dir, "../src/headless/exit-trace.ts"));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(body: string): Promise<{ code: number; lines: Record<string, unknown>[] }> {
  const dir = mkdtempSync(join(tmpdir(), "baked-exit-trace-"));
  dirs.push(dir);
  const script = join(dir, "script.ts");
  writeFileSync(script, `import { traceProcessExit } from ${helper};\nconst untrace = traceProcessExit("run");\n${body}\n`);
  const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "pipe" });
  const code = await child.exited;
  const text = await new Response(child.stderr).text();
  return {
    code,
    lines: text
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

// #1115: md-site's runner exited 1 with nothing on stderr and no event.
test("an exit the workflow command did not return through says so on stderr (#1115)", async () => {
  const { code, lines } = await run("process.exit(1);");
  expect(code).toBe(1);
  expect(lines).toMatchObject([{ code: "PROCESS_EXITED", exitCode: 1, command: "run" }]);
});

test("an uncaught error and an unhandled rejection are written with their stack (#1115)", async () => {
  const thrown = await run('setTimeout(() => { throw new Error("worker state lost"); }, 0);');
  expect(thrown.code).toBe(1);
  expect(thrown.lines).toHaveLength(1);
  expect(thrown.lines[0]).toMatchObject({ code: "UNCAUGHT_EXCEPTION", message: "worker state lost", command: "run" });
  expect(String(thrown.lines[0]?.stack)).toContain("worker state lost");
  const rejected = await run('Promise.reject(new Error("lease lost"));');
  expect(rejected.code).toBe(1);
  expect(rejected.lines).toMatchObject([{ code: "UNHANDLED_REJECTION", message: "lease lost" }]);
});

test("a command that returns normally writes nothing", async () => {
  const { code, lines } = await run("untrace();\nprocess.exit(0);");
  expect({ code, lines }).toEqual({ code: 0, lines: [] });
});
