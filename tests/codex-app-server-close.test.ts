import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCodexAppServerSession } from "../src/core/llm/providers/codex/client.js";
import { removeTempDir } from "./helpers/temp-dir.js";

// A stand-in app-server: `bun app-server --listen stdio://` runs ./app-server.ts from the cwd.
// It answers every request and never sends a notification, like Codex while a browser login waits.
const FAKE = `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "exit") process.exit(3);
  process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
});
`;

describe("codex app-server notification waiters", () => {
  let dir = "";
  let cwd = "";
  let codexPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "baked-codex-close-"));
    writeFileSync(join(dir, "app-server.ts"), FAKE);
    cwd = process.cwd();
    codexPath = process.env.BAKED_CODEX_PATH;
    process.env.BAKED_CODEX_PATH = process.execPath;
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(cwd);
    if (codexPath === undefined) delete process.env.BAKED_CODEX_PATH;
    else process.env.BAKED_CODEX_PATH = codexPath;
    // The killed app-server keeps its working directory locked on Windows until it exits (#2161).
    await removeTempDir(dir);
  });

  test("closing the session rejects a pending notification wait", async () => {
    const session = await startCodexAppServerSession();
    const wait = session.waitForNotification("account/login/completed", () => true);
    session.close();
    await expect(wait).rejects.toThrow("connection closed");
  });

  test("an exiting app-server rejects a pending notification wait", async () => {
    const session = await startCodexAppServerSession();
    const wait = session.waitForNotification("account/login/completed", () => true);
    session.request("exit", {}).catch(() => {});
    await expect(wait).rejects.toThrow("exited with code 3");
    session.close();
  });

  test("a wait started after the session closed fails at once", async () => {
    const session = await startCodexAppServerSession();
    session.close();
    await expect(session.waitForNotification("account/login/completed", () => true)).rejects.toThrow(
      "connection closed",
    );
  });
});
