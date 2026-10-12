import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveVoiceDir, VOICE_SAMPLE_RATE, VoiceEngine } from "../src/main/voice.ts";

const dirs: string[] = [];
const engines: VoiceEngine[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-voice-"));
  dirs.push(dir);
  return dir;
}

function engine(dir: string): VoiceEngine {
  const created = new VoiceEngine(dir);
  engines.push(created);
  return created;
}

/** A stand-in for cactus-needle that echoes what it was asked to transcribe. */
function stubPackage(dir: string, modelSize = 4): void {
  const pkg = join(dir, "cactus-needle");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(join(pkg, "vendor"), { recursive: true });
  writeFileSync(
    join(pkg, "vendor", "manifest.json"),
    JSON.stringify({ speechModel: { size: modelSize } }),
  );
  writeFileSync(
    join(pkg, "dist", "index.js"),
    `export async function createWhistle({ modelPath }) {
  return {
    async transcribe(audio, options) {
      return {
        text: "  " + audio.length + " samples " + (options.language ?? "auto") + " " + modelPath.endsWith("whistle.cact") + "  ",
        language: options.language ?? "en",
        durationInSeconds: audio.length / ${VOICE_SAMPLE_RATE},
      };
    },
    async close() {},
  };
}
`,
  );
}

afterEach(async () => {
  for (const created of engines.splice(0)) await created.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("voice directory", () => {
  test("a packaged app reads resources/voice, a source run the staged copy", () => {
    const base = { resourcesPath: "/app/resources", appPath: "/src/apps/desktop" };
    expect(resolveVoiceDir({ ...base, packaged: true })).toBe(join("/app/resources", "voice"));
    expect(resolveVoiceDir({ ...base, packaged: false })).toBe(
      join("/src/apps/desktop", "dist", ".stage", "voice"),
    );
    expect(resolveVoiceDir({ ...base, packaged: true, override: "/elsewhere" })).toBe("/elsewhere");
  });
});

describe("voice status", () => {
  test("names the missing engine", () => {
    const status = engine(tempDir()).status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain("speech engine is not installed");
  });

  test("names the missing model", () => {
    const dir = tempDir();
    stubPackage(dir);
    const status = engine(dir).status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain("speech model is missing");
  });

  test("refuses a model of the wrong size", () => {
    const dir = tempDir();
    stubPackage(dir, 8);
    writeFileSync(join(dir, "whistle.cact"), "abcd");
    const status = engine(dir).status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain("expected 8");
  });

  test("is available with the engine and a model of the pinned size", () => {
    const dir = tempDir();
    stubPackage(dir);
    writeFileSync(join(dir, "whistle.cact"), "abcd");
    expect(engine(dir).status()).toEqual({ available: true, model: "whistle" });
  });
});

describe("transcribe", () => {
  function ready(): VoiceEngine {
    const dir = tempDir();
    stubPackage(dir);
    writeFileSync(join(dir, "whistle.cact"), "abcd");
    return engine(dir);
  }

  test("passes samples and the language to the engine and trims the text", async () => {
    const result = await ready().transcribe(new Float32Array(VOICE_SAMPLE_RATE), "de");
    expect(result).toEqual({ text: "16000 samples de true", language: "de", durationSeconds: 1 });
  });

  test("lets the model detect the language when none is given", async () => {
    const result = await ready().transcribe(new Float32Array(8));
    expect(result.text).toBe("8 samples auto true");
  });

  test("refuses empty, too long and badly typed audio and unknown languages", async () => {
    const voice = ready();
    await expect(voice.transcribe(new Float32Array(0))).rejects.toThrow("empty");
    await expect(voice.transcribe(new Float32Array(VOICE_SAMPLE_RATE * 31))).rejects.toThrow(
      "30 seconds",
    );
    await expect(voice.transcribe([0, 1] as unknown as Float32Array)).rejects.toThrow(
      "Float32Array",
    );
    await expect(voice.transcribe(new Float32Array(8), "ru" as "en")).rejects.toThrow(
      "Unsupported language",
    );
  });

  test("reports why it is unavailable instead of loading", async () => {
    await expect(engine(tempDir()).transcribe(new Float32Array(8))).rejects.toThrow(
      "speech engine is not installed",
    );
  });

  test("the real engine loads in its worker and rejects a corrupt model", async () => {
    const dir = tempDir();
    const pkg = dirname(createRequire(import.meta.url).resolve("cactus-needle/package.json"));
    for (const entry of ["package.json", "dist", "vendor"]) {
      cpSync(join(pkg, entry), join(dir, "cactus-needle", entry), { recursive: true });
    }
    const manifest = (await Bun.file(join(pkg, "vendor", "manifest.json")).json()) as {
      speechModel: { size: number };
    };
    writeFileSync(join(dir, "whistle.cact"), new Uint8Array(manifest.speechModel.size));
    const voice = engine(dir);
    expect(voice.status().available).toBe(true);
    await expect(voice.transcribe(new Float32Array(VOICE_SAMPLE_RATE))).rejects.toThrow(".cact model");
  });
});
