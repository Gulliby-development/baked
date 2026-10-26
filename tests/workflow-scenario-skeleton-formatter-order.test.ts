import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { layoutFree } from "../src/core/workflows/acceptance-rows-inline.js";
import type { InitiativeFeature, InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import { layOutForFormatter } from "../src/core/workflows/initiatives/skeleton-layout.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

// Bench round 70, evalpin (#2222): the brief fixed the layer order of src/lib.rs's `pub mod` lines,
// the decomposer's skeleton carried them in that order and the spec required the host content
// (whitespace only may follow the formatter). The required `cargo fmt --check` and its fixer sorted
// the group (rustfmt's reorder_modules), so AC-015 failed in three review rounds and was accepted
// at converge as a known limitation (USD 0.60). rustfmt and gofmt sort only within a group of
// consecutive lines, so a blank line before each line they would move keeps the order as written.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const LAYERS = ["text", "io", "osio", "options", "json", "jsonpath", "check", "replies", "provider", "suite", "runner", "score", "results", "compare", "report", "cli"];
const LIB_RS = `${LAYERS.map((m) => `pub mod ${m};`).join("\n")}\n`;
const GO_MAIN = 'package main\n\nimport (\n\t"strings"\n\t"fmt"\n\t"os"\n)\n\nfunc main() { fmt.Println(strings.ToUpper(os.Args[0])) }\n';

// A formatter counts as installed only when it leaves an already formatted LF sample unchanged: the
// queue's Windows runner has rustfmt on its path, but it fails or rewrites line endings there, which
// says nothing about the skeleton's order (#2222).
// Every spawn is bounded: a synchronous spawn blocks the event loop, so the test timeout cannot stop
// a tool that waits (the queue's macOS shard ran out of time on this file).
const TOOL_TIMEOUT_MS = 20000;
const SAMPLES: Record<string, string> = { rustfmt: "pub mod a;\n", gofmt: "package main\n" };
const installed = (tool: string): boolean => {
  if (Bun.which(tool) === null) return false;
  if (tool === "cargo" && spawnSync("cargo", ["fmt", "--version"], { encoding: "utf8", timeout: TOOL_TIMEOUT_MS }).status !== 0) return false;
  const sample = SAMPLES[tool === "cargo" ? "rustfmt" : tool];
  if (!sample) return true;
  const run = spawnSync(tool === "cargo" ? "rustfmt" : tool, tool === "gofmt" ? [] : ["--edition", "2021"], { input: sample, encoding: "utf8", timeout: TOOL_TIMEOUT_MS });
  return run.status === 0 && run.stdout === sample;
};
const format = (tool: string, args: string[], input: string): string => {
  const run = spawnSync(tool, args, { input, encoding: "utf8", timeout: TOOL_TIMEOUT_MS });
  if (run.status !== 0) throw new Error(`${tool} failed: ${run.stderr}`);
  return run.stdout;
};

// What a formatter that sorts within groups of consecutive lines does to them, for a machine
// without the tool: each group between blank lines (or other lines) sorted by its key.
const sortedWithinGroups = (content: string, key: (line: string) => string | null): string => {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j < lines.length && key(lines[j] ?? "") !== null) j++;
    if (j > i) {
      const group = lines.slice(i, j).sort((a, b) => ((key(a) ?? "") < (key(b) ?? "") ? -1 : 1));
      lines.splice(i, j - i, ...group);
    }
    i = j + 1;
  }
  return lines.join("\n");
};
const modKey = (line: string) => /^pub mod (\w+);$/.exec(line)?.[1] ?? null;
const importKey = (line: string) => /^\t"([^"]+)"$/.exec(line)?.[1] ?? null;

describe("skeleton content laid out as a fixed point of the formatter (#2222)", () => {
  test("a Rust lib.rs in layer order keeps its order through rustfmt and differs in whitespace only", () => {
    const laid = layOutForFormatter("src/lib.rs", LIB_RS);
    expect(laid?.formatter).toBe("rustfmt");
    const content = laid?.content ?? LIB_RS;
    expect(layoutFree(content, "src/lib.rs")).toBe(layoutFree(LIB_RS, "src/lib.rs"));
    // The order as written: every module still in the brief's layer order.
    expect(content.split("\n").map(modKey).filter(Boolean)).toEqual(LAYERS);
    // Recorded behavior of rustfmt's reorder_modules, so the case runs without the tool.
    expect(sortedWithinGroups(content, modKey)).toBe(content);
    expect(sortedWithinGroups(LIB_RS, modKey)).not.toBe(LIB_RS);
    // Already sorted lists and lists the formatter does not sort are left alone.
    expect(layOutForFormatter("src/lib.rs", "pub mod a;\npub mod b;\n")).toBeNull();
    expect(layOutForFormatter("src/__init__.py", "import sys\nimport os\n")).toBeNull();
  });

  test.skipIf(!installed("rustfmt"))("rustfmt leaves the laid-out lib.rs unchanged in both style editions", () => {
    const content = layOutForFormatter("src/lib.rs", LIB_RS)?.content ?? LIB_RS;
    for (const style of [["--edition", "2021"], ["--edition", "2024", "--style-edition", "2024"]])
      expect(format("rustfmt", style, content)).toBe(content);
    // Attributes and doc comments move with their module, and `use` groups are kept too.
    const mixed = "#[cfg(test)]\nmod tests;\n/// Parsing.\npub(crate) mod parse;\nuse std::io;\nuse std::fmt;\n";
    const laidMixed = layOutForFormatter("src/lib.rs", mixed)?.content ?? mixed;
    expect(format("rustfmt", ["--edition", "2021"], laidMixed)).toBe(laidMixed);
    expect(layoutFree(laidMixed, "src/lib.rs")).toBe(layoutFree(mixed, "src/lib.rs"));
  });

  test.skipIf(!installed("cargo"))("cargo fmt --check passes on a crate whose lib.rs is the laid-out skeleton", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-skeleton-order-"));
    cleanups.push(() => removeTempDir(root));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "evalpin"\nversion = "0.1.0"\nedition = "2021"\n');
    for (const m of LAYERS) writeFileSync(join(root, "src", `${m}.rs`), "// filled later\n");
    const content = layOutForFormatter("src/lib.rs", LIB_RS)?.content ?? LIB_RS;
    writeFileSync(join(root, "src", "lib.rs"), content);
    expect(spawnSync("cargo", ["fmt", "--check"], { cwd: root, encoding: "utf8", timeout: TOOL_TIMEOUT_MS }).status).toBe(0);
    // The fixer the format gate runs changes nothing, so the spec's exact-content criterion holds.
    spawnSync("cargo", ["fmt"], { cwd: root, timeout: TOOL_TIMEOUT_MS });
    expect(readFileSync(join(root, "src", "lib.rs"), "utf8")).toBe(content);
  }, 60000);

  test("a Go import block keeps its order through gofmt", () => {
    const laid = layOutForFormatter("cmd/app/main.go", GO_MAIN);
    expect(laid?.formatter).toBe("gofmt");
    const content = laid?.content ?? GO_MAIN;
    expect(layoutFree(content, "cmd/app/main.go")).toBe(layoutFree(GO_MAIN, "cmd/app/main.go"));
    expect(sortedWithinGroups(content, importKey)).toBe(content);
    if (installed("gofmt")) expect(format("gofmt", [], content)).toBe(content);
  });
});

describe("the decomposer's skeleton is laid out before approval (#2222)", () => {
  const feature = (id: string, paths: string[], dependsOn: string[], extra: Partial<InitiativeFeature> = {}): InitiativeFeature => ({
    id, title: id, boundary: { scope: `The ${id} code`, paths }, contract: `${id} works`, dependsOn, mandatory: true, size: "medium", ...extra,
  });
  const evalpin: InitiativePlan = {
    schemaVersion: 1, title: "evalpin", goals: ["An evaluation pinning CLI"], completionCriteria: ["Every command works"],
    features: [
      feature("base", ["src/lib.rs", "src/text.rs", "src/io.rs", "tests/base.rs"], [], { skeleton: [{ path: "src/lib.rs", content: LIB_RS }] }),
      feature("suite", ["src/suite.rs", "src/runner.rs", "tests/suite.rs"], ["base"]),
      feature("cli", ["src/cli.rs", "src/report.rs", "tests/cli.rs"], ["suite"]),
    ],
  };

  const start = async (policy: RunPolicy) => {
    class Decomposer implements AgentExecutor {
      async execute(request: ExecutionRequest) {
        if (request.profile.output !== "initiativePlan") throw new Error(`Unexpected profile ${request.profile.output}`);
        return { output: evalpin, inputTokens: 20, outputTokens: 30 };
      }
    }
    const root = mkdtempSync(join(tmpdir(), "baked-skeleton-layout-"));
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } };
    const workflows = new NativeWorkflowService(root, config, new Decomposer());
    const initiatives = new InitiativeService(workflows);
    cleanups.push(async () => {
      workflows.close();
      await removeTempDir(root);
    });
    await initiatives.start({ commandId: newId(), initiativeId: "evalpin", prompt: "Build evalpin", policy, keepFeatures: true, ownerLabel: "test" });
    const view = await initiatives.drive("evalpin", new AbortController().signal);
    expect(view.status).toBe("awaiting_approval");
    const lib = view.features.find((f) => f.id === "base")?.skeleton?.find((f) => f.path === "src/lib.rs");
    const event = initiatives.events("evalpin").find((e) => e.type === "split.skeleton_layout")?.payload;
    return { lib, event };
  };

  test("with skeletonLayout on, the host content is a fixed point of rustfmt's module order", async () => {
    const { lib, event } = await start({ ...fixturePolicy, skeletonLayout: "on" });
    const content = lib?.content ?? "";
    expect(sortedWithinGroups(content, modKey)).toBe(content);
    expect(layoutFree(content, "src/lib.rs")).toBe(layoutFree(LIB_RS, "src/lib.rs"));
    if (installed("rustfmt")) expect(format("rustfmt", ["--edition", "2021"], content)).toBe(content);
    expect(event).toMatchObject({ mode: "on", files: [{ featureId: "base", path: "src/lib.rs", formatter: "rustfmt" }] });
  }, 60000);

  test("absent, the layout is recorded in shadow and the content stays as written", async () => {
    const { lib, event } = await start(fixturePolicy);
    expect(lib?.content).toBe(LIB_RS);
    expect(event).toMatchObject({ mode: "shadow", files: [{ featureId: "base", path: "src/lib.rs", formatter: "rustfmt" }] });
  }, 60000);
});
