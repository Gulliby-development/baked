import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, test } from "./fixtures.ts";

const needle = dirname(createRequire(import.meta.url).resolve("cactus-needle/package.json"));

test("voice input reports a missing engine with its reason", async ({ workspace, launch }) => {
  const dir = join(workspace.dir, "no-voice");
  mkdirSync(dir, { recursive: true });
  const { page } = await launch({ env: { BAKED_VOICE_DIR: dir } });
  const status = await page.evaluate(() => window.baked?.voiceStatus());
  expect(status?.available).toBe(false);
  expect(status?.reason).toContain("speech engine is not installed");
});

test("the main process loads the speech engine in its worker", async ({ workspace, launch }) => {
  // The real package with a model of the pinned size but no valid content: loading it runs the
  // ESM import, the worker thread and the WebAssembly start, then the model check refuses it.
  const dir = join(workspace.dir, "voice");
  for (const entry of ["package.json", "dist", "vendor"])
    cpSync(join(needle, entry), join(dir, "cactus-needle", entry), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(needle, "vendor", "manifest.json"), "utf8")) as {
    speechModel: { size: number };
  };
  writeFileSync(join(dir, "whistle.cact"), new Uint8Array(manifest.speechModel.size));
  const { page } = await launch({ env: { BAKED_VOICE_DIR: dir } });
  expect(await page.evaluate(() => window.baked?.voiceStatus())).toEqual({
    available: true,
    model: "whistle",
  });
  const error = await page.evaluate(async () => {
    try {
      await window.baked?.transcribe(new Float32Array(16_000));
      return "";
    } catch (reason) {
      return String(reason);
    }
  });
  expect(error).toContain(".cact model");
});
