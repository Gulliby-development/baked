import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetFormatCache, setFormatCache } from "../../src/core/tools/auto-format.js";
import { removeTempDir } from "./temp-dir.js";

/** Deterministic ruff stand-in, with the same stdin/file distinction and a write log. */
export function installRuffFormatter() {
  const bin = mkdtempSync(join(tmpdir(), "baked-ruff-bin-"));
  const script = join(bin, "ruff.ts");
  const log = join(bin, "writes.log");
  const fail = join(bin, "fail-probe");
  writeFileSync(script, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const format = (s: string) => s.replaceAll("legacy=1", "legacy = 1").replaceAll("'keep'", '"keep"');
if (args.includes("--stdin-filename")) {
  if (existsSync(${JSON.stringify(fail)})) process.exit(1);
  process.stdout.write(format(await Bun.stdin.text()));
} else {
  const path = args.at(-1)!;
  appendFileSync(${JSON.stringify(log)}, path + "\\n");
  writeFileSync(path, format(readFileSync(path, "utf8")));
}
`);
  const launcher = join(bin, process.platform === "win32" ? "ruff.cmd" : "ruff");
  writeFileSync(launcher, process.platform === "win32"
    ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script}' "$@"\n`);
  if (process.platform !== "win32") chmodSync(launcher, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${oldPath ?? ""}`;
  setFormatCache("ruff format");
  return {
    log, fail,
    async dispose() {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      resetFormatCache();
      await removeTempDir(bin);
    },
  };
}

export function pythonFormatProject(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "pyproject.toml"), "[tool.ruff]\n");
}
