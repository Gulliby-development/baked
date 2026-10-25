/**
 * Property-based tests from the spec's acceptance criteria (#637). The spec author marks a
 * criterion whose behavior holds over a whole input domain with `property`; the planner gives it
 * a test task that writes a property with the ecosystem's library the project already has, or a
 * library-free one with a seeded generator, and the host checks after the command checks that
 * each marked criterion has one (#796: a run is never asked for a dependency it cannot install). A failing property's shrunk counterexample
 * is put into the failed check's finding, so the correction starts from a reproduction.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { type LanguageRecord, none, rowOf } from "../../intelligence/language-records.js";
import { detectLanguageFromPath } from "../../intelligence/types.js";
import { readablePath } from "../../specs/validate.js";
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
/**
 * Whether the request forbids property-based or generated tests ("plain example tests only", "no
 * property-based tests"). The request is authoritative: such a run has the mode `off`, so no
 * criterion is marked and no task is asked for one (envguard 8b8b7022, bench round 15: the spec
 * marked criteria `property`, the worker met the brief's ban and stopped with spec_conflict).
 */
export function bansPropertyTests(request: string): boolean {
  return (
    /\b(?:no|not|never|without|avoid|don't|do not|forbid\w*|ban\w*)\b[^.\n]{0,60}\b(?:property[- ]based|property tests?|generative|generated tests?|fuzz(?:ing|ed)? tests?|hypothesis|fast-check|quickcheck|proptest)\b/i.test(
      request,
    ) ||
    /\b(?:only|plain|just)\s+(?:\w+\s+){0,2}example(?:[- ]based)?\s+tests?\b/i.test(request) ||
    /\bexample(?:[- ]based)?\s+tests?\s+only\b/i.test(request) ||
    // A ban on random or fuzzed input forbids the generator a property test needs (#1064:
    // cidrfold-update, "plain `testing` tests, no fuzzing, no random numbers").
    // A bare "random" counts only right after the negation ("no random"), so "do not pick a random
    // port" bans nothing.
    /\b(?:no|without)\s+(?:fuzz(?:ing|er)?|random(?:ness)?)\b/i.test(request) ||
    /\b(?:no|not|never|without|avoid|don't|do not|forbid\w*|ban\w*)\b[^.\n]{0,30}\b(?:fuzz(?:ing|ed|er)?|randomness|randomi[sz]ed\s+(?:tests?|testing|inputs?)|random\s+(?:numbers?|inputs?|data|values|tests?|testing|generators?))\b/i.test(
      request,
    ) ||
    /\b(?:only\s+deterministic\s+tests?|deterministic\s+tests?\s+only)\b/i.test(request)
  );
}
/** Whether the request asks for property-based or generated tests itself; a ban wins over it. */
export function asksPropertyTests(request: string): boolean {
  return (
    !bansPropertyTests(request) &&
    /\b(?:property[- ]based|property tests?|generative tests?|generated (?:inputs?|tests?)|fuzz(?:ing|ed)? tests?|hypothesis|fast-check|quickcheck|proptest|jqwik|fscheck|cscheck|seeded (?:generator|loop|prng))\b/i.test(
      request,
    )
  );
}

/** What the repository's own tests held before the run wrote any (#1872). */
export interface PropertyRepository {
  /** Test files of the workspace when the run looked. */
  testFiles: number;
  /** Those holding a property test the host recognizes (library, seeded or exhaustive). */
  propertyTests: string[];
}

/** The test files among `paths` and the property tests among them; `read` gives a file's text or null. */
export function propertyRepository(
  paths: readonly string[],
  read: (path: string) => string | null,
): PropertyRepository {
  const tests = paths.filter(isTestCodePath);
  const propertyTests = tests.filter((path) => {
    const kind = propertyTestKind(path, read(path) ?? "");
    return kind === "library" || kind === "seeded" || kind === "exhaustive";
  });
  return { testFiles: tests.length, propertyTests };
}

/**
 * Whether an existing repository declines the preset's property tests: it has tests, none of them
 * a property test, no property library of its own (Go's standard `testing/quick` is everywhere,
 * so it does not count), and the request does not ask for them. Its own tests are the convention:
 * jsonsplice-update (bench round 58) got two seeded 100-value loops in a repository with none,
 * from criteria the spec author marked on fixed Input | Expected tables (#1872).
 */
export function repositoryDeclinesPropertyTests(
  repository: PropertyRepository | null | undefined,
  libraries: Record<string, boolean> | undefined,
  request: string,
): boolean {
  if (!repository || repository.testFiles === 0 || repository.propertyTests.length) return false;
  const library = Object.entries(libraries ?? {}).some(
    ([language, has]) => has && language !== GO.language,
  );
  return !library && !asksPropertyTests(request);
}

/**
 * The property-test mode of a run: a request that bans them turns it off; a mode the policy sets
 * is kept; otherwise the preset's, except that an existing repository whose tests have no
 * property test keeps to its convention (`repositoryDeclinesPropertyTests`).
 */
export const propertyTestsOf = (
  policy: { propertyTests?: PropertyTestsMode | undefined },
  preset: string,
  request = "",
  repository?: { repository: PropertyRepository | null; libraries?: Record<string, boolean> },
): PropertyTestsMode =>
  bansPropertyTests(request)
    ? "off"
    : (policy.propertyTests ??
      (repositoryDeclinesPropertyTests(repository?.repository, repository?.libraries, request)
        ? "off"
        : presetPropertyTests(preset)));

interface PropertyLibrary {
  /** The language as the instructions and the library probe name it. */
  language: string;
  library: string;
  uses: RegExp;
  /** A test that imports the library only behind a fallback, so it runs without it. */
  shim: RegExp;
  /** A library-free property test: a seeded generator in the project's own test framework. */
  seeded: RegExp;
  /**
   * A deterministic property test: a loop over a bounded domain of at least 100 values (every
   * mask of a byte, every host of a /24), for a request that forbids random input (#1064).
   */
  exhaustive: RegExp;
}

const JS: PropertyLibrary = {
  language: "JS/TS",
  library: "fast-check",
  uses: /\bfrom\s+["']fast-check["']|require\(\s*["']fast-check["']\s*\)|\bfc\.(?:assert|property|asyncProperty)\(/,
  shim: /\btry\s*\{[^}]*(?:require|import)\(\s*["']fast-check["']/,
  seeded: /\b(?:seed|mulberry32|xorshift\w*|splitmix\w*|lcg|prng)\b[\s\S]*\bfor\s*\(/i,
  exhaustive:
    /\bfor\s*\(\s*(?:let|var)\s+\w+\s*=\s*-?\d+\s*;\s*\w+\s*<=?\s*(?:\d{3,}|\d+\s*<<\s*\d+|2\s*\*\*\s*\d+)/,
};
const PYTHON: PropertyLibrary = {
  language: "Python",
  library: "Hypothesis",
  uses: /@given\(|\bfrom\s+hypothesis\b|\bimport\s+hypothesis\b/,
  shim: /\btry:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+(?:from\s+hypothesis\b|import\s+hypothesis\b)[\s\S]*?\nexcept\b[^\n]*(?:ImportError|ModuleNotFoundError|Exception)/,
  seeded:
    /\brandom\.(?:Random\(|seed\()[\s\S]*\bfor\s+\w+\s+in\b|\bfor\s+\w+\s+in\b[\s\S]*\brandom\.(?:Random\(|seed\()/,
  exhaustive:
    /\bfor\s+\w+\s+in\s+range\(\s*(?:-?\d+\s*,\s*)?(?:\d{3,}|\d+\s*<<\s*\d+|2\s*\*\*\s*\d+)|\bitertools\.product\(/,
};
const RUST: PropertyLibrary = {
  language: "Rust",
  library: "proptest",
  uses: /\bproptest!|\bquickcheck!|#\[quickcheck\]|\bproptest::/,
  shim: /$^/,
  seeded:
    /\b(?:seed_from_u64|from_seed|wrapping_mul)\b[\s\S]*\bfor\s+\w+\s+in\b|\bfor\s+\w+\s+in\b[\s\S]*\b(?:seed_from_u64|from_seed|wrapping_mul)\b/,
  exhaustive:
    /\bfor\s+\w+\s+in\s+(?:\(?-?\d+(?:[iu]\d+)?\s*\.\.=?\s*(?:\d{3,}|\d+\s*<<\s*\d+|[iu]\d+::MAX)|[iu]\d+::MIN\s*\.\.=?\s*[iu]\d+::MAX)/,
};
const JVM: PropertyLibrary = {
  language: "Java/Kotlin",
  library: "jqwik or Kotest property",
  // Kotest's `checkAll`/`forAll` come from `io.kotest.property` (#1686).
  uses: /@Property\b|\bnet\.jqwik\b|\bio\.kotest\.property\b/,
  shim: /$^/,
  seeded: /\bRandom\(\s*\d+L?\s*\)[\s\S]*\b(?:for|repeat)\s*\(/,
  exhaustive:
    /\bfor\s*\(\s*(?:int|long|var|val)\s+\w+\s*=\s*-?\d+L?\s*;\s*\w+\s*<=?\s*(?:\d{3,}|\d+\s*<<\s*\d+|2\s*\*\*\s*\d+)|\bfor\s*\(\s*\w+\s+in\s+-?\d+\s*(?:\.\.|until)\s*(?:\d{3,}|\d+\s*<<\s*\d+|2\s*\*\*\s*\d+)|\b(?:Int|Long)Stream\.range(?:Closed)?\(\s*-?\d+L?\s*,\s*(?:\d{3,}|\d+\s*<<\s*\d+)|\(\s*-?\d+\s*(?:\.\.|until)\s*(?:\d{3,}|\d+\s*<<\s*\d+)\s*\)\s*\.(?:forEach|map|all|none|filter)\b/,
};
const GO: PropertyLibrary = {
  language: "Go",
  library: "testing/quick",
  uses: /\brapid\.Check\(|\bgopter\b|\bquick\.Check\(/,
  shim: /$^/,
  seeded: /\brand\.New\(\s*rand\.NewSource\(|\brand\.NewPCG\(/,
  exhaustive:
    /\bfor\s+\w+\s*:=\s*-?\d+\s*;\s*\w+\s*<=?\s*(?:\d{3,}|\d+\s*<<\s*\d+|2\s*\*\*\s*\d+|math\.Max\w+)|\bfor\s+\w+\s*:=\s*range\s+(?:\d{3,}|\d+\s*<<\s*\d+|2\s*\*\*\s*\d+)/,
};
const DOTNET: PropertyLibrary = {
  language: "C#/F#",
  library: "FsCheck or CsCheck",
  uses: /\bFsCheck\b|\[Property\b|Prop\.ForAll|\bCsCheck\b|\bGen\.\w+(?:\.\w+|\[[^\]]*\]|\([^)]*\))*\.Sample\(/,
  shim: /$^/,
  seeded: /\bRandom\(\s*\d+\s*\)[\s\S]*\b(?:for|foreach)\s*\(/,
  exhaustive:
    /\bfor\s*\(\s*(?:int|long|var)\s+\w+\s*=\s*-?\d+\s*;\s*\w+\s*<=?\s*(?:\d{3,}|\d+\s*<<\s*\d+|2\s*\*\*\s*\d+)|\bfor\s+\w+\s+in\s+-?\d+\s*\.\.\s*(?:\d{3,}|\d+\s*<<\s*\d+|2\s*\*\*\s*\d+)|\bEnumerable\.Range\(\s*-?\d+\s*,\s*(?:\d{3,}|\d+\s*<<\s*\d+)/,
};

/** The libraries in the order the instructions list them. */
const LIBRARIES: readonly PropertyLibrary[] = [JS, PYTHON, RUST, JVM, GO, DOTNET];

/**
 * The property library of each supported language, as the instructions name it and the host
 * finds it (#1717, #1733). A language without one has a `none` row: its tests are not judged as
 * property tests.
 */
export const PROPERTY_LIBRARIES: LanguageRecord<PropertyLibrary> = {
  typescript: JS,
  javascript: JS,
  vue: none("Vue components are tested from .ts or .js files, which the JavaScript row reads"),
  svelte: none(
    "Svelte components are tested from .ts or .js files, which the JavaScript row reads",
  ),
  rescript: none("ReScript has no property library this check knows"),
  python: PYTHON,
  rust: RUST,
  java: JVM,
  kotlin: JVM,
  go: GO,
  csharp: DOTNET,
  scala: none("ScalaCheck is not recognized yet"),
  c: none("C has no common property library"),
  cpp: none("RapidCheck is not recognized yet"),
  ruby: none("Rantly and PropCheck are not recognized yet"),
  php: none("Eris is not recognized yet (#1491)"),
  swift: none("SwiftCheck is not recognized yet"),
  lua: none("lua-quickcheck is not recognized yet"),
  elixir: none("StreamData is not recognized yet"),
  dart: none("glados is not recognized yet"),
  zig: none("Zig has no common property library"),
  bash: none("shell tests have no property library"),
  ocaml: none("QCheck is not recognized yet"),
  objc: none("Objective-C has no common property library"),
  solidity: none("Foundry fuzz tests are not recognized yet"),
  sql: none("SQL tests (pgTAP, dbt tests) have no property library"),
  powershell: none("PowerShell has no common property library"),
};

/** The library row of a path; F# is not a supported language and shares the .NET row. */
const libraryOf = (path: string): PropertyLibrary | null =>
  /\.fsx?$/i.test(path) ? DOTNET : rowOf(PROPERTY_LIBRARIES, detectLanguageFromPath(path));

export type PropertyTestKind = "library" | "seeded" | "exhaustive" | "shim" | null;

/**
 * What kind of property test a test file holds: one with the ecosystem library, a library-free
 * one with a seeded generator, a deterministic loop over a bounded domain, a library import behind
 * a fallback that fakes it (never counted), or none.
 */
export function propertyTestKind(path: string, content: string): PropertyTestKind {
  const lib = libraryOf(path);
  if (!lib) return null;
  if (lib.shim.test(content)) return "shim";
  if (lib.uses.test(content)) return "library";
  if (lib.seeded.test(content)) return "seeded";
  return lib.exhaustive.test(content) ? "exhaustive" : null;
}

/** Whether a test file holds a property-based test with the ecosystem library. */
export function hasPropertyTest(path: string, content: string): boolean {
  return propertyTestKind(path, content) === "library";
}

/** The language of a path, as the libraries name it. */
export const propertyLanguage = (path: string): string | null => libraryOf(path)?.language ?? null;

/** Artifact with the property libraries the project has, found once per run. */
export const QUALITY_PROPERTY_LIBRARIES = "quality/property-libraries.json";
/** Artifact with the workspace's test files and property tests, found once per run (#1872). */
export const QUALITY_PROPERTY_REPOSITORY = "quality/property-repository.json";

/** What the host can see of the project when it looks for property libraries. */
export interface LibraryProbe {
  /** A file's text under the project root, or null. */
  read(path: string): string | null;
  exists(path: string): boolean;
  /** Paths of the files directly in a directory of the root, or none. */
  list(directory: string): string[];
  /** Whether Python can import a module, or null when there is no Python. */
  pythonImports(module: string): boolean | null;
}

/**
 * The files of a run's root as the library probe reads them. A worktree's linked `node_modules`
 * is read in place (`readablePath`); a path that cannot be read is absent.
 */
export function libraryFiles(root: string): Omit<LibraryProbe, "pythonImports"> {
  return {
    read: (path) => {
      try {
        return readFileSync(readablePath(root, path), "utf8");
      } catch {
        return null;
      }
    },
    exists: (path) => {
      try {
        return existsSync(readablePath(root, path));
      } catch {
        return false;
      }
    },
    list: (directory) => {
      try {
        return readdirSync(directory ? readablePath(root, directory) : root).map((name) =>
          directory ? `${directory}/${name}` : name,
        );
      } catch {
        return [];
      }
    },
  };
}

/**
 * The property library of each language the project can use as it is: installed, or declared
 * where the build fetches it (Cargo, Maven, Gradle, NuGet, Go modules). A declared npm or Python
 * package that is not installed does not count: the checks run without installing it. Go's
 * standard `testing/quick` is always there.
 */
export function propertyLibraries(probe: LibraryProbe): Record<string, boolean> {
  const mentions = (paths: string[], pattern: RegExp) =>
    paths.some((path) => pattern.test(probe.read(path) ?? ""));
  // Listing a file gives nothing, so each root entry is tried as a project directory.
  const projects = ["", ...probe.list("").filter((p) => !p.startsWith("."))].flatMap((dir) =>
    probe.list(dir).filter((p) => /\.(?:cs|fs)proj$/.test(p)),
  );
  const venv = [".venv", "venv"].some(
    (dir) =>
      probe.exists(`${dir}/Lib/site-packages/hypothesis`) ||
      probe.list(`${dir}/lib`).some((lib) => probe.exists(`${lib}/site-packages/hypothesis`)),
  );
  const python =
    ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"].some((file) =>
      probe.exists(file),
    ) || probe.list("").some((path) => path.endsWith(".py"));
  return {
    "JS/TS": probe.exists("node_modules/fast-check/package.json"),
    // Starting Python is slow (and on Windows `python3` can be the Store alias), so only a
    // project with Python in it is asked.
    Python: venv || (python && probe.pythonImports("hypothesis") === true),
    // A `proptest = ...` line or a `[dev-dependencies.proptest]` table, in the root or a member crate.
    Rust: mentions(
      cargoManifests(probe),
      /^\s*(?:proptest|quickcheck)\s*=|^\s*\[(?:(?:dev-|build-)?dependencies|workspace\.dependencies)\.(?:proptest|quickcheck)\]/m,
    ),
    "Java/Kotlin": mentions(
      ["pom.xml", "build.gradle", "build.gradle.kts"],
      /\bjqwik\b|\bkotest-property\b/,
    ),
    Go: true,
    "C#/F#": mentions(projects, /\b(?:FsCheck|CsCheck)\b/),
  };
}

/** The root Cargo.toml and those of its workspace members (`members = ["crates/*", "cli"]`). */
function cargoManifests(probe: LibraryProbe): string[] {
  const root = probe.read("Cargo.toml") ?? "";
  const members = /^\s*members\s*=\s*\[([^\]]*)\]/m.exec(root)?.[1] ?? "";
  const dirs = [...members.matchAll(/["']([^"']+)["']/g)].flatMap(([, member = ""]) =>
    member.endsWith("/*") ? probe.list(member.slice(0, -2)) : [member],
  );
  return ["Cargo.toml", ...dirs.map((dir) => `${dir.replace(/\/$/, "")}/Cargo.toml`)];
}

/** What the agents are told while the mode is `auto`, by the stage they run. */
export function propertyTestsNote(
  output: string,
  libraries: Record<string, boolean> = {},
): string | null {
  const installed = LIBRARIES.filter((lib) => libraries[lib.language]);
  const missing = LIBRARIES.filter((lib) => !libraries[lib.language]);
  const use = installed.length
    ? `Use the property library the project already has: ${installed.map((lib) => `${lib.library} (${lib.language})`).join(", ")}.`
    : "";
  const free = missing.length
    ? ` Where the project has no property library (${missing.map((lib) => lib.language).join(", ")}), write a library-free property test in the project's own test framework: a generator with a fixed seed (for example random.Random(1234) or a small seeded PRNG) that produces at least 100 inputs over the whole domain, edge values included, and checks the criterion for each, printing the failing input; or, where the domain is small enough, a loop over all of it (at least 100 values, such as every mask of a byte). Do not add a dependency for it, and do not import a library behind a fallback.`
    : "";
  const how = `${use}${free}`.trim();
  if (output === "spec")
    return `Property-based tests are on. Mark each criterion whose behavior should hold for every input of a domain with "property": one of ${PROPERTY_DOMAINS.join(", ")}. Typical cases: numeric conversions and arithmetic, string handling, parsers, encode/decode or serialize/parse round trips, and invariants such as sorting keeping every element. Leave property out for criteria about one fixed example or a fixed table of inputs and expected outputs, the UI, or external services. A marked criterion never needs a new dependency: without a property library its test uses a seeded generator or enumerates a bounded domain.`;
  if (output === "plan")
    return `Property-based tests are on. Each criterion with "property" needs a test task that covers it and writes a property-based test file. ${how} The host checks after the checks that each such criterion has a property test.`;
  if (output === "implementation")
    return `Property-based tests are on. When this task covers a criterion with "property", write a property-based test for it: generate inputs over the criterion's whole domain (negative numbers, zero and -0, empty and unicode strings, the largest values), assert the stated behavior for all of them, and keep the example tests too. ${how} A failing property prints a counterexample: treat it as a reproduction and fix the code, not the property, unless the property contradicts the spec.`;
  return null;
}

export interface PropertyCriterion {
  id: string;
  domain: string;
  /** The test files of the tasks that cover it, and the property test each holds. */
  tests: { file: string; property: boolean; kind?: Exclude<PropertyTestKind, null> }[];
  /**
   * `waived`: no property test was recognized, but the project has no property library for the
   * tests' language, so it is a note, not a finding. A fallback shim is always `missing`.
   */
  status: "found" | "missing" | "waived";
  /** Why the criterion is waived or missing, when it is not simply absent. */
  note?: string;
}

export interface PropertiesResult {
  schemaVersion: 1;
  mode: PropertyTestsMode;
  /** The property library of each language the project has; absent in results before #796. */
  libraries?: Record<string, boolean>;
  criteria: PropertyCriterion[];
}

/** Each marked criterion with the test files of its tasks; `read` returns a file's content or null. */
export function checkPropertyTests(
  mode: PropertyTestsMode,
  criteria: { id: string; property?: string | undefined }[],
  tasks: { criterionIds: string[]; writes: { path: string; action: string }[] }[],
  read: (path: string) => string | null,
  libraries?: Record<string, boolean>,
): PropertiesResult {
  const out: PropertyCriterion[] = [];
  for (const criterion of criteria) {
    if (!criterion.property) continue;
    const writes = tasks
      .filter((t) => t.criterionIds.includes(criterion.id))
      .flatMap((t) => t.writes.filter((w) => w.action !== "delete").map((w) => w.path));
    const files = [...new Set(writes.filter(isTestCodePath))];
    const tests = files.map((file) => {
      const content = read(file);
      const kind = content === null ? null : propertyTestKind(file, content);
      return {
        file,
        property: kind === "library" || kind === "seeded" || kind === "exhaustive",
        ...(kind ? { kind } : {}),
      };
    });
    const shim = tests.find((t) => t.kind === "shim");
    // Without a library for the tests' language a property cannot be demanded of the run.
    const languages = new Set(
      (files.length ? files : writes).map(propertyLanguage).filter((l): l is string => !!l),
    );
    const available = !libraries || [...languages].some((language) => libraries[language]);
    const status = tests.some((t) => t.property)
      ? "found"
      : shim || available
        ? "missing"
        : "waived";
    out.push({
      id: criterion.id,
      domain: criterion.property,
      tests,
      status,
      ...(shim && status === "missing"
        ? {
            note: `${shim.file} imports the property library behind a fallback that runs without it`,
          }
        : status === "waived"
          ? {
              note: `no property library is installed for ${[...languages].join(", ") || "the tests' language"} and no seeded property test was recognized`,
            }
          : {}),
    });
  }
  return { schemaVersion: 1, mode, ...(libraries ? { libraries } : {}), criteria: out };
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
