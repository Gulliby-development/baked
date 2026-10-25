import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Review profile that runs as the `language` review dimension for the languages below. */
export const LANGUAGE_REVIEW_PROFILE = "language-reviewer";

export type ProjectLanguage =
  | "go"
  | "dotnet"
  | "rust"
  | "java"
  | "kotlin"
  | "ruby"
  | "dart"
  | "php"
  | "sql"
  | "powershell"
  | "lua"
  | "cpp"
  | "scala"
  | "swift"
  | "r";

/** Gradle build scripts at the workspace root: a Java or Kotlin build (#1489). */
const GRADLE_BUILDS = [
  "build.gradle.kts",
  "build.gradle",
  "settings.gradle.kts",
  "settings.gradle",
];

const DOTNET_FILE = /\.(slnx?|csproj|fsproj|vbproj)$/i;

function readText(workspace: string, name: string): string {
  try {
    return readFileSync(join(workspace, name), "utf8");
  } catch {
    return "";
  }
}

function rootNames(workspace: string): string[] {
  try {
    return readdirSync(workspace);
  } catch {
    return [];
  }
}

/** The .NET solution and project files at the workspace root, solutions first. */
export function dotnetFiles(workspace: string): string[] {
  const rank = (name: string): number => (/\.slnx$/i.test(name) ? 0 : /\.sln$/i.test(name) ? 1 : 2);
  return rootNames(workspace)
    .filter((name) => DOTNET_FILE.test(name))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
}

/** A LuaRocks rockspec, or the config of busted, luacheck, selene or StyLua (#1495). */
const LUA_MANIFEST = /^(?:.+\.rockspec|\.busted|\.luacheckrc|selene\.toml|\.?stylua\.toml)$/;

/** A C or C++ project's build or package manifest: CMake, Meson, vcpkg or Conan (#1490). */
const C_MANIFEST = /^(?:CMakeLists\.txt|meson\.build|vcpkg\.json|conanfile\.(?:txt|py))$/;

/** Languages whose manifests sit at the workspace root, in a fixed order. */
export function detectLanguages(workspace: string): ProjectLanguage[] {
  const names = new Set(rootNames(workspace));
  const out: ProjectLanguage[] = [];
  if (names.has("go.mod")) out.push("go");
  if (dotnetFiles(workspace).length > 0) out.push("dotnet");
  if (names.has("Cargo.toml")) out.push("rust");
  const gradle = GRADLE_BUILDS.filter((name) => names.has(name));
  // A Gradle build without a Kotlin build script or plugin is Java; a Kotlin one is Kotlin, which
  // also covers its Java sources (#1489).
  const kotlin =
    names.has("build.gradle.kts") ||
    gradle.some((name) => /\bkotlin\s*\(|org\.jetbrains\.kotlin/.test(readText(workspace, name)));
  if (names.has("pom.xml") || (gradle.length > 0 && !kotlin)) out.push("java");
  if (kotlin) out.push("kotlin");
  if (names.has("Gemfile") || [...names].some((name) => name.endsWith(".gemspec")))
    out.push("ruby");
  if (names.has("pubspec.yaml")) out.push("dart");
  if (names.has("composer.json")) out.push("php");
  if ([...names].some((name) => LUA_MANIFEST.test(name))) out.push("lua");
  if ([...names].some((name) => C_MANIFEST.test(name))) out.push("cpp");
  // A dbt project or a SQLFluff-configured one: its SQL is the project's code (#1499).
  if (names.has("dbt_project.yml") || names.has(".sqlfluff")) out.push("sql");
  // A module manifest or PSScriptAnalyzer settings: a PowerShell module or project (#1498).
  if ([...names].some((name) => /\.psd1$/i.test(name))) out.push("powershell");
  if (names.has("build.sbt")) out.push("scala");
  if (names.has("Package.swift")) out.push("swift");
  // An R package, or an renv project (#1500).
  if (names.has("DESCRIPTION") || names.has("renv.lock")) out.push("r");
  return out;
}

/**
 * The language review profile a run gets when its policy names none and the workspace is a Go,
 * .NET, Rust, Java, Kotlin (Maven or Gradle), Ruby, Dart, PHP, SQL, PowerShell, Lua, C, C++, Scala
 * or Swift project: these are the languages where a general reviewer misses platform pitfalls
 * (newline, path separator, culture, error handling idioms, PHP's loose comparisons, Lua's one-based
 * indexing, C's undefined behavior; for SQL, dialect, migrations that cannot be reversed and locks;
 * for PowerShell, pipeline unrolling, non-terminating errors and the differences of Windows
 * PowerShell 5.1; for R, vector recycling, NA handling and 1:length()
 * on empty input).
 */
export function languageReviewProfile(workspace: string): string | null {
  return detectLanguages(workspace).length > 0 ? LANGUAGE_REVIEW_PROFILE : null;
}

/** Source and build files of the languages above, by extension or file name. */
const LANGUAGE_FILE =
  /(\.(go|cs|fs|vb|csproj|fsproj|vbproj|slnx?|props|targets|rs|java|kt|kts|rb|rake|gemspec|dart|php|sql|ps1|psm1|psd1|lua|luau|rockspec|c|h|cc|cpp|cxx|hh|hpp|hxx|scala|sc|sbt|swift|r)$|(^|\/)(go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|settings\.gradle|gradle\.properties|libs\.versions\.toml|Gemfile|Gemfile\.lock|Rakefile|pubspec\.yaml|pubspec\.lock|analysis_options\.yaml|composer\.json|composer\.lock|dbt_project\.yml|\.busted|\.luacheckrc|selene\.toml|\.?stylua\.toml|CMakeLists\.txt|meson\.build|vcpkg\.json|conanfile\.(?:txt|py)|\.scalafmt\.conf|Package\.resolved|\.swift-format|DESCRIPTION|renv\.lock)$)/i;

/**
 * Whether a change touches a file of a Go, .NET, Rust, Java, Kotlin, Ruby, Dart, PHP, SQL, PowerShell, Lua, C, C++, Scala, Swift or R project. The language review only
 * adds value there: in R08 it ran on changes to READMEs and scripts of such projects and found
 * nothing in four reviews at about 45k tokens each (#592).
 */
export function touchesLanguageFiles(paths: readonly string[]): boolean {
  return paths.some((path) => LANGUAGE_FILE.test(path.replaceAll("\\", "/")));
}
