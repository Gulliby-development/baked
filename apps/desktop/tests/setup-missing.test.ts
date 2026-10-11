import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { isMissingEndpoint, isNoProject } = await import("../src/renderer/client/setup.ts");
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

describe("isNoProject", () => {
  test("a folder without baked/project.json", () => {
    expect(isNoProject(new ApiError(404, "NOT_FOUND", "No project here; run baked project init in the workspace"))).toBe(true);
  });

  test("other errors, and an older backend, are not", () => {
    expect(isNoProject(new ApiError(404, "NOT_FOUND", "No endpoint /v1/project"))).toBe(false);
    expect(isNoProject(new ApiError(500, "INTERNAL", "No project here"))).toBe(false);
    expect(isNoProject(new Error("No project here"))).toBe(false);
  });
});
