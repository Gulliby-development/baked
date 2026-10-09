import { existsSync } from "node:fs";
import { join } from "node:path";

const TOOLCHAIN_MARKERS: [string, string][] = [
  // JS/TS runtimes & package managers
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["deno.lock", "deno"],
  ["deno.json", "deno"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  // Rust
  ["Cargo.lock", "cargo (rust)"],
  // Go
  ["go.sum", "go"],
  // Python
  ["uv.lock", "uv (python)"],
  ["poetry.lock", "poetry (python)"],
  ["Pipfile.lock", "pipenv (python)"],
  ["requirements.txt", "pip (python)"],
  // Ruby
  ["Gemfile.lock", "bundler (ruby)"],
  // PHP
  ["composer.lock", "composer (php)"],
  // Java/Kotlin/JVM
  ["gradlew", "gradle (jvm)"],
  ["mvnw", "maven (jvm)"],
  ["pom.xml", "maven (jvm)"],
  ["build.gradle", "gradle (jvm)"],
  ["build.gradle.kts", "gradle (jvm)"],
  // .NET / C#
  ["global.json", "dotnet"],
  // Elixir
  ["mix.lock", "mix (elixir)"],
  // Swift
  ["Package.resolved", "swift package manager"],
  // C/C++
  ["CMakeLists.txt", "cmake (c/c++)"],
  ["Makefile", "make"],
  ["meson.build", "meson (c/c++)"],
  ["conanfile.txt", "conan (c/c++)"],
  ["vcpkg.json", "vcpkg (c/c++)"],
  // Zig
  ["build.zig.zon", "zig"],
  // Dart/Flutter
  ["pubspec.lock", "dart/flutter"],
  // Haskell
  ["stack.yaml", "stack (haskell)"],
  ["cabal.project", "cabal (haskell)"],
  // Scala
  ["build.sbt", "sbt (scala)"],
  // Clojure
  ["deps.edn", "clojure"],
  ["project.clj", "leiningen (clojure)"],
];

export function detectToolchain(cwd: string): string | null {
  for (const [file, tool] of TOOLCHAIN_MARKERS) {
    if (existsSync(join(cwd, file))) return tool;
  }
  return null;
}
