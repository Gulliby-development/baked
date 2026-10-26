/**
 * The config files that decide what a language's linters, formatters and type checkers enforce
 * (#2221): `tsconfig.json`, `biome.json`, `.rubocop.yml`, `ruff.toml`, `clippy.toml`,
 * `.golangci.yml`, `checkstyle.xml` and the rest. A run that loosens one passes its checks without
 * fixing anything, so the auto-approval keeps an edit of an existing one with a person, and a
 * request-named edit passes only under `autoApproval.requestedCheckTightening` and only when the
 * diff turns on the strictness settings the request names (`checkConfigLoosening`).
 *
 * Each config is read into labelled fields: a JSON, YAML or TOML file by its key path
 * (`compilerOptions.noUncheckedIndexedAccess`), a list item as `path[item]`, an INI file by
 * `section.key`, an XML file by its element path with the `name`/`ref`/`id` of each element. A
 * config that is code (`.credo.exs`, `eslint.config.js`, `.luacheckrc`) or a formatter's layout
 * has one field, its whole text, and no tightening: every change of it loosens as far as the host
 * can tell.
 */
import {
  type LanguageRecord,
  none,
  rowOf,
  SUPPORTED_LANGUAGES,
} from "../../intelligence/language-records.js";

/**
 * The direction a field moves in when it makes a check stricter: `on` a flag turned on, `off` an
 * allowance turned off, `added` an item added to a list of enabled rules, `removed` an item removed
 * from a list of ignores or exclusions, `raised` a severity raised (`severities`, lowest first),
 * `lowered` a numeric threshold lowered.
 */
type Direction = "on" | "off" | "added" | "removed" | "raised" | "lowered";

interface Tightening {
  /** The field label, without a list item's `[item]`. */
  readonly field: RegExp;
  readonly direction: Direction;
}

type Format = "json" | "yaml" | "toml" | "ini" | "xml" | "msbuild" | "text";

export interface CheckConfig {
  /** The tool the config is for, in approval reasons. */
  readonly tool: string;
  /** The file's base name. */
  readonly name: RegExp;
  /** A file name the row matches, for the language parity golden. */
  readonly example: string;
  readonly format: Format;
  /** The fields that make the check stricter in one direction; every other change loosens. */
  readonly tightens: readonly Tightening[];
  /** The severity names of `raised` fields, lowest first; a name at the same index ranks alike. */
  readonly severities?: readonly (readonly string[])[];
  /**
   * The severity a `raised` field has where the config does not set it, when the tool documents
   * one for every rule (`allow`-or-lower for Cargo lints); without it only the highest severity
   * counts as raised from unset.
   */
  readonly unset?: string;
  /** Only these fields decide checks; the rest of the file is another tool's (`rescript.json`). */
  readonly scope?: RegExp;
  /**
   * Kept with a person before #2221 and so enforced; every other row declines an approval only
   * when the `check-config-approval` stop reason is enforced (shadow by default).
   */
  readonly enforced?: true;
}

const on = (field: RegExp): Tightening => ({ field, direction: "on" });
const off = (field: RegExp): Tightening => ({ field, direction: "off" });
const added = (field: RegExp): Tightening => ({ field, direction: "added" });
const removed = (field: RegExp): Tightening => ({ field, direction: "removed" });
const raised = (field: RegExp): Tightening => ({ field, direction: "raised" });
const lowered = (field: RegExp): Tightening => ({ field, direction: "lowered" });

/** A config the host reads as one text: any change of it loosens as far as the host can tell. */
const opaque = (tool: string, name: RegExp, example: string): CheckConfig => ({
  tool,
  name,
  example,
  format: "text",
  tightens: [],
});

const TS_STRICT =
  /^compilerOptions\.(?:strict|noImplicitAny|strictNullChecks|strictFunctionTypes|strictBindCallApply|strictPropertyInitialization|strictBuiltinIteratorReturn|noImplicitThis|alwaysStrict|useUnknownInCatchVariables|noUncheckedIndexedAccess|noImplicitOverride|exactOptionalPropertyTypes|noImplicitReturns|noFallthroughCasesInSwitch|noUnusedLocals|noUnusedParameters|noPropertyAccessFromIndexSignature|forceConsistentCasingInFileNames|noUncheckedSideEffectImports|isolatedModules|isolatedDeclarations|verbatimModuleSyntax|erasableSyntaxOnly|checkJs)$/;
const TS_ALLOWANCES =
  /^compilerOptions\.(?:allowUnreachableCode|allowUnusedLabels|skipLibCheck|skipDefaultLibCheck|suppressImplicitAnyIndexErrors|suppressExcessPropertyErrors)$/;
const TSCONFIG_TIGHTENS = [on(TS_STRICT), off(TS_ALLOWANCES)];
const ESLINT_SEVERITIES = [
  ["off", "0"],
  ["warn", "1"],
  ["error", "2"],
] as const;

const TSCONFIG: CheckConfig = {
  tool: "tsconfig",
  name: /^tsconfig[^/]*$/i,
  example: "tsconfig.json",
  format: "json",
  tightens: TSCONFIG_TIGHTENS,
  enforced: true,
};
const BIOME: CheckConfig = {
  tool: "biome",
  name: /^biome[^/]*$/i,
  example: "biome.json",
  format: "json",
  tightens: [
    raised(/^linter\.rules\.[^.]+\.[^.]+(?:\.level)?$/),
    on(/^(?:linter\.rules\.recommended|linter\.enabled|formatter\.enabled)$/),
    removed(/^(?:files|linter|formatter)\.ignore$/),
  ],
  severities: [["off"], ["info"], ["on", "warn"], ["error"]],
  enforced: true,
};
const ESLINT_TIGHTENS = [raised(/^rules\.[^.]+(?:\.severity)?$/), removed(/^ignorePatterns$/)];
const JS: readonly CheckConfig[] = [
  TSCONFIG,
  BIOME,
  {
    ...TSCONFIG,
    tool: "jsconfig",
    name: /^jsconfig[^/]*\.json$/i,
    example: "jsconfig.json",
    enforced: undefined,
  },
  {
    tool: "eslint",
    name: /^\.eslintrc(?:\.json)?$/,
    example: ".eslintrc.json",
    format: "json",
    tightens: ESLINT_TIGHTENS,
    severities: ESLINT_SEVERITIES,
  },
  {
    tool: "eslint",
    name: /^\.eslintrc\.ya?ml$/,
    example: ".eslintrc.yml",
    format: "yaml",
    tightens: ESLINT_TIGHTENS,
    severities: ESLINT_SEVERITIES,
  },
  opaque(
    "eslint",
    /^(?:\.eslintrc\.c?js|eslint\.config\.[cm]?[jt]s|\.eslintignore)$/,
    "eslint.config.js",
  ),
  {
    tool: "oxlint",
    name: /^\.?oxlintrc\.json$/,
    example: ".oxlintrc.json",
    format: "json",
    tightens: ESLINT_TIGHTENS,
    severities: ESLINT_SEVERITIES,
  },
  opaque(
    "prettier",
    /^(?:\.prettierrc(?:\.[\w]+)?|prettier\.config\.[cm]?[jt]s|\.prettierignore)$/,
    ".prettierrc",
  ),
];

const RUFF_SELECT = /^(?:lint\.)?(?:extend-)?select$/;
const RUFF_IGNORE =
  /^(?:lint\.)?(?:(?:extend-)?(?:ignore|exclude|unfixable)|(?:extend-)?per-file-ignores\..+)$/;
const MYPY_ON =
  /(?:^|\.)(?:strict|strict_optional|strict_equality|strict_bytes|extra_checks|check_untyped_defs|no_implicit_optional|no_implicit_reexport|warn_return_any|warn_unused_ignores|warn_unused_configs|warn_redundant_casts|warn_unreachable|warn_no_return|disallow_\w+)$/;
const MYPY_OFF =
  /(?:^|\.)(?:ignore_missing_imports|ignore_errors|implicit_optional|implicit_reexport|allow_untyped_globals|allow_redefinition)$/;

const RUBOCOP_SEVERITIES = [
  ["info"],
  ["refactor"],
  ["convention"],
  ["warning"],
  ["error"],
  ["fatal"],
];
const GOLANGCI_TIGHTENS = [
  added(/^linters\.enable$/),
  removed(/^linters\.(?:disable|exclusions\.(?:rules|paths|presets))$/),
  removed(/^issues\.(?:exclude|exclude-rules|exclude-dirs|exclude-files)$/),
  on(/^linters\.enable-all$/),
  off(/^linters\.disable-all$/),
  raised(/^linters\.default$/),
];
const GOLANGCI_SEVERITIES = [["none"], ["fast", "standard"], ["all"]];
const CLANG_TIDY: CheckConfig = {
  tool: "clang-tidy",
  name: /^\.clang-tidy$/,
  example: ".clang-tidy",
  format: "yaml",
  tightens: [],
};
const C_FAMILY: readonly CheckConfig[] = [
  CLANG_TIDY,
  opaque("clang-format", /^[._]clang-format$/, ".clang-format"),
];
const EDITORCONFIG: CheckConfig = {
  tool: "editorconfig",
  name: /^\.(?:editorconfig|globalconfig)$/,
  example: ".editorconfig",
  format: "ini",
  // .NET analyzer severities and ktlint rules (#2221).
  tightens: [
    raised(/(?:^|\.)dotnet_(?:analyzer_)?diagnostic\.[^.]+\.severity$/),
    raised(/(?:^|\.)dotnet_analyzer_diagnostic\.severity$/),
    on(/(?:^|\.)ktlint_(?:standard|experimental)(?:_[\w-]+)?$/),
  ],
  severities: [["none"], ["silent"], ["suggestion"], ["warning"], ["error"]],
};
const CHECKSTYLE: CheckConfig = {
  tool: "checkstyle",
  name: /^checkstyle[^/]*\.xml$/i,
  example: "checkstyle.xml",
  format: "xml",
  tightens: [added(/(?:^|\/)module$/), raised(/\/property\[severity\]\.value$/)],
  severities: [["ignore"], ["info"], ["warning"], ["error"]],
};
const PMD: CheckConfig = {
  tool: "pmd",
  name: /^pmd[^/]*\.xml$/i,
  example: "pmd-ruleset.xml",
  format: "xml",
  tightens: [added(/(?:^|\/)rule$/), removed(/\/exclude(?:-pattern)?$/)],
};
const SPOTBUGS: CheckConfig = {
  tool: "spotbugs",
  name: /^(?:spotbugs|findbugs)[^/]*exclude[^/]*\.xml$/i,
  example: "spotbugs-exclude.xml",
  format: "xml",
  tightens: [removed(/(?:^|\/)Match$/)],
};
const JVM: readonly CheckConfig[] = [CHECKSTYLE, PMD, SPOTBUGS];

/**
 * The check-defining configs of each supported language (#2221). A language adds its linters',
 * formatters' and type checkers' config files here; the approval, the scope check, the planner's
 * advice and the field check read this table and nothing else, and `tests/language-parity.test.ts`
 * holds each row's golden.
 */
export const CHECK_CONFIGS: LanguageRecord<readonly CheckConfig[]> = {
  typescript: JS,
  javascript: JS,
  vue: JS,
  svelte: JS,
  rescript: [
    ...JS,
    {
      tool: "rescript",
      name: /^(?:rescript|bsconfig)\.json$/,
      example: "rescript.json",
      format: "json",
      tightens: [],
      scope: /^warnings\./,
    },
  ],
  python: [
    {
      tool: "ruff",
      name: /^\.?ruff\.toml$/,
      example: "ruff.toml",
      format: "toml",
      tightens: [added(RUFF_SELECT), removed(RUFF_IGNORE), on(/^(?:lint\.)?preview$/)],
    },
    {
      tool: "mypy",
      name: /^\.?mypy\.ini$/,
      example: "mypy.ini",
      format: "ini",
      tightens: [
        on(MYPY_ON),
        off(MYPY_OFF),
        added(/(?:^|\.)enable_error_code$/),
        removed(/(?:^|\.)(?:disable_error_code|exclude)$/),
      ],
    },
    {
      tool: "flake8",
      name: /^\.flake8$/,
      example: ".flake8",
      format: "ini",
      tightens: [
        added(/^flake8\.(?:extend-)?select$/),
        removed(/^flake8\.(?:(?:extend-)?ignore|per-file-ignores|(?:extend-)?exclude)$/),
        lowered(/^flake8\.max-(?:line-length|complexity)$/),
      ],
    },
    {
      tool: "pylint",
      name: /^\.?pylintrc$/,
      example: ".pylintrc",
      format: "ini",
      tightens: [
        added(/(?:^|\.)enable$/),
        removed(/(?:^|\.)(?:disable|ignore|ignore-patterns)$/),
        lowered(/(?:^|\.)max-[\w-]+$/),
      ],
    },
    {
      tool: "pyright",
      name: /^pyrightconfig\.json$/,
      example: "pyrightconfig.json",
      format: "json",
      tightens: [
        raised(/^typeCheckingMode$/),
        raised(/^report\w+$/),
        added(/^strict$/),
        removed(/^(?:exclude|ignore)$/),
      ],
      severities: [
        ["off", "none", "false"],
        ["basic", "information"],
        ["standard", "warning", "true"],
        ["strict", "error"],
      ],
    },
  ],
  go: [
    {
      tool: "golangci-lint",
      name: /^\.golangci\.ya?ml$/,
      example: ".golangci.yml",
      format: "yaml",
      tightens: GOLANGCI_TIGHTENS,
      severities: GOLANGCI_SEVERITIES,
    },
    {
      tool: "golangci-lint",
      name: /^\.golangci\.toml$/,
      example: ".golangci.toml",
      format: "toml",
      tightens: GOLANGCI_TIGHTENS,
      severities: GOLANGCI_SEVERITIES,
    },
    {
      tool: "golangci-lint",
      name: /^\.golangci\.json$/,
      example: ".golangci.json",
      format: "json",
      tightens: GOLANGCI_TIGHTENS,
      severities: GOLANGCI_SEVERITIES,
    },
    {
      tool: "staticcheck",
      name: /^staticcheck\.conf$/,
      example: "staticcheck.conf",
      format: "toml",
      tightens: [added(/^checks$/)],
    },
  ],
  rust: [
    {
      tool: "clippy",
      name: /^\.?clippy\.toml$/,
      example: "clippy.toml",
      format: "toml",
      tightens: [
        lowered(/(?:threshold|^max-[\w-]+|^too-many-[\w-]+)$/),
        added(/^disallowed-[\w-]+$/),
      ],
    },
    opaque("rustfmt", /^\.?rustfmt\.toml$/, "rustfmt.toml"),
  ],
  java: JVM,
  kotlin: [
    {
      tool: "detekt",
      name: /^\.?detekt[^/]*\.ya?ml$/,
      example: "detekt.yml",
      format: "yaml",
      tightens: [
        on(/\.active$/),
        lowered(/\.(?:threshold|maxLineLength|allowedLines)$/),
        removed(/\.excludes$/),
      ],
    },
    EDITORCONFIG,
    ...JVM,
  ],
  scala: [
    opaque("scalafmt", /^\.scalafmt\.conf$/, ".scalafmt.conf"),
    opaque("scalafix", /^\.scalafix\.conf$/, ".scalafix.conf"),
    {
      tool: "scalastyle",
      name: /^scalastyle[^/]*\.xml$/i,
      example: "scalastyle-config.xml",
      format: "xml",
      tightens: [
        added(/(?:^|\/)check$/),
        on(/\/check\[[^\]]+\]\.enabled$/),
        raised(/\/check\[[^\]]+\]\.level$/),
      ],
      severities: [["info"], ["warning"], ["error"]],
    },
  ],
  csharp: [
    EDITORCONFIG,
    {
      tool: "code analysis ruleset",
      name: /\.ruleset$/i,
      example: "Analyzers.ruleset",
      format: "xml",
      tightens: [raised(/\/Rule\[[^\]]+\]\.Action$/)],
      severities: [["None"], ["Hidden"], ["Info"], ["Warning"], ["Error"]],
    },
    opaque("stylecop", /^stylecop\.json$/i, "stylecop.json"),
  ],
  c: C_FAMILY,
  cpp: C_FAMILY,
  objc: C_FAMILY,
  ruby: [
    {
      tool: "rubocop",
      name: /^\.rubocop[^/]*\.ya?ml$/,
      example: ".rubocop.yml",
      format: "yaml",
      tightens: [
        on(/\.Enabled$/),
        raised(/\.Severity$/),
        lowered(/\.Max$/),
        removed(/\.Exclude$/),
        on(/^AllCops\.NewCops$/),
      ],
      severities: RUBOCOP_SEVERITIES,
    },
    {
      tool: "standard",
      name: /^\.standard\.ya?ml$/,
      example: ".standard.yml",
      format: "yaml",
      tightens: [removed(/^ignore$/)],
    },
  ],
  php: [
    {
      tool: "phpcs",
      name: /^\.?phpcs\.xml(?:\.dist)?$/,
      example: "phpcs.xml",
      format: "xml",
      tightens: [added(/(?:^|\/)rule$/), removed(/\/(?:exclude|exclude-pattern)$/)],
    },
    {
      tool: "phpstan",
      name: /^phpstan(?:\.dist)?\.neon(?:\.dist)?$/,
      example: "phpstan.neon",
      format: "yaml",
      tightens: [
        raised(/^parameters\.level$/),
        removed(/^parameters\.(?:ignoreErrors|excludePaths)$/),
        on(
          /^parameters\.(?:checkMissingIterableValueType|reportUnmatchedIgnoredErrors|treatPhpDocTypesAsCertain)$/,
        ),
      ],
      severities: [
        ["0"],
        ["1"],
        ["2"],
        ["3"],
        ["4"],
        ["5"],
        ["6"],
        ["7"],
        ["8"],
        ["9"],
        ["10", "max"],
      ],
    },
    {
      tool: "psalm",
      name: /^psalm\.xml(?:\.dist)?$/,
      example: "psalm.xml",
      format: "xml",
      tightens: [lowered(/(?:^|\/)psalm\.errorLevel$/)],
    },
    opaque("php-cs-fixer", /^\.php-cs-fixer(?:\.dist)?\.php$/, ".php-cs-fixer.php"),
  ],
  swift: [
    {
      tool: "swiftlint",
      name: /^\.swiftlint\.ya?ml$/,
      example: ".swiftlint.yml",
      format: "yaml",
      tightens: [
        added(/^(?:opt_in_rules|analyzer_rules)$/),
        removed(/^(?:disabled_rules|excluded)$/),
        lowered(/\.(?:warning|error)$/),
      ],
    },
    opaque("swiftformat", /^\.swiftformat$/, ".swiftformat"),
  ],
  lua: [
    opaque("luacheck", /^\.luacheckrc$/, ".luacheckrc"),
    opaque("stylua", /^\.?stylua\.toml$/, "stylua.toml"),
    {
      tool: "lua-language-server",
      name: /^\.luarc\.jsonc?$/,
      example: ".luarc.json",
      format: "json",
      tightens: [removed(/^diagnostics\.disable$/)],
    },
  ],
  elixir: [
    opaque("credo", /^\.credo\.exs$/, ".credo.exs"),
    opaque("mix format", /^\.formatter\.exs$/, ".formatter.exs"),
    opaque("dialyzer", /^\.dialyzer_ignore\.exs$/, ".dialyzer_ignore.exs"),
  ],
  dart: [
    {
      tool: "dart analyze",
      name: /^analysis_options\.ya?ml$/,
      example: "analysis_options.yaml",
      format: "yaml",
      tightens: [
        on(/^analyzer\.language\.strict-[\w-]+$/),
        added(/^linter\.rules$/),
        on(/^linter\.rules\.[\w-]+$/),
        raised(/^analyzer\.errors\.[\w-]+$/),
        removed(/^analyzer\.exclude$/),
      ],
      severities: [["ignore"], ["info"], ["warning"], ["error"]],
    },
  ],
  zig: none("Zig's compiler and `zig fmt` read no project config file"),
  bash: [
    {
      tool: "shellcheck",
      name: /^\.shellcheckrc$/,
      example: ".shellcheckrc",
      format: "ini",
      tightens: [added(/^enable$/), removed(/^disable$/), raised(/^severity$/)],
      // shellcheck's `severity` is the lowest level it reports, so `style` reports the most.
      severities: [["error"], ["warning"], ["info"], ["style"]],
    },
  ],
  ocaml: [opaque("ocamlformat", /^\.ocamlformat$/, ".ocamlformat")],
  solidity: [
    {
      tool: "solhint",
      name: /^\.solhint\.json$/,
      example: ".solhint.json",
      format: "json",
      tightens: ESLINT_TIGHTENS,
      severities: ESLINT_SEVERITIES,
    },
    opaque("solhint", /^\.solhintignore$/, ".solhintignore"),
  ],
  sql: [
    {
      tool: "sqlfluff",
      name: /^\.sqlfluff$/,
      example: ".sqlfluff",
      format: "ini",
      tightens: [removed(/^sqlfluff\.exclude_rules$/), added(/^sqlfluff\.rules$/)],
    },
    opaque("sqlfluff", /^\.sqlfluffignore$/, ".sqlfluffignore"),
  ],
  powershell: [
    opaque(
      "PSScriptAnalyzer",
      /^PSScriptAnalyzerSettings\.psd1$/i,
      "PSScriptAnalyzerSettings.psd1",
    ),
  ],
  r: [opaque("lintr", /^\.lintr$/, ".lintr")],
};

const CONFIGS: readonly CheckConfig[] = [
  ...new Set(SUPPORTED_LANGUAGES.flatMap((language) => rowOf(CHECK_CONFIGS, language) ?? [])),
];

const base = (path: string) => {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

/** The check-defining config a path is, if any. */
export function checkConfigOf(path: string): CheckConfig | undefined {
  const name = base(path);
  return CONFIGS.find((config) => config.name.test(name));
}

export const isCheckConfigPath = (path: string): boolean => checkConfigOf(path) !== undefined;

/** A check config that needed a person before #2221 (tsconfig, biome): enforced, never shadowed. */
export const isEnforcedCheckConfig = (path: string): boolean =>
  checkConfigOf(path)?.enforced === true;

/** JSON with comments and trailing commas, as tsconfig and biome allow. */
function jsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** An INI file as nested sections; a repeated key's values join with commas. */
function ini(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let section = root;
  let last: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    // An indented line continues the previous value (pylint's `disable =` lists).
    if (/^\s/.test(raw) && last !== null && !/[=:]/.test(line)) {
      section[last] = `${section[last] ?? ""},${line.replace(/\s+[#;].*$/, "")}`;
      continue;
    }
    const header = /^\[(.+)\]$/.exec(line)?.[1];
    if (header !== undefined) {
      section = {};
      root[header.trim()] = section;
      last = null;
      continue;
    }
    const pair = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!pair?.[1]) continue;
    const key = pair[1].trim();
    const value = (pair[2] ?? "").replace(/\s+[#;].*$/, "").trim();
    const earlier = section[key];
    section[key] = typeof earlier === "string" && earlier ? `${earlier},${value}` : value;
    last = key;
  }
  return root;
}

const XML_ID = /\b(?:name|ref|id|Id|class)\s*=\s*"([^"]*)"/;

/** An XML file as labelled fields: each element by its path, with its id attribute and text. */
function xmlFields(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const xml = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g, "");
  const stack: string[] = [];
  const tags = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>([^<]*)/g;
  for (const m of xml.matchAll(tags)) {
    const [, closing, tag = "", attrs = "", selfClosing, after = ""] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const id = XML_ID.exec(attrs)?.[1];
    const textValue = after.trim();
    const self = id !== undefined ? `${tag}[${id}]` : tag;
    const path = [...stack, self].join("/");
    const label = id === undefined && textValue && !selfClosing ? `${path}[${textValue}]` : path;
    out.set(label, "present");
    for (const a of attrs.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g))
      if (a[1] && !/^(?:name|ref|id|Id|class|xmlns(?::\w+)?)$/.test(a[1]))
        out.set(`${label}.${a[1]}`, a[2] ?? "");
    if (!selfClosing) stack.push(self);
  }
  return out;
}

function parse(format: Format, text: string): unknown {
  try {
    if (format === "json") return jsonc(text);
    if (format === "yaml") return Bun.YAML.parse(text);
    if (format === "toml") return Bun.TOML.parse(text);
    if (format === "ini") return ini(text);
  } catch {
    // A file the parser cannot read is compared as text: every change of it loosens.
  }
  return undefined;
}

/** ESLint-style rule values: `["error", {...}]` reads as its severity and its options. */
function ruleValue(value: unknown): unknown {
  if (!Array.isArray(value) || !value.length) return value;
  const [severity, ...options] = value;
  return options.length ? { severity, options: JSON.stringify(options) } : severity;
}

/**
 * The fields of a check config: one label per scalar setting (`compilerOptions.strict` = `true`),
 * one per list item (`lint.select[B]`), the whole text for a config that is code or that the
 * host cannot parse.
 */
export function checkConfigFields(path: string, text: string): Map<string, string> {
  const config = checkConfigOf(path);
  if (!config) return new Map();
  if (config.format === "xml") return xmlFields(text);
  if (config.format === "msbuild") return msbuildCheckFields(text);
  const parsed = config.format === "text" ? undefined : parse(config.format, text);
  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    const out = new Map<string, string>();
    if (text.trim()) out.set("content", text.trim());
    return out;
  }
  return walkFields(config, parsed);
}

/** The labelled fields of a parsed config (see `checkConfigFields`). */
function walkFields(config: CheckConfig, parsed: object): Map<string, string> {
  const out = new Map<string, string>();
  const listed = (label: string) =>
    config.tightens.some(
      (t) => (t.direction === "added" || t.direction === "removed") && t.field.test(label),
    );
  const walk = (value: unknown, label: string) => {
    const eslintRule = /^rules\.[^.]+$/.test(label) && config.severities === ESLINT_SEVERITIES;
    const v = eslintRule ? ruleValue(value) : value;
    if (Array.isArray(v)) {
      for (const item of v)
        out.set(`${label}[${typeof item === "string" ? item : JSON.stringify(item)}]`, "present");
      if (!v.length) out.set(`${label}[]`, "present");
    } else if (v !== null && typeof v === "object") {
      for (const [key, child] of Object.entries(v)) walk(child, label ? `${label}.${key}` : key);
    } else if (config.format === "ini" && typeof v === "string" && listed(label)) {
      for (const item of v.split(/[,\s]+/).filter(Boolean)) out.set(`${label}[${item}]`, "present");
    } else out.set(label, String(v));
  };
  walk(parsed, "");
  if (config.scope)
    for (const label of [...out.keys()]) if (!config.scope.test(label)) out.delete(label);
  return out;
}

const TRUE = new Set(["true", "yes", "on", "1", "enable", "enabled"]);
const FALSE = new Set(["false", "no", "off", "0", "disable", "disabled"]);
/** Generic last parts of a label that do not say which rule it is. */
const GENERIC = /^(?:level|severity|enabled|active|value|action|options)$/i;

/** The item and the field of a list item's label, or the label itself with no item. */
function splitItem(label: string): { field: string; item: string | null } {
  const m = /^(.*)\[([^\]]*)\]$/.exec(label);
  return m ? { field: m[1] ?? "", item: m[2] ?? "" } : { field: label, item: null };
}

/** The rule or setting a label names, which the request must name for a tightening. */
function subjectOf(label: string): string {
  const { field, item } = splitItem(label);
  if (item !== null && !/[[\]]/.test(field.slice(field.lastIndexOf("/") + 1))) return item;
  const parts = field.split(/[./]/).flatMap((part) => {
    const id = /\[([^\]]+)\]$/.exec(part)?.[1];
    return [id ?? part];
  });
  const last = parts.at(-1) ?? field;
  return GENERIC.test(last) ? (parts.at(-2) ?? last) : last;
}

/** The index of a severity in the config's order, -1 for a name it does not list. */
function rank(config: CheckConfig, value: string): number {
  const lower = value.toLowerCase();
  return (config.severities ?? []).findIndex((names) =>
    names.some((name) => name.toLowerCase() === lower),
  );
}

/** Whether one changed field moves in its tightening direction. */
function tightens(
  config: CheckConfig,
  label: string,
  before: string | undefined,
  after: string | undefined,
): boolean {
  const { field, item } = splitItem(label);
  const rule = config.tightens.find((t) => t.field.test(item === null ? label : field));
  if (!rule) return false;
  switch (rule.direction) {
    case "on":
      return after !== undefined && TRUE.has(after.toLowerCase());
    case "off":
      return after !== undefined && FALSE.has(after.toLowerCase());
    case "added":
      return item !== null && before === undefined && after !== undefined;
    case "removed":
      return item !== null && before !== undefined && after === undefined;
    case "raised": {
      // A severity set where none was replaces a default the host does not know: only the
      // highest one is sure to tighten.
      if (after === undefined) return false;
      const now = rank(config, after);
      if (now < 0) return false;
      if (before === undefined)
        return config.unset !== undefined
          ? now > rank(config, config.unset)
          : now === (config.severities?.length ?? 0) - 1;
      const old = rank(config, before);
      return old >= 0 && now > old;
    }
    case "lowered": {
      const old = Number(before);
      const now = Number(after);
      return (
        before !== undefined &&
        after !== undefined &&
        Number.isFinite(old) &&
        Number.isFinite(now) &&
        now < old
      );
    }
  }
}

/** Whether a request names the rule or setting `subject` (`noUncheckedIndexedAccess`, `Style/Foo`). */
function namesSubject(request: string, subject: string): boolean {
  const lower = request.toLowerCase();
  return [subject, subject.slice(subject.lastIndexOf("/") + 1)].some(
    (name) =>
      name.length > 0 &&
      new RegExp(
        `(?:^|[^\\w-])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
      ).test(lower),
  );
}

/**
 * The fields of a check config that a change from `before` to `after` moves other than into a
 * tightening the request names (#2221): a flag turned off, a rule disabled or ignored, a threshold
 * raised, an `extends`, `include`, `exclude` or `paths` edit, any change of a config the host reads
 * as text, and a tightening of a rule the request does not name. A field that only a newly added
 * tightening holds (the properties of an added checkstyle module) goes with it. Empty when the
 * change only tightens what the request names.
 */
export function checkConfigLoosening(
  path: string,
  before: string,
  after: string,
  request: string,
): string[] {
  const config = checkConfigOf(path);
  if (!config) return [];
  return loosening(
    config,
    checkConfigFields(path, before),
    checkConfigFields(path, after),
    request,
  );
}

function loosening(
  config: CheckConfig,
  old: Map<string, string>,
  now: Map<string, string>,
  request: string,
): string[] {
  const changed = [...new Set([...old.keys(), ...now.keys()])].filter(
    (key) => old.get(key) !== now.get(key),
  );
  const accepted = new Set(
    changed.filter(
      (label) =>
        tightens(config, label, old.get(label), now.get(label)) &&
        namesSubject(request, subjectOf(label)),
    ),
  );
  const addedWith = (label: string) =>
    [...accepted].some(
      (parent) =>
        !old.has(parent) &&
        label !== parent &&
        (label.startsWith(`${parent}/`) || label.startsWith(`${parent}.`)),
    );
  return changed.filter((label) => !accepted.has(label) && !addedWith(label));
}

/** Properties that decide what the C# compiler and its analyzers enforce. */
const MSBUILD_CHECK_PROPERTY =
  /<(TreatWarningsAsErrors|WarningsAsErrors|WarningsNotAsErrors|NoWarn|WarningLevel|Nullable|AnalysisLevel|AnalysisMode|EnableNETAnalyzers|EnforceCodeStyleInBuild|CodeAnalysisRuleSet|RunAnalyzers|RunAnalyzersDuringBuild)(?:\s[^>]*)?>([^<]*)<\/\1\s*>/g;

/** The check properties of an MSBuild project; warning lists by item. */
function msbuildCheckFields(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of xml.matchAll(MSBUILD_CHECK_PROPERTY)) {
    const [, name = "", value = ""] = m;
    if (/^(?:WarningsAsErrors|WarningsNotAsErrors|NoWarn)$/.test(name))
      for (const item of value.split(/[;,\s]+/).filter((i) => i && !i.startsWith("$(")))
        out.set(`${name}[${item}]`, "present");
    else out.set(name, value.trim());
  }
  return out;
}

const MSBUILD_CHECKS: CheckConfig = {
  tool: "MSBuild analyzers",
  name: /(?!)/,
  example: "Directory.Build.props",
  format: "msbuild",
  tightens: [
    on(
      /^(?:TreatWarningsAsErrors|EnforceCodeStyleInBuild|EnableNETAnalyzers|RunAnalyzers|RunAnalyzersDuringBuild)$/,
    ),
    added(/^WarningsAsErrors$/),
    removed(/^(?:NoWarn|WarningsNotAsErrors)$/),
    raised(/^(?:Nullable|AnalysisMode)$/),
  ],
  severities: [
    ["disable", "none"],
    ["annotations", "warnings", "default"],
    ["minimum"],
    ["recommended"],
    ["enable", "all"],
  ],
};

const RUST_LINTS: CheckConfig = {
  tool: "cargo lints",
  name: /(?!)/,
  example: "Cargo.toml",
  format: "toml",
  tightens: [raised(/^[\w-]+\.[\w-]+(?:\.level)?$/)],
  severities: [["allow"], ["warn"], ["deny"], ["forbid"]],
  // No clippy lint is on by default above `warn`; a rustc lint that is `deny` by default stays
  // where it was when the edit sets `warn`, which is not counted as raised.
  unset: "warn",
};

const python = (tool: string): CheckConfig => {
  const found = (rowOf(CHECK_CONFIGS, "python") ?? []).find((config) => config.tool === tool);
  if (!found) throw new Error(`no python check config ${tool}`);
  return found;
};
const ESLINT_JSON = JS.find((config) => config.tool === "eslint" && config.format === "json");

/** A manifest that also holds a check's settings: where they sit, and which config reads them. */
interface Embedded {
  manifest: RegExp;
  format: Format;
  sections: readonly { at: readonly string[]; scope?: RegExp; config: CheckConfig }[];
}

/**
 * The check settings a manifest holds (#2221): `pyproject.toml` `[tool.ruff]`, `[tool.mypy]`,
 * `[tool.pyright]` and `[tool.pylint]`, `setup.cfg` `[mypy]` and `[flake8]`, `package.json`
 * `eslintConfig`, `Cargo.toml` `[lints]` and `[workspace.lints]`, and the analyzer properties of
 * an MSBuild project. A request-named edit of the manifest (`requestedManifestEdits`) may tighten
 * what the request names there; the manifest field check holds every other change of them.
 */
const EMBEDDED: readonly Embedded[] = [
  {
    manifest: /^pyproject\.toml$/,
    format: "toml",
    sections: [
      { at: ["tool", "ruff"], config: python("ruff") },
      { at: ["tool", "mypy"], config: python("mypy") },
      { at: ["tool", "pyright"], config: python("pyright") },
      { at: ["tool", "basedpyright"], config: python("pyright") },
      { at: ["tool", "pylint"], config: python("pylint") },
    ],
  },
  {
    manifest: /^setup\.cfg$/,
    format: "ini",
    sections: [
      { at: [], scope: /^flake8\./, config: python("flake8") },
      { at: [], scope: /^mypy[-.]/, config: python("mypy") },
    ],
  },
  ...(ESLINT_JSON
    ? [
        {
          manifest: /^package\.json$/,
          format: "json" as const,
          sections: [{ at: ["eslintConfig"], config: ESLINT_JSON }],
        },
      ]
    : []),
  {
    manifest: /^Cargo\.toml$/,
    format: "toml",
    sections: [
      { at: ["lints"], config: RUST_LINTS },
      { at: ["workspace", "lints"], config: RUST_LINTS },
    ],
  },
  {
    manifest: /\.(?:csproj|fsproj|vbproj)$|^Directory\.Build\.props$/,
    format: "msbuild",
    sections: [{ at: [], config: MSBUILD_CHECKS }],
  },
];

function sectionFields(format: Format, text: string, section: Embedded["sections"][number]) {
  if (format === "msbuild") return msbuildCheckFields(text);
  let value: unknown = parse(format, text);
  for (const key of section.at)
    value =
      value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  if (!value || typeof value !== "object") return new Map<string, string>();
  const fields = walkFields(section.config, value);
  if (section.scope)
    for (const label of [...fields.keys()]) if (!section.scope.test(label)) fields.delete(label);
  return fields;
}

/**
 * The check settings of a manifest that a change moves other than into a tightening the request
 * names, labelled with their section (`tool.ruff.lint.ignore[E501]`). Empty for a manifest that
 * holds none, or a change that only tightens what the request names.
 */
export function embeddedCheckLoosening(
  path: string,
  before: string,
  after: string,
  request: string,
): string[] {
  const name = base(path);
  const embedded = EMBEDDED.find((e) => e.manifest.test(name));
  if (!embedded) return [];
  return embedded.sections.flatMap((section) => {
    const prefix = section.at.length ? `${section.at.join(".")}.` : "";
    return loosening(
      section.config,
      sectionFields(embedded.format, before, section),
      sectionFields(embedded.format, after, section),
      request,
    ).map((label) => `${prefix}${label}`);
  });
}
