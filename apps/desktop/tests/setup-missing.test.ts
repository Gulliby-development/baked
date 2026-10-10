import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { isMissingEndpoint } = await import("../src/renderer/client/setup.ts");
delete scope.window;

describe("isMissingEndpoint", () => {
  test("an unknown route or a missing capability means an older backend", () => {
    expect(isMissingEndpoint(new ApiError(404, "NOT_FOUND", "No endpoint /v1/workflow/checks"))).toBe(true);
    expect(isMissingEndpoint(new ApiError(404, "NOT_FOUND", "This BAKED has no checks endpoints"))).toBe(true);
    expect(isMissingEndpoint(new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET"))).toBe(true);
  });

  test("a folder that is not a project yet is an error, not an older backend", () => {
    const error = new ApiError(404, "NOT_FOUND", "No project here; run baked project init in the workspace");
    expect(isMissingEndpoint(error)).toBe(false);
  });
});
