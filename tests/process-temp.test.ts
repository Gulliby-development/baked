import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_TEMP_AGE_MS,
  processAlive,
  processTempDir,
  sweepProcessTempDirs,
} from "../src/core/platform/process-temp.js";
import { tmpDir } from "../src/core/platform/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const modulePath = join(import.meta.dir, "..", "src", "core", "platform", "process-temp.ts");

describe("process temp dirs (#2967)", () => {
  test("a directory a killed process made is removed by the next process's first call", async () => {
    const prefix = `baked-ptest-${process.pid}-${Date.now()}-`;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { processTempDir } = await import(${JSON.stringify(modulePath)});
         const dir = processTempDir(${JSON.stringify(prefix)});
         process.once("exit", () => require("node:fs").rmSync(dir, { recursive: true, force: true }));
         console.log(dir);
         setInterval(() => {}, 1000);`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const reader = child.stdout.getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const leaked = text.trim();
    expect(leaked.startsWith(join(tmpDir(), `${prefix}${child.pid}-`))).toBe(true);
    // SIGKILL: the child's exit hook never runs, as with a test timeout or a cancelled CI job.
    child.kill("SIGKILL");
    await child.exited;
    expect(existsSync(leaked)).toBe(true);

    const mine = processTempDir(prefix);
    try {
      expect(existsSync(leaked)).toBe(false);
      expect(existsSync(mine)).toBe(true);
    } finally {
      await removeTempDir(mine);
    }
  });

  test("the sweep keeps directories of live processes and fresh legacy ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-ptest-root-"));
    try {
      const prefix = "baked-trace-cache-";
      for (const name of [
        `${prefix}111-aaaaaa`,
        `${prefix}222-bbbbbb`,
        `${prefix}cccccc`,
        `${prefix}dddddd`,
        "baked-trace-eeeeee",
        `${prefix}333-sevench`,
      ]) {
        mkdirSync(join(root, name));
      }
      const now = Date.now();
      const old = (now - LEGACY_TEMP_AGE_MS - 60_000) / 1000;
      utimesSync(join(root, `${prefix}cccccc`), old, old);

      const removed = sweepProcessTempDirs(prefix, root, now, (pid) => pid === 222);

      expect(removed.sort()).toEqual([`${prefix}111-aaaaaa`, `${prefix}cccccc`]);
      expect(existsSync(join(root, `${prefix}222-bbbbbb`))).toBe(true);
      expect(existsSync(join(root, `${prefix}dddddd`))).toBe(true);
      expect(existsSync(join(root, "baked-trace-eeeeee"))).toBe(true);
      expect(existsSync(join(root, `${prefix}333-sevench`))).toBe(true);
    } finally {
      await removeTempDir(root);
    }
  });

  test("processAlive tells this process from one that has exited", async () => {
    expect(processAlive(process.pid)).toBe(true);
    const child = Bun.spawn([process.execPath, "-e", "0"]);
    await child.exited;
    expect(processAlive(child.pid)).toBe(false);
  });
});
