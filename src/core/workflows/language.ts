import { readdirSync } from "node:fs";

/** Review profile that runs as the `language` review dimension for the languages below. */
export const LANGUAGE_REVIEW_PROFILE = "language-reviewer";

export type ProjectLanguage = "go" | "dotnet" | "rust" | "java";

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
  return out;
}

/**
 * The language review profile a run gets when its policy names none and the workspace is a Go,
 * .NET, Rust or Java project: these are the languages where a general reviewer misses platform
 * pitfalls (newline, path separator, culture, error handling idioms).
 */
export function languageReviewProfile(workspace: string): string | null {
  return detectLanguages(workspace).length > 0 ? LANGUAGE_REVIEW_PROFILE : null;
}
