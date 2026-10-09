import { describe, expect, it } from "bun:test";
import { getRestartSpec } from "../src/core/restart.js";

describe("getRestartSpec", () => {
  it("restarts compiled Bun binaries from the real executable path", () => {
    const spec = getRestartSpec({
      execPath: "/private/tmp/baked",
      argv: ["bun", "/$bunfs/root/baked.js", "--headless", "fix it"],
      moduleUrl: "file:///$bunfs/root/index.js",
    });

    expect(spec.command).toBe("/private/tmp/baked");
    expect(spec.args).toEqual(["--headless", "fix it"]);
  });

  it("preserves the script entrypoint for Bun-based installs", () => {
    const spec = getRestartSpec({
      execPath: "/Users/blitz/.bun/bin/bun",
      argv: [
        "bun",
        "/Users/blitz/.bun/install/global/node_modules/@baked/baked/dist/index.js",
        "--version",
      ],
      moduleUrl:
        "file:///Users/blitz/.bun/install/global/node_modules/@baked/baked/dist/index.js",
    });

    expect(spec.command).toBe("/Users/blitz/.bun/bin/bun");
    expect(spec.args).toEqual([
      "/Users/blitz/.bun/install/global/node_modules/@baked/baked/dist/index.js",
      "--version",
    ]);
  });
});
