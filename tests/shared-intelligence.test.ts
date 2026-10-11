import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BakeChatHost } from "../src/core/chat/host.js";
import { ContextManager } from "../src/core/context/manager.js";
import { SharedRootContext } from "../src/core/context/shared-root.js";
import { IntelligenceClient } from "../src/core/workers/intelligence-client.js";
import {
  borrowIntelligence,
  INTELLIGENCE_RELAY_CALLBACK,
  type IntelligenceRelayRequest,
  serveIntelligenceRelay,
} from "../src/core/workers/intelligence-relay.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { WorkflowStore } from "../src/core/workflows/store.js";
import { WorkerClient } from "../src/core/workers/rpc.js";
import { removeTempDir } from "./helpers/temp-dir.js";

class BorrowerClient extends WorkerClient {
  constructor(relay: ReturnType<typeof serveIntelligenceRelay>) {
    super(join(import.meta.dir, "fixtures", "intelligence-borrower-worker.ts"));
    this.registerCallback(INTELLIGENCE_RELAY_CALLBACK, (request) =>
      relay.handle(request as IntelligenceRelayRequest),
    );
  }
  findSymbol(cwd: string, name: string): Promise<{ ready: boolean; location: string | null }> {
    return this.call("findSymbol", cwd, name);
  }
}

function fakeRoot(label: string): ContextManager {
  return { label, dispose: async () => {} } as unknown as ContextManager;
}

describe("SharedRootContext", () => {
  test("creates one root on first use and shares it", async () => {
    let created = 0;
    const root = new SharedRootContext(async () => fakeRoot(`root-${++created}`));
    expect(root.started).toBe(false);
    const [a, b] = await Promise.all([root.get(), root.get()]);
    expect(a).toBe(b);
    expect(created).toBe(1);
  });

  test("retries a failed creation and recreates after dispose", async () => {
    let attempts = 0;
    let disposed = 0;
    const root = new SharedRootContext(async () => {
      if (++attempts === 1) throw new Error("boom");
      return { dispose: async () => void disposed++ } as unknown as ContextManager;
    });
    await expect(root.get()).rejects.toThrow("boom");
    const first = await root.get();
    await root.dispose();
    expect(disposed).toBe(1);
    expect(root.started).toBe(false);
    expect(await root.get()).not.toBe(first);
    expect(attempts).toBe(3);
  });

  test("the chat host and a workflow executor leave a given root to the service that owns it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-root-"));
    let disposed = 0;
    const root = new SharedRootContext(
      async () => ({ dispose: async () => void disposed++ }) as unknown as ContextManager,
    );
    const service = new NativeWorkflowService(dir, DEFAULT_CONFIG, undefined, false, root);
    try {
      expect(service.rootContext).toBe(root);
      await root.get();
      const host = new BakeChatHost(dir, DEFAULT_CONFIG, service.rootContext);
      await host.dispose();
      const store = new WorkflowStore(dir);
      const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), DEFAULT_CONFIG, root);
      await executor.dispose();
      store.close();
      expect(disposed).toBe(0);
      expect(root.started).toBe(true);
    } finally {
      // The service owns its root and disposes it on close.
      service.close();
      await Bun.sleep(10);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(disposed).toBe(1);
  });
});

describe("intelligence relay", () => {
  let dir: string;
  let owner: IntelligenceClient;
  const forwarded: string[] = [];
  let relay: ReturnType<typeof serveIntelligenceRelay>;
  let borrowed: Awaited<ReturnType<typeof borrowIntelligence>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "intelligence-relay-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
    owner = new IntelligenceClient(dir);
    await owner.scan();
    relay = serveIntelligenceRelay(
      () => owner,
      (event, data) => {
        forwarded.push(event);
        borrowed?.transport.emit(event, data);
      },
    );
    borrowed = await borrowIntelligence(dir, (request: IntelligenceRelayRequest) =>
      relay.handle(request),
    );
  }, 60_000);

  afterAll(async () => {
    relay.dispose();
    await owner.close();
    // The worker and its language servers release their handles in the folder shortly after close.
    await removeTempDir(dir);
  });

  test("a borrowed client starts from the owner's state and calls the owner's worker", async () => {
    expect(owner.isReady).toBe(true);
    expect(borrowed.client.isReady).toBe(true);
    expect(borrowed.client.getStatsCached()).toEqual(owner.getStatsCached());
    expect(await borrowed.client.findSymbol("add")).toBe(await owner.findSymbol("add"));
  });

  test("refuses another workspace and owner-only methods", async () => {
    await expect(relay.handle({ op: "attach", cwd: join(dir, "src") })).rejects.toThrow(
      "No intelligence worker",
    );
    await expect(borrowed.client.clear()).rejects.toThrow("reserved");
  });

  test("forwards scan completion to the borrower", async () => {
    let completed = false;
    borrowed.client.onScanComplete = () => {
      completed = true;
    };
    await owner.scan();
    await Bun.sleep(20);
    expect(forwarded).toContain("scan-complete");
    expect(completed).toBe(true);
  }, 60_000);

  test("a root built on a borrowed client neither scans nor closes the owner's worker", async () => {
    const extra = await borrowIntelligence(dir, (request) => relay.handle(request));
    // Other test files turn the repository map off for the whole process.
    const noRepoMap = process.env.BAKED_NO_REPOMAP;
    delete process.env.BAKED_NO_REPOMAP;
    const root = await ContextManager.createAsync(dir, undefined, {
      intelligence: extra.client,
    }).finally(() => {
      if (noRepoMap !== undefined) process.env.BAKED_NO_REPOMAP = noRepoMap;
    });
    expect(root.isRepoMapReady()).toBe(true);
    await root.dispose({ preserveSharedIO: true });
    expect(await owner.findSymbol("add")).not.toBeNull();
  }, 60_000);

  test("another thread borrows the worker through the relay", async () => {
    const thread = new BorrowerClient(relay);
    try {
      expect(await thread.findSymbol(dir, "add")).toEqual({
        ready: true,
        location: await owner.findSymbol("add"),
      });
    } finally {
      thread.dispose();
    }
  }, 60_000);
});
