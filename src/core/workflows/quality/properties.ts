/**
 * Property-based tests from the spec's acceptance criteria (#637). The spec author marks a
 * criterion whose behavior holds over a whole input domain with `property`; the planner gives it
 * a test task that writes a property with the ecosystem's library, and the host checks after the
 * command checks that each marked criterion has one. A failing property's shrunk counterexample
 * is put into the failed check's finding, so the correction starts from a reproduction.
 */
import { isTestCodePath } from "./duplication.js";

export type PropertyTestsMode = "auto" | "off";
export const PROPERTY_DOMAINS = [
  "numbers",
  "strings",
  "parsing",
  "round-trip",
  "invariant",
] as const;
/** Artifact of the latest property-test check of a run. */
export const QUALITY_PROPERTIES = "quality/properties.json";
/** Whether a finding's claim is one the property-test check made. */
export const propertyClaim = (claim: unknown): boolean =>
  typeof claim === "string" && /^Property test missing for \S+: /.test(claim);

/** The mode when neither the policy nor the project names one: by workflow preset. */
export function presetPropertyTests(preset: string): PropertyTestsMode {
  return preset === "standard" || preset === "full" || preset === "tdd" || preset === "harden"
    ? "auto"
    : "off";
}
export const propertyTestsOf = (
  policy: { propertyTests?: PropertyTestsMode | undefined },
  preset: string,
): PropertyTestsMode => policy.propertyTests ?? presetPropertyTests(preset);

/** The property library of each language, as the instructions name it and the host finds it. */
const LIBRARIES: readonly { language: string; files: RegExp; library: string; uses: RegExp }[] = [
  {
    language: "JS/TS",
    files: /\.[cm]?[jt]sx?$/,
    library: "fast-check",
    uses: /\bfrom\s+["']fast-check["']|require\(\s*["']fast-check["']\s*\)|\bfc\.(?:assert|property|asyncProperty)\(/,
  },
  {
    language: "Python",
    files: /\.py$/,
    library: "Hypothesis",
    uses: /@given\(|\bfrom\s+hypothesis\b|\bimport\s+hypothesis\b/,
  },
  {
    language: "Rust",
    files: /\.rs$/,
    library: "proptest",
    uses: /\bproptest!|\bquickcheck!|#\[quickcheck\]|\bproptest::/,
  },
  {
    language: "Java/Kotlin",
    files: /\.(?:java|kt)$/,
    library: "jqwik",
    uses: /@Property\b|\bnet\.jqwik\b/,
  },
  {
    language: "Go",
    files: /\.go$/,
    library: "rapid",
    uses: /\brapid\.Check\(|\bgopter\b|\bquick\.Check\(/,
  },
  {
    language: "C#/F#",
    files: /\.(?:cs|fs)$/,
    library: "FsCheck",
    uses: /\bFsCheck\b|\[Property\b|Prop\.ForAll/,
  },
];

/** Whether a test file holds a property-based test. */
export function hasPropertyTest(path: string, content: string): boolean {
  return LIBRARIES.some((lib) => lib.files.test(path) && lib.uses.test(content));
}

/** What the agents are told while the mode is `auto`, by the stage they run. */
export function propertyTestsNote(output: string): string | null {
  const libraries = LIBRARIES.map((lib) => `${lib.library} (${lib.language})`).join(", ");
  if (output === "spec")
    return `Property-based tests are on. Mark each criterion whose behavior should hold for every input of a domain with "property": one of ${PROPERTY_DOMAINS.join(", ")}. Typical cases: numeric conversions and arithmetic, string handling, parsers, encode/decode or serialize/parse round trips, and invariants such as sorting keeping every element. Leave property out for criteria about one fixed example, the UI, or external services.`;
  if (output === "plan")
    return `Property-based tests are on. Each criterion with "property" needs a test task that covers it and writes a property-based test file with the ecosystem library: ${libraries}. When the project does not declare that library, the task also adds it to the manifest as a development dependency; it is listed as a new dependency in the run report. The host checks after the checks that each such criterion has a property test.`;
  if (output === "implementation")
    return `Property-based tests are on. When this task covers a criterion with "property", write a property-based test for it with ${libraries}: generate inputs over the criterion's whole domain (negative numbers, zero and -0, empty and unicode strings, the largest values), assert the stated behavior for all of them, and keep the example tests too. Declare the library as a development dependency if the project lacks it. A failing property prints a shrunk counterexample: treat it as a reproduction and fix the code, not the property, unless the property contradicts the spec.`;
  return null;
}

export interface PropertyCriterion {
  id: string;
  domain: string;
  /** The test files of the tasks that cover it, and whether each holds a property. */
  tests: { file: string; property: boolean }[];
  status: "found" | "missing";
}

export interface PropertiesResult {
  schemaVersion: 1;
  mode: PropertyTestsMode;
  criteria: PropertyCriterion[];
}

/** Each marked criterion with the test files of its tasks; `read` returns a file's content or null. */
export function checkPropertyTests(
  mode: PropertyTestsMode,
  criteria: { id: string; property?: string | undefined }[],
  tasks: { criterionIds: string[]; writes: { path: string; action: string }[] }[],
  read: (path: string) => string | null,
): PropertiesResult {
  const out: PropertyCriterion[] = [];
  for (const criterion of criteria) {
    if (!criterion.property) continue;
    const files = [
      ...new Set(
        tasks
          .filter((t) => t.criterionIds.includes(criterion.id))
          .flatMap((t) => t.writes.filter((w) => w.action !== "delete").map((w) => w.path))
          .filter(isTestCodePath),
      ),
    ];
    const tests = files.map((file) => {
      const content = read(file);
      return { file, property: content !== null && hasPropertyTest(file, content) };
    });
    out.push({
      id: criterion.id,
      domain: criterion.property,
      tests,
      status: tests.some((t) => t.property) ? "found" : "missing",
    });
  }
  return { schemaVersion: 1, mode, criteria: out };
}

const COUNTEREXAMPLE: readonly RegExp[] = [
  /Counterexample: (.+)/, // fast-check
  /Falsifying example: ([^\n]+(?:\n {4}[^\n]+)*(?:\n\))?)/, // Hypothesis
  /minimal failing input: (.+)/, // proptest
  /Shrunk Sample[^\n]*\n\s*-*\s*\n?\s*(.+)/, // jqwik
  /\[rapid\] (?:minimal failing|draw) [^\n]*\n?(.*)/, // rapid
  /Falsified after \d+ passed tests\.\s*\n(.+)/, // gopter
  /Falsifiable, after \d+ tests?[^\n]*:\s*\n?(.+)/, // FsCheck
];

/** The shrunk counterexample a failing property printed, or null. */
export function counterexampleOf(output: string): string | null {
  for (const pattern of COUNTEREXAMPLE) {
    const found = pattern.exec(output)?.[1]?.trim();
    if (found) return found.replace(/\s+/g, " ").slice(0, 300);
  }
  return null;
}
