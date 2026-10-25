import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startCodexAppServerSession } from "../src/core/llm/providers/codex/client.js";
import { createCodexLanguageModel, runCodexProcess } from "../src/core/llm/providers/codex/runner.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { jsonLines, LineSplitter, onJsonLines } from "../src/core/llm/providers/json-lines.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 62, stepvet tagexpr (#1956). The provider readers framed JSON Lines with
// `node:readline`, which also ends a line at U+2028 and U+2029. Codex writes both raw inside a JSON
// string, so an answer that copied a spec row holding U+2028 was cut into halves that did not
// parse and were dropped: eight analyze attempts ended with "Codex exec returned no final agent
// message" or a native stall, and the run blocked provider_unavailable for 69 minutes.

const SEPARATORS = "a b c\u0085d﻿e";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // A closed app-server is killed, not awaited, and on Windows its working directory stays
  // locked until it exits: a bare rmSync failed with EBUSY (#2161).
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

/** A stand-in `codex exec --json`: reads the prompt, then writes `events` in 7-byte chunks. */
function fakeExec(events: unknown[], raw: string[] = []) {
  const dir = tempDir("baked-codex-exec-");
  const script = join(dir, "codex-exec.ts");
  const text = [...raw, ...events.map((e) => JSON.stringify(e))].map((line) => `${line}\n`).join("");
  writeFileSync(
    script,
    `const bytes = Buffer.from(${JSON.stringify(text)}, "utf8");
for await (const _ of process.stdin) {}
for (let i = 0; i < bytes.length; i += 7) {
  process.stdout.write(bytes.subarray(i, i + 7));
  await Bun.sleep(0);
}
`,
  );
  return { file: process.execPath, prefix: [script] };
}

const answer = (text: string) => [
  { type: "thread.started", thread_id: "t1" },
  { type: "item.completed", item: { id: "i1", type: "agent_message", text } },
  { type: "turn.completed", usage: { input_tokens: 27_967, output_tokens: 6_412 } },
];

describe("JSON Lines framing (#1956)", () => {
  test("a line holding U+2028, U+2029, U+0085 and U+FEFF stays one line in any chunking", async () => {
    const line = JSON.stringify({ text: SEPARATORS });
    const bytes = Buffer.from(`${line}\r\n${JSON.stringify({ n: 2 })}\n{"n":3}`, "utf8");
    // Every chunk size, so a boundary falls inside each multibyte character.
    for (let size = 1; size <= 8; size++) {
      const splitter = new LineSplitter();
      const lines: string[] = [];
      for (let i = 0; i < bytes.length; i += size) lines.push(...splitter.push(bytes.subarray(i, i + size)));
      lines.push(...splitter.end());
      expect(lines).toEqual([line, '{"n":2}', '{"n":3}']);
    }
    const stream = new PassThrough();
    const read = (async () => {
      const lines: string[] = [];
      for await (const l of jsonLines(stream)) lines.push(l);
      return lines;
    })();
    stream.end(bytes);
    expect(await read).toEqual([line, '{"n":2}', '{"n":3}']);
    const events = new PassThrough();
    const seen: string[] = [];
    onJsonLines(events, (l) => seen.push(l));
    events.end(bytes);
    await new Promise((resolve) => events.once("end", resolve));
    expect(seen).toEqual([line, '{"n":2}', '{"n":3}']);
  });

  test("codex exec: the final message holding U+2028 is returned", async () => {
    const text = JSON.stringify({ row: SEPARATORS });
    const result = await runCodexProcess(["exec", "--json"], "prompt", undefined, undefined, fakeExec(answer(text)));
    expect(result.text).toBe(text);
    expect(result.usage.outputTokens).toBe(6_412);
  });

  test("codex exec: a call with no answer names the lines that did not parse", async () => {
    const run = runCodexProcess(["exec", "--json"], "prompt", undefined, undefined, fakeExec([], ['{"type":"item.completed","item":']));
    await expect(run).rejects.toThrow('no final agent message; 1 output line(s) did not parse: "{\\"type\\":\\"item.completed\\",\\"item\\":"');
  });

  test("codex app-server: a response, a notification and a server request holding U+2028 arrive whole", async () => {
    const dir = tempDir("baked-codex-app-");
    const encoded = JSON.stringify(SEPARATORS);
    writeFileSync(
      join(dir, "app-server.ts"),
      `let rest = "";
process.stdin.on("data", (chunk) => {
  rest += chunk;
  const lines = rest.split("\\n");
  rest = lines.pop() ?? "";
  for (const line of lines) {
    const message = JSON.parse(line);
    if (message.id === undefined || message.result !== undefined) continue;
    const out = [{ id: message.id, result: { text: ${encoded} } }];
    if (message.method === "turn/start") {
      out.push({ method: "item/agentMessage/delta", params: { delta: ${encoded} } });
      out.push({ id: 900, method: "item/tool/call", params: { tool: "submit_result", arguments: { row: ${encoded} } } });
    }
    const bytes = Buffer.from(out.map((m) => JSON.stringify(m) + "\\n").join(""), "utf8");
    for (let i = 0; i < bytes.length; i += 5) process.stdout.write(bytes.subarray(i, i + 5));
  }
});
`,
    );
    const cwd = process.cwd();
    const codexPath = process.env.BAKED_CODEX_PATH;
    process.env.BAKED_CODEX_PATH = process.execPath;
    process.chdir(dir);
    cleanups.push(() => {
      process.chdir(cwd);
      if (codexPath === undefined) delete process.env.BAKED_CODEX_PATH;
      else process.env.BAKED_CODEX_PATH = codexPath;
    });
    const session = await startCodexAppServerSession();
    cleanups.push(() => session.close());
    const deltas: unknown[] = [];
    session.onNotification((method, params) => {
      if (method === "item/agentMessage/delta") deltas.push((params as { delta: string }).delta);
    });
    const called = new Promise<unknown>((resolve) =>
      session.onServerRequest((method, _id, params) => {
        if (method !== "item/tool/call") return false;
        resolve((params as { arguments: { row: string } }).arguments.row);
        return true;
      }),
    );
    expect(await session.request("turn/start", {})).toEqual({ text: SEPARATORS });
    expect(await called).toBe(SEPARATORS);
    expect(deltas).toEqual([SEPARATORS]);
    expect(session.unparsed?.count).toBe(0);
  });

  test("no provider adapter reads a subprocess with node:readline", () => {
    const root = join(import.meta.dir, "..", "src", "core", "llm", "providers");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
      });
    const offenders = files(root).filter((path) => /from\s+["']node:readline["']|require\(["'](?:node:)?readline["']\)/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("scenario: stepvet tagexpr, an answer that copies a row holding U+2028 (#1956)", () => {
  test("the stage's codex exec answer is read whole and accepted on the first attempt", async () => {
    const spec: Spec = {
      ...fixtureSpec,
      criteria: fixtureSpec.criteria.map((c) => ({ ...c, then: `the tag "x y" splits at U+2028 (raw:  )` })),
    };
    const message = JSON.stringify({
      finishReason: "tool-calls",
      reasoning: "",
      text: "",
      toolCalls: [{ toolName: "submit_result", inputJson: JSON.stringify(spec) }],
    });
    expect(message).toContain(" ");
    const command = fakeExec(answer(message));
    const adapter = getProvider("codex");
    if (!adapter) throw new Error("Codex provider missing");
    const original = adapter.createModel;
    adapter.createModel = (modelId: string) =>
      createCodexLanguageModel(modelId, {
        run: (call) => runCodexProcess(["exec", "--json"], call.parts.instructions, call.abortSignal, call.onResponse, command),
      });
    cleanups.push(() => {
      adapter.createModel = original;
    });
    const fixture = workflowFixture({
      executor: (root) =>
        new (class CodexSpecExecutor extends FixtureExecutor {
          override async execute(request: ExecutionRequest) {
            if (request.profile.output !== "spec") return super.execute(request);
            const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, {
              ...fixture.config,
              repoMap: false,
            });
            try {
              return await native.execute({ ...request, profile: { ...request.profile, model: "codex/gpt-6.1-sol" } });
            } finally {
              native.dispose();
            }
          }
        })(root),
    });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("waiting");
    const store = fixture.service.store;
    const specify = store
      .attempts(run.runId)
      .filter((a) => a.model_id !== null && store.rootStage(run.runId, a.step_id) === "specify");
    expect(specify.map((a) => a.status)).toEqual(["completed"]);
    const accepted = store.latestArtifact(run.runId, "spec.json");
    expect(store.readArtifact(run.runId, accepted?.id ?? "")).toContain(" ");
  }, 60_000);
});
