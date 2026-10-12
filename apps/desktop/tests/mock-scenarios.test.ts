import { describe, expect, test } from "bun:test";
import { createMockBridge, mockScenario } from "../src/renderer/client/mock.ts";

describe("mock bridge scenarios", () => {
  test("?mock= picks a scenario and anything else falls back to the default", () => {
    expect(mockScenario("?mock=empty")).toBe("empty");
    expect(mockScenario("?mock=older&x=1")).toBe("older");
    expect(mockScenario("")).toBe("default");
    expect(mockScenario("?mock=nope")).toBe("default");
  });

  test("empty has no projects; uninitialized has one open project", async () => {
    expect(await createMockBridge("empty").projects()).toEqual([]);
    const projects = await createMockBridge("uninitialized").projects();
    expect(projects.map((p) => [p.key, p.open])).toEqual([["client", true]]);
  });

  test("start-failure fails to open, and Restart recovers", async () => {
    const bridge = createMockBridge("start-failure");
    await bridge.openProject("baked");
    const failed = (await bridge.projects()).find((p) => p.key === "baked");
    expect(failed?.backend.kind).toBe("failed");
    await bridge.restartProject("baked");
    const running = (await bridge.projects()).find((p) => p.key === "baked");
    expect(running?.backend).toEqual({ kind: "running", version: "0.1.1" });
  });

  test("older answers health without the optional capabilities", async () => {
    const health = await createMockBridge("older").request<{ capabilities: string[] }>(
      "baked",
      "GET",
      "/v1/health",
    );
    expect(health.body.capabilities).not.toContain("git");
    expect(health.body.capabilities).toContain("workflow");
  });
});
