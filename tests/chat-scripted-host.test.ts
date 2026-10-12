import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import {
  parseChatScript,
  scriptedHostFromEnv,
  TEST_SCRIPT_ENV,
} from "../src/core/chat/scripted-host.js";
import type { SessionDetail } from "../src/core/chat/sessions.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await Bun.sleep(20);
  }
}

describe("scripted chat host (BAKED_TEST_SCRIPT)", () => {
  test("is off unless the environment variable names a script", () => {
    expect(scriptedHostFromEnv({})).toBeUndefined();
    expect(scriptedHostFromEnv({ [TEST_SCRIPT_ENV]: "" })).toBeUndefined();
  });

  test("rejects a script without turns or steps", () => {
    expect(() => parseChatScript({})).toThrow("turns array");
    expect(() => parseChatScript({ turns: [{}] })).toThrow("turn 1 has no steps");
    expect(parseChatScript({ turns: [{ steps: [] }] }).delayMs).toBe(15);
  });

  test("baked serve plays the script: streaming, a tool call and an approved outside write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-scripted-"));
    const file = join(dir, "script.json");
    writeFileSync(
      file,
      JSON.stringify({
        delayMs: 1,
        turns: [
          {
            steps: [
              { reasoning: "Read first." },
              { text: "Looking at the notes. " },
              { tool: "read", input: { files: [{ path: "README.md" }] }, output: "1 file" },
              {
                tool: "write_file",
                input: { path: "/tmp/outside.txt" },
                output: "Wrote /tmp/outside.txt",
                approval: { outsideCwd: "/tmp/outside.txt" },
              },
              { ifApproved: "Saved outside the project." },
              { ifDenied: "Left it alone." },
            ],
          },
        ],
      }),
    );
    const previous = process.env[TEST_SCRIPT_ENV];
    process.env[TEST_SCRIPT_ENV] = file;
    const fixture = workflowFixture();
    const server = await startApiServer({
      service: fixture.service,
      homeDir: dir,
      pollMs: 20,
      log: () => {},
    });
    if (previous === undefined) delete process.env[TEST_SCRIPT_ENV];
    else process.env[TEST_SCRIPT_ENV] = previous;
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      rmSync(dir, { recursive: true, force: true });
    });
    const call = (path: string, body?: unknown) =>
      fetch(`${server.url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const detail = async (id: string) => (await (await call(`/v1/sessions/${id}`)).json()) as SessionDetail;

    const session = (await (await call("/v1/sessions", { text: "Save a note outside" })).json()) as SessionDetail;
    const waiting = await until(() => detail(session.id), (d) => d.prompts.length === 1);
    expect(waiting.prompts[0]).toMatchObject({ kind: "outside-cwd" });
    const prompt = waiting.prompts[0];
    expect((await call(`/v1/sessions/${session.id}/prompts/${prompt?.id}`, { approve: true })).status).toBe(200);

    const done = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    const answer = done.messages[1];
    expect(answer?.content).toBe("Looking at the notes. Saved outside the project.");
    expect(answer?.toolCalls?.map((c) => [c.name, c.result?.success])).toEqual([
      ["read", true],
      ["write_file", true],
    ]);

    // Turns after the script's last one say so instead of calling a model.
    await call(`/v1/sessions/${session.id}/messages`, { text: "And now?" });
    const after = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 4);
    expect(after.messages[3]?.content).toBe("The test script has no more turns.");
  });
});
