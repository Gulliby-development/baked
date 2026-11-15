import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { gitBaseline, sourceManifest } from "../src/core/verification/snapshot.js";
import { gitFailure, gitRead, SILENT_GIT_RETRY_MS } from "../src/core/workflows/delivery-git.js";

// R109 datefold (Swift, Windows 11), #3041: 35 ms after 53 s of `swift` checks, `git ls-files`
// ended with a non-zero code and no output, and the run blocked host_error with
// `Cannot read repository baseline: ` and nothing after it. The same command passed on resume.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/**
 * A repository and a `git` on PATH that fails `ls-files` silently with exit 3 the first `fails`
 * times, and runs the real Git otherwise.
 */
function repository(fails: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "baked-git-read-")));
  const bin = mkdtempSync(join(tmpdir(), "baked-git-read-bin-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(bin, { recursive: true, force: true }));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(root, "a.txt"), "a\n");
  spawnSync(real, ["init", "-q"], { cwd: root });
  spawnSync(real, ["add", "a.txt"], { cwd: root });
  const counter = join(bin, "count");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase " $* " in *" ls-files "*)\n  n=$(cat '${counter}' 2>/dev/null || echo 0)\n  if [ "$n" -lt ${String(fails)} ]; then echo $((n+1)) > '${counter}'; exit 3; fi;;\nesac\nexec '${real}' "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
  cleanups.push(() => {
    process.env.PATH = path;
  });
  return { root, calls: () => (existsSync(counter) ? Number(spawnSync("cat", [counter], { encoding: "utf8" }).stdout) : 0) };
}

describe.skipIf(process.platform === "win32")("scenario: a git read that ends with no output (#3041)", () => {
  test("a silent failure is read again once, and the baseline completes", async () => {
    const { root, calls } = repository(1);
    // On main: Error: Cannot read repository baseline: (and nothing after it).
    expect(Object.keys(await sourceManifest(root))).toContain("a.txt");
    expect(calls()).toBe(1);
    expect((await gitBaseline(root))?.tracked).toEqual(["a.txt"]);
  });

  test("a read that fails twice names the command, the code and the first failure", async () => {
    const { root } = repository(2);
    const error = await sourceManifest(root).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toBe(
      `Cannot read repository baseline: git ls-files exited with 3 and printed nothing; it was run again after ${String(SILENT_GIT_RETRY_MS)} ms because the first run (git ls-files exited with 3 and printed nothing) printed nothing`,
    );
  });
});

describe("gitFailure and gitRead (#3041)", () => {
  test("the message names the command, the code (with the NTSTATUS in hex), a signal and stderr", () => {
    expect(gitFailure(["ls-files", "-z", "--cached"], { code: 3221225794, stderr: "" })).toBe("git ls-files exited with 3221225794 (0xC0000142) and printed nothing");
    expect(gitFailure(["status", "--porcelain=v1"], { code: 128, stderr: "fatal: not a git repository\n" })).toBe("git status exited with 128: fatal: not a git repository");
    expect(gitFailure(["ls-files"], { code: 143, stderr: "", signal: "SIGTERM" })).toBe("git ls-files was ended by SIGTERM and printed nothing");
  });

  test("only a silent failure is run again, once", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    const script = (...results: { code: number; stdout: string; stderr: string }[]) => {
      let i = 0;
      return async () => results[Math.min(i++, results.length - 1)] as { code: number; stdout: string; stderr: string };
    };
    expect(await gitRead(script({ code: 3, stdout: "", stderr: "" }, { code: 0, stdout: "a\0", stderr: "" }), wait)).toMatchObject({ code: 0, retriedAfter: { code: 3 } });
    expect(waits).toEqual([SILENT_GIT_RETRY_MS]);
    expect(await gitRead(script({ code: 128, stdout: "", stderr: "fatal: bad" }, { code: 0, stdout: "", stderr: "" }), wait)).toMatchObject({ code: 128 });
    expect(await gitRead(script({ code: 3, stdout: "", stderr: "" }, { code: 3, stdout: "", stderr: "" }, { code: 0, stdout: "", stderr: "" }), wait)).toMatchObject({ code: 3 });
    expect(waits).toHaveLength(2);
  });
});
