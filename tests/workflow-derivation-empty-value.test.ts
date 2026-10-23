import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { outputShows, runRepro } from "../src/core/verification/repro.js";
import { verbatimRow } from "../src/core/workflows/conflict-rows.js";
import { derivationFindings } from "../src/core/workflows/derivation-audit.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { DerivationSchema, ReproSchema, type Spec } from "../src/core/workflows/schemas.js";

// Bench round 61, manlens (#1947): render and markdown AC-001 audit the empty document, whose
// correct result is the empty string. The analyzer returned `recomputed: ""`, the schema's
// prose-field rule (`min(1)`) refused it, and each 8 to 13 KB analysis was submitted again. The
// same rule kept a repro of a program that prints nothing from being submitted.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const criterion: Spec["criteria"][number] = {
  id: "AC-001",
  requirementIds: ["FR-001"],
  given: "an empty document",
  when: "it is rendered",
  then: 'the result is:\nInput | expected\n["",30,false] | ""',
  method: "automated",
};
const spec = {
  requirements: [{ id: "FR-001", text: "An empty document renders as the empty string", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [criterion],
} as unknown as Spec;
const emptyRow = {
  criterionId: "AC-001",
  row: '["",30,false] | "x"',
  recomputed: "",
  matches: false,
  derivation: "No title or blocks exist. FR-001 requires an empty string.",
};

describe("an empty literal value", () => {
  test("a derivation whose requirements give the empty string parses, also as the tool's JSON schema", () => {
    expect(DerivationSchema.parse(emptyRow).recomputed).toBe("");
    // Providers receive the schema converted to JSON schema: the empty value must pass there too.
    const json = z.toJSONSchema(DerivationSchema) as { properties: Record<string, { minLength?: number }> };
    expect(json.properties.recomputed?.minLength).toBeUndefined();
    expect(json.properties.row?.minLength).toBe(1);
  });

  test("a repro whose program prints nothing, or is expected to, parses", () => {
    const repro = { executable: "bun", args: ["main.ts"], expected: "Usage: main FILE", actual: "" };
    expect(ReproSchema.parse(repro).actual).toBe("");
    expect(ReproSchema.parse({ ...repro, expected: "", actual: "x" }).expected).toBe("");
  });

  test("the audit finding and the conflict question show an empty value as a quoted empty string", () => {
    const parsed = DerivationSchema.parse(emptyRow);
    const [finding] = derivationFindings(spec, { derivations: [parsed] });
    expect(finding?.description).toContain(
      'row "[\\"\\",30,false] | \\"x\\"": the requirements give "" (No title or blocks exist.',
    );
    expect(verbatimRow({ criterion, audit: [parsed], misquoted: [] })).toContain(
      'does not match; the requirements give ""',
    );
  });

  test("an empty actual is shown only by an empty output", async () => {
    expect(outputShows("\r\n  \n", "")).toBe(true);
    expect(outputShows("x\n", "")).toBe(false);
    const root = mkdtempSync(join(tmpdir(), "baked-repro-empty-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const run = (code: string) =>
      runRepro(
        new ProcessScope(),
        ReproSchema.parse({ executable: "bun", args: ["-e", code], expected: "Usage: main FILE", actual: "" }),
        { root, executables: ["bun"], generated: [], signal: new AbortController().signal, sandbox: null },
      );
    expect((await run("process.exitCode = 0")).status).toBe("reproduced");
    expect((await run("console.log('Usage: main FILE')")).status).toBe("refuted");
  });
});
