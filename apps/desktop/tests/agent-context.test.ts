import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { setup } = await import("../src/renderer/client/setup.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
delete scope.window;

describe("agent context", () => {
  test("the old Instructions and Working set routes open its tabs", () => {
    const at = (hash: string) => parseRoute(hash);
    expect(at("#/p/baked/instructions")).toEqual({ name: "project", key: "baked", section: "context", id: "rules" });
    expect(at("#/p/baked/working-set")).toEqual({ name: "project", key: "baked", section: "context", id: "files" });
    expect(parseRoute(projectHref("baked", "context", "preview"))).toEqual({ name: "project", key: "baked", section: "context", id: "preview" });
  });

  test("the preview carries the rules agents read and adds up both parts", async () => {
    const preview = await setup.agentContext("baked");
    expect(preview.instructions.text.length).toBeGreaterThan(0);
    expect(preview.bytes).toBe(preview.instructions.bytes + (preview.workingSet?.bytes ?? 0));
  });
});
