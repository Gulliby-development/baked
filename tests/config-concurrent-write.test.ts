import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const env = (home: string) => ({ ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home });
/** Where loadConfig looks under `env(home)`: %LOCALAPPDATA%\baked on Windows, ~/.baked elsewhere. */
const configDir = (home: string) => join(home, process.platform === "win32" ? "baked" : ".baked");

/**
 * #1115: a workflow runner exited 1 in the middle of a run. Every agent reads the global config,
 * and another BAKED process saving it truncated the file first, so a reader saw it empty or cut
 * short and loadConfig exited the process.
 */
test("a process reading the config while another saves it never sees a torn file (#1115)", async () => {
  const home = mkdtempSync(join(tmpdir(), "baked-config-race-"));
  dirs.push(home);
  const writer = join(home, "writer.ts");
  const reader = join(home, "reader.ts");
  const config = JSON.stringify(join(root, "src/config/index.ts"));
  const done = JSON.stringify(join(home, "writer-done"));
  writeFileSync(
    writer,
    `import { saveGlobalConfig } from ${config};\nconst padding = "x".repeat(200_000);\nfor (let i = 0; i < 400; i++) saveGlobalConfig({ defaultModel: "model-" + i, padding } as never);\nawait Bun.write(${done}, "done");\n`,
  );
  writeFileSync(
    reader,
    `import { existsSync } from "node:fs";\nimport { loadConfig } from ${config};\nlet seen = 0;\n// Reads for as long as the writer writes.\nwhile (!existsSync(${done})) if (loadConfig().defaultModel.startsWith("model-")) seen++;\nconsole.log(seen);\n`,
  );
  // A large file widens the moment a plain write leaves it empty or cut short.
  const write = Bun.spawn([process.execPath, writer], { env: env(home), stderr: "pipe" });
  const read = Bun.spawn([process.execPath, reader], { env: env(home), stdout: "pipe", stderr: "pipe" });
  const [readCode, writeCode] = await Promise.all([read.exited, write.exited]);
  const stderr = await new Response(read.stderr).text();
  expect({ readCode, stderr }).toEqual({ readCode: 0, stderr: "" });
  expect(writeCode).toBe(0);
  // Every write went through a temp file that was renamed into place.
  expect(readdirSync(configDir(home)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
}, 60000);

test("a config file read while another process replaces it is read again, not reported (#1115)", async () => {
  const home = mkdtempSync(join(tmpdir(), "baked-config-torn-"));
  dirs.push(home);
  mkdirSync(configDir(home));
  const file = join(configDir(home), "config.json");
  // What a reader saw while a plain write had truncated the file.
  writeFileSync(file, "");
  const reader = join(home, "reader.ts");
  writeFileSync(
    reader,
    [
      `import { loadConfig } from ${JSON.stringify(join(root, "src/config/index.ts"))};`,
      // Another process finishes the write a moment later.
      `Bun.spawn([process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(30); await Bun.write(${JSON.stringify(file)}, JSON.stringify({ defaultModel: "written" }));`)}]);`,
      "console.log(loadConfig().defaultModel);",
    ].join("\n"),
  );
  const read = Bun.spawn([process.execPath, reader], { env: env(home), stdout: "pipe", stderr: "pipe" });
  const code = await read.exited;
  expect({ code, stdout: (await new Response(read.stdout).text()).trim(), stderr: await new Response(read.stderr).text() }).toEqual({
    code: 0,
    stdout: "written",
    stderr: "",
  });
});
