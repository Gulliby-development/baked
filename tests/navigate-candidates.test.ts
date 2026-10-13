import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { preferProjectFiles } from "../src/core/tools/navigate.js";

const root = join("/work", "cidrfold");

describe("navigate symbol candidates", () => {
  test("toolchain files outside the project do not make a project symbol ambiguous", () => {
    const own = join(root, "internal", "cli", "cli.go");
    const goroot = join("/usr", "local", "go", "src", "internal", "runtime", "exithook", "hooks.go");
    expect(preferProjectFiles([own, goroot], root)).toEqual([own]);
  });

  test("dependency folders inside the project rank below project files", () => {
    const own = join(root, "cmd", "main.go");
    const vendored = join(root, "vendor", "github.com", "x", "run.go");
    expect(preferProjectFiles([vendored, own], root)).toEqual([own]);
  });

  test("two project files stay ambiguous", () => {
    const a = join(root, "a", "run.go");
    const b = join(root, "b", "run.go");
    expect(preferProjectFiles([a, b], root)).toEqual([a, b]);
  });

  test("candidates outside the project are kept when the project has none", () => {
    const dep = join("/usr", "local", "go", "src", "os", "exec.go");
    expect(preferProjectFiles([dep], root)).toEqual([dep]);
  });
});
