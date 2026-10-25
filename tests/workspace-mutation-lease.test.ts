import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BAKED_NO_REPOMAP = "1";

import { createBakeAgent } from "../src/core/agents/bake.js";
import { ContextManager } from "../src/core/context/manager.js";
import { hasWorkspaceMutationContext, withWorkspaceMutation } from "../src/core/workflows/leases.js";
import { guardWorkspaceTools } from "../src/core/workflows/mutation-guard.js";
import { WorkflowStore } from "../src/core/workflows/store.js";
import { removeTempDir } from "./helpers/temp-dir.js";

let root: string;
const contexts: ContextManager[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baked-mutation-lease-"));
});
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((cm) => cm.dispose()));
  await removeTempDir(root);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const leaseHeld = () => {
  const store = new WorkflowStore(root, true);
  try {
    return store.lease("mutation") !== null;
  } finally {
    store.close();
  }
};

describe("workspace mutation lease in one process", () => {
  test("parallel mutations wait for each other instead of failing on the lease", async () => {
    const order: string[] = [];
    const mutation = (name: string) =>
      withWorkspaceMutation(root, async () => {
        order.push(`${name}:start`);
        await tick();
        order.push(`${name}:end`);
        return name;
      });
    expect(await Promise.all([mutation("a"), mutation("b"), mutation("c")])).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
    expect(leaseHeld()).toBe(false);
  });

  test("a failed mutation releases the lease for the next one", async () => {
    const failing = withWorkspaceMutation(root, async () => {
      await tick();
      throw new Error("boom");
    });
    const next = withWorkspaceMutation(root, async () => "done");
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("done");
    expect(leaseHeld()).toBe(false);
  });

  test("parallel calls of guarded tools both run", async () => {
    const tools = guardWorkspaceTools(
      {
        write: {
          execute: async (path: string) => {
            await tick();
            return path;
          },
        },
      },
      root,
    );
    const write = tools.write.execute as (path: string) => Promise<string>;
    expect(await Promise.all([write("a.txt"), write("b.txt")])).toEqual(["a.txt", "b.txt"]);
  });

  test("a chat's extra tools (coordinator) run outside the mutation lease", async () => {
    const context = new ContextManager(root);
    contexts.push(context);
    let release = () => {};
    const confirmed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: boolean[] = [];
    // A coordinator tool waiting for the user, as launch_session does on its confirm card.
    const launchSession = {
      execute: async () => {
        seen.push(hasWorkspaceMutationContext());
        await confirmed;
        return { success: true, output: "started" };
      },
    };
    const projectState = {
      execute: async () => {
        seen.push(hasWorkspaceMutationContext());
        return { success: true, output: "overview" };
      },
    };
    const agent = createBakeAgent({
      // biome-ignore lint/suspicious/noExplicitAny: minimal model stub for agent construction
      model: { modelId: "anthropic/claude-sonnet-4-6", doGenerate: async () => ({}) } as any,
      contextManager: context,
      cwd: root,
      extraTools: { launch_session: launchSession, project_state: projectState },
    }) as unknown as { tools: Record<string, { execute: (...a: unknown[]) => Promise<unknown> }> };
    const launching = agent.tools.launch_session?.execute({}, {});
    const state = (await agent.tools.project_state?.execute({}, {})) as { output: string };
    expect(state.output).toBe("overview");
    // Another chat's edit is not blocked while the coordinator waits for the user.
    expect(await withWorkspaceMutation(root, async () => "edited")).toBe("edited");
    release();
    expect(((await launching) as { output: string }).output).toBe("started");
    expect(seen).toEqual([false, false]);
  });
});
