import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { startApiServer } from "../src/core/api/server.js";
import {
  acceptImages,
  ImageInputError,
  MAX_IMAGE_BYTES,
  readImageFiles,
  sniffImageType,
  userContent,
} from "../src/core/chat/images.js";
import {
  type ChatAgentHost,
  ChatService,
  type SessionDetail,
  type TurnAgentRequest,
} from "../src/core/chat/sessions.js";
import { SessionManager } from "../src/core/sessions/manager.js";
import { rebuildCoreMessages } from "../src/core/sessions/rebuild.js";
import type { ChatMessage } from "../src/types/index.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

/** A 1x1 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString("base64");

/** A PNG header padded to `bytes`; only the header is checked. */
function pngOfSize(bytes: number): string {
  const data = Buffer.alloc(bytes);
  Buffer.from(PNG, "base64").copy(data);
  return data.toString("base64");
}

type Part = Record<string, unknown> & { type: string };
type Script = (turn: { request: TurnAgentRequest }) => AsyncGenerator<Part>;

class ScriptedHost implements ChatAgentHost {
  scripts: Script[] = [];
  seen: ModelMessage[][] = [];
  async agent(request: TurnAgentRequest) {
    const script =
      this.scripts.shift() ??
      async function* () {
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 } };
      };
    return {
      contextWindow: 1000,
      agent: {
        stream: async (args: { messages: ModelMessage[] }) => {
          this.seen.push(args.messages);
          return { stream: script({ request }), responseMessages: Promise.resolve([]) };
        },
      },
    };
  }
  release() {}
  async dispose() {}
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = workflowFixture();
  const host = new ScriptedHost();
  const chat = new ChatService({
    workspace: fixture.root,
    config: { ...fixture.service.config, defaultModel: "openai/gpt-test" },
    host,
  });
  const server = await startApiServer({ service: fixture.service, chat, pollMs: 20, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${server.token}`, ...(init.headers as Record<string, string>) },
    });
  const post = (path: string, body: unknown = {}) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const detail = async (id: string) => (await (await call(`/v1/sessions/${id}`)).json()) as SessionDetail & {
    messages: ChatMessage[];
  };
  return { fixture, host, call, post, detail };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await Bun.sleep(20);
  }
}

describe("image checks", () => {
  test("the header decides the type", () => {
    expect(sniffImageType(Buffer.from(PNG, "base64"))).toBe("image/png");
    expect(sniffImageType(Buffer.from(JPEG_HEADER, "base64"))).toBe("image/jpeg");
    expect(sniffImageType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(Buffer.from("hello"))).toBeNull();
  });

  test("accepted images are labelled in order", () => {
    const images = acceptImages([
      { mediaType: "image/png", data: PNG },
      { mediaType: "image/jpeg", data: JPEG_HEADER },
    ]);
    expect(images.map((i) => [i.label, i.mediaType])).toEqual([
      ["image-1", "image/png"],
      ["image-2", "image/jpeg"],
    ]);
  });

  test("wrong types, mismatched data, bad base64, too many and too large images are refused", () => {
    const refused = (inputs: { mediaType: string; data: string }[]) => () => acceptImages(inputs);
    expect(refused([{ mediaType: "image/bmp", data: PNG }])).toThrow(/unsupported type/);
    expect(refused([{ mediaType: "image/jpeg", data: PNG }])).toThrow(/is image\/png, not image\/jpeg/);
    expect(refused([{ mediaType: "image/png", data: "data:image/png;base64,AAAA" }])).toThrow(/not base64/);
    expect(refused(Array(5).fill({ mediaType: "image/png", data: PNG }))).toThrow(/at most 4/);
    expect(refused([{ mediaType: "image/png", data: pngOfSize(MAX_IMAGE_BYTES + 1) }])).toThrow(ImageInputError);
  });

  test("the headless CLI reads image files by their header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-images-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "shot"), Buffer.from(PNG, "base64"));
    writeFileSync(join(dir, "notes.png"), "not an image");
    const [image] = await readImageFiles([join(dir, "shot")]);
    expect(image).toEqual({ label: "image-1", mediaType: "image/png", base64: PNG });
    await expect(readImageFiles([join(dir, "notes.png")])).rejects.toThrow(/not a PNG/);
    await expect(readImageFiles([join(dir, "missing.png")])).rejects.toThrow(/not found/);
  });

  test("model content puts the images after the text, and leaves out empty text", () => {
    const [image] = acceptImages([{ mediaType: "image/png", data: PNG }]);
    if (!image) throw new Error("No image");
    expect(userContent("Look", undefined)).toBe("Look");
    expect(userContent("Look", [image])).toEqual([
      { type: "text", text: "Look" },
      { type: "image", image: PNG, mediaType: "image/png" },
    ]);
    expect(userContent("", [image])).toEqual([{ type: "image", image: PNG, mediaType: "image/png" }]);
  });

  test("rebuilt model messages keep stored images that fit the provider limit", () => {
    const small = { label: "image-1", mediaType: "image/png" as const, base64: PNG };
    const large = { label: "image-2", mediaType: "image/png" as const, base64: pngOfSize(MAX_IMAGE_BYTES + 3) };
    const core = rebuildCoreMessages([
      { id: "u1", role: "user", content: "See", timestamp: 1, images: [small, large] },
    ]);
    expect(core).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "See" },
          { type: "image", image: PNG, mediaType: "image/png" },
        ],
      },
    ]);
  });
});

describe("local API chat images", () => {
  test("health lists the images capability", async () => {
    const { call } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("images");
  });

  test("a message with images reaches the model and is stored with the session", async () => {
    const { host, post, detail, fixture } = await setup();
    const session = (await (await post("/v1/sessions", {})).json()) as SessionDetail;
    const sent = await post(`/v1/sessions/${session.id}/messages`, {
      text: "What is on this screenshot?",
      images: [{ mediaType: "image/png", data: PNG }],
    });
    expect(sent.status).toBe(202);
    const done = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    expect(done.messages[0]).toMatchObject({
      role: "user",
      content: "What is on this screenshot?",
      images: [{ label: "image-1", mediaType: "image/png", base64: PNG }],
    });
    expect(host.seen[0]?.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is on this screenshot?" },
        { type: "image", image: PNG, mediaType: "image/png" },
      ],
    });
    const stored = await until(
      async () => new SessionManager(fixture.root).loadSessionMessages(session.id),
      // Messages and model messages are separate files; wait until both are written.
      (s) => s?.messages.length === 2 && JSON.stringify(s.coreMessages[0] ?? "").includes(PNG),
    );
    expect(stored?.messages[0]?.images?.[0]?.base64).toBe(PNG);
    expect(JSON.stringify(stored?.coreMessages[0])).toContain(PNG);
  });

  test("a session can start with images alone, above the default body limit", async () => {
    const { host, post, detail } = await setup();
    const big = pngOfSize(2 * 1024 * 1024);
    const created = await post("/v1/sessions", { images: [{ mediaType: "image/png", data: big }] });
    expect(created.status).toBe(201);
    const session = (await created.json()) as SessionDetail;
    const done = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 2);
    expect(done.messages[0]?.content).toBe("");
    expect(host.seen[0]?.at(-1)?.content).toEqual([{ type: "image", image: big, mediaType: "image/png" }]);
  });

  test("invalid images and empty messages are refused with 400", async () => {
    const { post } = await setup();
    const session = (await (await post("/v1/sessions", {})).json()) as SessionDetail;
    const path = `/v1/sessions/${session.id}/messages`;
    const mismatch = await post(path, { text: "x", images: [{ mediaType: "image/jpeg", data: PNG }] });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: { message: string } }).error.message).toContain("not image/jpeg");
    expect((await post(path, { text: "x", images: Array(5).fill({ mediaType: "image/png", data: PNG }) })).status).toBe(400);
    expect((await post(path, { text: "" })).status).toBe(400);
    expect((await post(path, {})).status).toBe(400);
    // Other endpoints keep the default body limit.
    expect((await post(`/v1/sessions/${session.id}/compact`, { pad: "x".repeat(2 * 1024 * 1024) })).status).toBe(413);
  });

  test("images sent during a turn are steered into it", async () => {
    const { host, post, detail } = await setup();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let steered: { text: string; images?: { label: string }[] } | null = null;
    host.scripts.push(async function* ({ request }) {
      yield { type: "text-delta", text: "First" };
      yield { type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 } };
      await gate;
      steered = request.drainSteering();
      yield { type: "text-delta", text: " then second" };
      yield { type: "finish-step", usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const session = (await (await post("/v1/sessions", { text: "Start" })).json()) as SessionDetail;
    await until(() => detail(session.id), (d) => d.state === "working");
    const image = { mediaType: "image/png", data: PNG };
    await post(`/v1/sessions/${session.id}/messages`, { text: "This one", images: [image] });
    await post(`/v1/sessions/${session.id}/messages`, { images: [image] });
    expect((await detail(session.id)).queued).toEqual(["This one", ""]);
    release();
    const done = await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 3);
    expect(steered).toMatchObject({ text: "This one", images: [{ label: "image-1" }, { label: "image-2" }] });
    expect(done.messages[1]).toMatchObject({ isSteering: true, images: [{ label: "image-1" }, { label: "image-2" }] });

    await post(`/v1/sessions/${session.id}/messages`, { text: "Next" });
    await until(() => detail(session.id), (d) => d.state === "idle" && d.messages.length === 5);
    const history = host.seen[1] ?? [];
    expect(history[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "This one" },
        { type: "image", image: PNG, mediaType: "image/png" },
        { type: "image", image: PNG, mediaType: "image/png" },
      ],
    });
  });
});
