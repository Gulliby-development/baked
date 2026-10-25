import { readdirSync } from "node:fs";

/** Review profile that runs as the `language` review dimension for the languages below. */
export const LANGUAGE_REVIEW_PROFILE = "language-reviewer";

export type ProjectLanguage = "go" | "dotnet" | "rust" | "java" | "ruby" | "dart" | "scala";

const DOTNET_FILE = /\.(slnx?|csproj|fsproj|vbproj)$/i;

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

/** Languages whose manifests sit at the workspace root, in a fixed order. */
export function detectLanguages(workspace: string): ProjectLanguage[] {
  const names = new Set(rootNames(workspace));
  const out: ProjectLanguage[] = [];
  if (names.has("go.mod")) out.push("go");
  if (dotnetFiles(workspace).length > 0) out.push("dotnet");
  if (names.has("Cargo.toml")) out.push("rust");
  if (names.has("pom.xml")) out.push("java");
  if (names.has("Gemfile") || [...names].some((name) => name.endsWith(".gemspec")))
    out.push("ruby");
  if (names.has("pubspec.yaml")) out.push("dart");
  if (names.has("build.sbt")) out.push("scala");
  return out;
}

/**
 * The language review profile a run gets when its policy names none and the workspace is a Go,
 * .NET, Rust, Java, Ruby, Dart or Scala project: these are the languages where a general reviewer misses platform
 * pitfalls (newline, path separator, culture, error handling idioms).
 */
export function languageReviewProfile(workspace: string): string | null {
  return detectLanguages(workspace).length > 0 ? LANGUAGE_REVIEW_PROFILE : null;
}

/** Source and build files of the languages above, by extension or file name. */
const LANGUAGE_FILE =
  /(\.(go|cs|fs|vb|csproj|fsproj|vbproj|slnx?|props|targets|rs|java|kt|kts|rb|rake|gemspec|dart|scala|sc|sbt)$|(^|\/)(go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|Gemfile|Gemfile\.lock|Rakefile|pubspec\.yaml|pubspec\.lock|analysis_options\.yaml|\.scalafmt\.conf)$)/i;

/**
 * Whether a change touches a file of a Go, .NET, Rust, Java, Ruby, Dart or Scala project. The language review only
 * adds value there: in R08 it ran on changes to READMEs and scripts of such projects and found
 * nothing in four reviews at about 45k tokens each (#592).
 */
export function touchesLanguageFiles(paths: readonly string[]): boolean {
  return paths.some((path) => LANGUAGE_FILE.test(path.replaceAll("\\", "/")));
}
