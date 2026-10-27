import { describe, expect, test } from "bun:test";
import { isNoRow, SUPPORTED_LANGUAGES } from "../src/core/intelligence/language-records.js";
import { evaluateAutoApproval, planScopeAdvice, requestedPathTokens } from "../src/core/workflows/auto-approval.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  CHECK_CONFIGS,
  checkConfigLoosening,
  checkConfigOf,
  embeddedCheckLoosening,
} from "../src/core/workflows/quality/check-configs.js";
import { unrequestedManifestFields } from "../src/core/workflows/quality/dependencies.js";
import type { InputManifest, RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";

// #2221: one table of check-defining configs for every supported language. A request-named edit
// passes only under `requestedCheckTightening` and only when it turns on what the request names.

const examples = [
  ...new Set(
    SUPPORTED_LANGUAGES.flatMap((language) => {
      const row = CHECK_CONFIGS[language];
      return isNoRow(row) ? [] : row.map((config) => config.example);
    }),
  ),
];

describe("check config fields (#2221)", () => {
  // [path, before, after, request, loosened fields]
  const cases: [string, string, string, string, string[]][] = [
    ["tsconfig.json", `{"compilerOptions":{"strict":true}}`, `{ // on\n"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,},}`, "Turn on noUncheckedIndexedAccess.", []],
    ["tsconfig.json", `{"compilerOptions":{"strict":true}}`, `{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}`, "Make the checker stricter.", ["compilerOptions.noUncheckedIndexedAccess"]],
    ["tsconfig.json", `{"compilerOptions":{"strict":true}}`, `{"compilerOptions":{"strict":false,"noUncheckedIndexedAccess":true}}`, "Turn on noUncheckedIndexedAccess; strict stays.", ["compilerOptions.strict"]],
    ["tsconfig.json", `{"compilerOptions":{}}`, `{"compilerOptions":{"skipLibCheck":true},"exclude":["src/legacy"]}`, "Set skipLibCheck and exclude.", ["compilerOptions.skipLibCheck", "exclude[src/legacy]"]],
    ["biome.json", `{"linter":{"rules":{"suspicious":{"noExplicitAny":"warn"}}}}`, `{"linter":{"rules":{"suspicious":{"noExplicitAny":"error"}}}}`, "Raise noExplicitAny to error.", []],
    ["biome.json", `{"linter":{"rules":{"suspicious":{"noExplicitAny":"warn"}}}}`, `{"linter":{"rules":{"suspicious":{"noExplicitAny":"off"}}}}`, "Change noExplicitAny.", ["linter.rules.suspicious.noExplicitAny"]],
    [".eslintrc.json", `{"rules":{"eqeqeq":"warn"}}`, `{"rules":{"eqeqeq":"error"}}`, "eqeqeq as an error", []],
    [".rubocop.yml", "Style/FrozenStringLiteralComment:\n  Enabled: false\n", "Style/FrozenStringLiteralComment:\n  Enabled: true\n", "Enable FrozenStringLiteralComment.", []],
    [".rubocop.yml", "Metrics/MethodLength:\n  Max: 10\n", "Metrics/MethodLength:\n  Max: 30\n", "Change Metrics/MethodLength.", ["Metrics/MethodLength.Max"]],
    [".rubocop.yml", "AllCops:\n  Exclude: [db/**]\n", "AllCops:\n  Exclude: [db/**, lib/**]\n", "x", ["AllCops.Exclude[lib/**]"]],
    ["ruff.toml", "[lint]\nselect = ['E']\nignore = ['E501']\n", "[lint]\nselect = ['E', 'B']\nignore = []\n", "Select B and stop ignoring E501.", ["lint.ignore[]"]],
    ["ruff.toml", "[lint]\nselect = ['E', 'B']\n", "[lint]\nselect = ['E']\n", "Select B.", ["lint.select[B]"]],
    ["mypy.ini", "[mypy]\nstrict = False\n", "[mypy]\nstrict = True\n", "Turn on strict in mypy.ini.", []],
    ["mypy.ini", "[mypy]\n", "[mypy]\nignore_missing_imports = True\n", "ignore_missing_imports", ["mypy.ignore_missing_imports"]],
    [".pylintrc", "[MESSAGES CONTROL]\ndisable=\n    C0114,\n    C0115\n", "[MESSAGES CONTROL]\ndisable=\n    C0114\n", "Re-enable C0115.", []],
    [".pylintrc", "[MESSAGES CONTROL]\ndisable=\n    C0114\n", "[MESSAGES CONTROL]\ndisable=\n    C0114,\n    W0611\n", "x", ["MESSAGES CONTROL.disable[W0611]"]],
    [".golangci.yml", "linters:\n  enable: [errcheck]\n", "linters:\n  enable: [errcheck, gosec]\n", "Enable gosec.", []],
    [".golangci.yml", "linters:\n  enable: [errcheck, gosec]\n", "linters:\n  enable: [errcheck]\n  disable: [gosec]\n", "gosec", ["linters.disable[gosec]", "linters.enable[gosec]"]],
    ["clippy.toml", "cognitive-complexity-threshold = 30\n", "cognitive-complexity-threshold = 20\n", "Lower cognitive-complexity-threshold.", []],
    ["clippy.toml", "cognitive-complexity-threshold = 20\n", "cognitive-complexity-threshold = 30\n", "cognitive-complexity-threshold", ["cognitive-complexity-threshold"]],
    ["checkstyle.xml", `<module name="Checker"><module name="TreeWalker"/></module>`, `<module name="Checker"><module name="TreeWalker"><module name="MissingJavadocMethod"><property name="scope" value="public"/></module></module></module>`, "Add MissingJavadocMethod.", []],
    ["phpcs.xml", `<ruleset name="P"><rule ref="PSR12"/></ruleset>`, `<ruleset name="P"><rule ref="PSR12"><exclude name="Generic.Files.LineLength"/></rule></ruleset>`, "x", ["ruleset[P]/rule[PSR12]/exclude[Generic.Files.LineLength]"]],
    [".swiftlint.yml", "disabled_rules: [force_cast]\n", "disabled_rules: []\n", "Stop disabling force_cast.", ["disabled_rules[]"]],
    ["analysis_options.yaml", "analyzer:\n  language:\n    strict-casts: false\n", "analyzer:\n  language:\n    strict-casts: true\n", "Turn on strict-casts.", []],
    [".editorconfig", "[*.cs]\ndotnet_diagnostic.CA1062.severity = warning\n", "[*.cs]\ndotnet_diagnostic.CA1062.severity = error\n", "Raise CA1062.", []],
    [".editorconfig", "[*.cs]\ndotnet_diagnostic.CA1062.severity = warning\n", "[*.cs]\ndotnet_diagnostic.CA1062.severity = none\n", "CA1062", ["*.cs.dotnet_diagnostic.CA1062.severity"]],
    [".shellcheckrc", "disable=SC2086\n", "\n", "Stop disabling SC2086.", []],
    [".credo.exs", "%{configs: []}\n", "%{configs: [%{name: \"default\"}]}\n", "Tighten .credo.exs.", ["content"]],
    ["detekt.yml", "complexity:\n  LongMethod:\n    active: false\n", "complexity:\n  LongMethod:\n    active: true\n", "Activate LongMethod.", []],
  ];
  test.each(cases)("%s: %p -> %p", (path, before, after, request, loosened) => {
    expect(checkConfigLoosening(path, before, after, request).sort()).toEqual([...loosened].sort());
  });

  test("check settings a manifest holds are held the same way", () => {
    const before = "[project]\nname = 'a'\n\n[tool.ruff.lint]\nselect = ['E']\n";
    expect(embeddedCheckLoosening("pyproject.toml", before, `${before.replace("['E']", "['E', 'B']")}`, "Select B.")).toEqual([]);
    expect(embeddedCheckLoosening("pyproject.toml", before, `${before}ignore = ['E501']\n`, "E501")).toEqual(["tool.ruff.lint.ignore[E501]"]);
    expect(embeddedCheckLoosening("Cargo.toml", "[lints.clippy]\n", "[lints.clippy]\nunwrap_used = 'deny'\n", "deny unwrap_used")).toEqual([]);
    expect(embeddedCheckLoosening("Cargo.toml", "[lints.clippy]\nunwrap_used = 'deny'\n", "[lints.clippy]\nunwrap_used = 'allow'\n", "unwrap_used")).toEqual(["lints.clippy.unwrap_used"]);
    expect(embeddedCheckLoosening("App.csproj", "<Project><PropertyGroup><NoWarn>CS1591</NoWarn></PropertyGroup></Project>", "<Project><PropertyGroup><NoWarn>CS1591;CS8618</NoWarn></PropertyGroup></Project>", "x")).toEqual(["NoWarn[CS8618]"]);
    expect(embeddedCheckLoosening("package.json", `{"eslintConfig":{"rules":{"eqeqeq":"error"}}}`, `{"eslintConfig":{"rules":{"eqeqeq":"off"}}}`, "eqeqeq")).toEqual(["eslintConfig.rules.eqeqeq"]);
    expect(embeddedCheckLoosening("setup.cfg", "[flake8]\nmax-line-length = 88\n", "[flake8]\nmax-line-length = 120\n[metadata]\nname = a\n", "x")).toEqual(["flake8.max-line-length"]);
    // A manifest named for another field: a loosened check section is a finding of the field check.
    const changed = [{ path: "pyproject.toml", before, content: `${before}ignore = ['E501']\n` }];
    expect(unrequestedManifestFields(changed, ["pyproject.toml"], "Bump the version in pyproject.toml.")).toEqual([{ file: "pyproject.toml", field: "tool.ruff.lint.ignore[E501]", check: true }]);
  });

  test("a request names a check config by its file name, also one without a dot inside", () => {
    expect(requestedPathTokens("Tighten .editorconfig and .shellcheckrc.")).toEqual([".editorconfig", ".shellcheckrc"]);
  });
});

const hash = "a".repeat(64);
const manifest = { workflowHash: hash, profileHashes: {}, skillHashes: {} } as unknown as InputManifest;
const spec = { criteria: [], requirements: [] } as unknown as Spec;
type Write = TaskGraph["tasks"][number]["writes"][number];
const graph = (...writes: Write[]): TaskGraph =>
  ({ tasks: [{ id: "T001", description: "Task", writes, profileId: "implementer" }] }) as unknown as TaskGraph;
const limits = { maxTasks: 5, maxFiles: 5, allowedPaths: ["**"], allowDelete: true, allowNewDependencies: false as const, maxTotalTokens: defaultWorkflowPolicy.maxTotalTokens };
const policy = (extra: Partial<NonNullable<RunPolicy["autoApproval"]>> = {}, stopModes?: RunPolicy["stopModes"]): RunPolicy => ({
  ...defaultWorkflowPolicy,
  autoApproval: { renewal: false, limits, ...extra },
  ...(stopModes ? { stopModes } : {}),
});
const present = { exists: () => true, scaffold: false };

describe("auto-approval of check configs, per language row (#2221)", () => {
  test("every supported language has a row or a reason, and every row an example it matches", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const row = CHECK_CONFIGS[language];
      if (isNoRow(row)) expect(row.none.length).toBeGreaterThan(10);
      else for (const config of row) expect(checkConfigOf(config.example)).toBe(config);
    }
  });

  test.each(examples)("%s", (path) => {
    const enforced = checkConfigOf(path)?.enforced === true;
    const edit = graph({ path, action: "modify" });
    const request = `Create the value. Tighten ${path}.`;
    // Unnamed: tsconfig and biome need a person; every other config records a would-stop.
    const unnamed = evaluateAutoApproval(policy(), manifest, spec, edit, [], [], { ...present, request: "Create the value." });
    if (enforced) {
      expect(unnamed.approval).toBeNull();
      expect(unnamed.reasons.join("\n")).toContain(`${path} always needs a person`);
    } else {
      expect(unnamed.approval?.mode).toBe("limits");
      expect(unnamed.configWouldStop).toEqual({ mode: "shadow", problems: [expect.stringContaining(`${path} needs a person: a `)] });
      const strict = evaluateAutoApproval(policy({}, { "check-config-approval": "enforce" }), manifest, spec, edit, [], [], { ...present, request: "Create the value." });
      expect(strict.approval).toBeNull();
      expect(strict.configWouldStop).toBeUndefined();
    }
    // Named, without the opt-in: a person, as before.
    const off = evaluateAutoApproval(policy({ requestedManifestEdits: true }), manifest, spec, edit, [], [], { ...present, request });
    if (enforced) expect(off.reasons.join("\n")).toContain("autoApproval.requestedCheckTightening approves a tightening the request names");
    else expect(off.configWouldStop?.problems.join("\n")).toContain(path);
    // Named, opted in: approved, no would-stop, and the planner is not told to drop it.
    const opted = policy({ requestedCheckTightening: true });
    const on = evaluateAutoApproval(opted, manifest, spec, edit, [], [], { ...present, request });
    expect(on.reasons).toEqual([]);
    expect(on.approval?.mode).toBe("limits");
    expect(on.configWouldStop).toBeUndefined();
    expect(planScopeAdvice(opted, edit, () => true, false, request)).toEqual([]);
    // Deleting it is never a tightening.
    const deleted = evaluateAutoApproval(opted, manifest, spec, graph({ path, action: "delete" }), [], [], { ...present, request });
    if (enforced) expect(deleted.approval).toBeNull();
    else expect(deleted.configWouldStop?.problems.join("\n")).toContain(path);
    // Creating one that is not there yet is how a project starts.
    expect(evaluateAutoApproval(policy(), manifest, spec, graph({ path, action: "create" }), [], [], { exists: () => false, request: "x" }).configWouldStop).toBeUndefined();
  });

  test("a host-written config is compared with what it replaces: a named tightening passes, a loosening keeps the person", () => {
    const opted = policy({ requestedCheckTightening: true });
    const read = () => `{"compilerOptions":{"strict":true}}`;
    const request = "Turn on noUncheckedIndexedAccess in tsconfig.json.";
    const write = (content: string): TaskGraph => graph({ path: "tsconfig.json", action: "modify", content } as Write);
    expect(evaluateAutoApproval(opted, manifest, spec, write(`{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true}}`), [], [], { ...present, request, read }).approval?.mode).toBe("limits");
    const loose = evaluateAutoApproval(opted, manifest, spec, write(`{"compilerOptions":{"strict":false,"noUncheckedIndexedAccess":true}}`), [], [], { ...present, request, read });
    expect(loose.approval).toBeNull();
    expect(loose.reasons.join("\n")).toContain("tsconfig.json needs a person: a tsconfig config sets what the checks enforce; the planned content changes compilerOptions.strict, which is not a tightening the request names");
  });

  test("a file outside the table is unchanged", () => {
    for (const path of ["src/config.yml", "src/settings.json", "README.md"])
      expect(evaluateAutoApproval(policy(), manifest, spec, graph({ path, action: "modify" }), [], [], { ...present, request: "x" })).toEqual({ approval: expect.objectContaining({ mode: "limits" }), reasons: [] });
  });
});
