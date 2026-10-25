import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProfile } from "../src/core/tools/project.js";

/**
 * Tests for detectProfile — the production function, not a mirror.
 * Uses real temp directories with marker files that simulate real project structures.
 * Wrong detection = wrong test/build/lint/format commands = user confusion.
 */

let baseDir: string;

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), "baked-detect-"));
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function makeProject(name: string, files: Record<string, string>): string {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return dir;
}

// ── JS/TS: Bun ──────────────────────────────────────────────

describe("Bun project (bun.lock)", () => {
  it("detects bun with biome formatter", async () => {
    const cwd = makeProject("bun-biome", {
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: { test: "bun test", lint: "biome check ." } }),
      "biome.json": "{}",
      "tsconfig.json": "{}",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("bun test");
    expect(p.lint).toBe("bun run lint");
    expect(p.typecheck).toBe("bunx tsc --noEmit");
    expect(p.format).toBe("bunx biome format --write");
  });

  it("prefers scripts.format over auto-detect", async () => {
    const cwd = makeProject("bun-format-script", {
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: { format: "biome format ." } }),
      "biome.json": "{}",
    });
    const p = await detectProfile(cwd);
    expect(p.format).toBe("bun run format");
    // A format script usually names directories, so per-file formatting must not append to it.
    expect(p.formatFile).toBe("bunx biome format --write");
  });

  it("has no per-file formatter when only a format script exists", async () => {
    const cwd = makeProject("bun-format-script-only", {
      "bun.lock": "",
      "package.json": JSON.stringify({ scripts: { format: "some-tool --write src/" } }),
    });
    const p = await detectProfile(cwd);
    expect(p.format).toBe("bun run format");
    expect(p.formatFile).toBeNull();
  });

  it("detects prettier when no biome", async () => {
    const cwd = makeProject("bun-prettier", {
      "bun.lock": "",
      "package.json": JSON.stringify({}),
      ".prettierrc": "{}",
    });
    const p = await detectProfile(cwd);
    expect(p.format).toContain("prettier");
  });

  it("no formatter when nothing configured", async () => {
    const cwd = makeProject("bun-no-format", {
      "bun.lock": "",
      "package.json": JSON.stringify({}),
    });
    const p = await detectProfile(cwd);
    expect(p.format).toBeNull();
  });
});

// ── JS/TS: npm/pnpm/yarn ────────────────────────────────────

describe("npm project (package.json only)", () => {
  it("detects npm with eslint and prettier", async () => {
    const cwd = makeProject("npm-prettier", {
      "package.json": JSON.stringify({
        scripts: { test: "jest", lint: "eslint .", build: "tsc" },
      }),
      ".prettierrc.json": "{}",
      "tsconfig.json": "{}",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("npm run test");
    expect(p.build).toBe("npm run build");
    expect(p.lint).toBe("npm run lint");
    expect(p.typecheck).toBe("npx tsc --noEmit");
    expect(p.format).toContain("prettier");
  });
});

describe("pnpm project", () => {
  it("detects pnpm with dprint", async () => {
    const cwd = makeProject("pnpm-dprint", {
      "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
      "pnpm-lock.yaml": "",
      "dprint.json": "{}",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("pnpm test");
    expect(p.format).toContain("dprint");
  });
});

describe("yarn project", () => {
  it("detects yarn with biome", async () => {
    const cwd = makeProject("yarn-biome", {
      "package.json": JSON.stringify({ scripts: { test: "jest", build: "tsc" } }),
      "yarn.lock": "",
      "biome.jsonc": "{}",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("yarn test");
    expect(p.build).toBe("yarn build");
    expect(p.format).toContain("biome");
  });
});

// ── JS/TS: Deno ─────────────────────────────────────────────

describe("Deno project", () => {
  it("detects deno with built-in formatter", async () => {
    const cwd = makeProject("deno", {
      "deno.json": JSON.stringify({ tasks: { dev: "deno run --watch main.ts" } }),
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("deno test");
    expect(p.lint).toBe("deno lint");
    expect(p.typecheck).toBe("deno check .");
    expect(p.format).toBe("deno fmt");
  });
});

// ── Rust ────────────────────────────────────────────────────

describe("Rust project (Cargo.toml)", () => {
  it("detects cargo toolchain", async () => {
    const cwd = makeProject("rust", {
      "Cargo.toml": '[package]\nname = "myapp"\nversion = "0.1.0"',
      "src/main.rs": "fn main() {}",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("cargo test");
    expect(p.build).toBe("cargo build");
    expect(p.lint).toBe("cargo clippy");
    expect(p.typecheck).toBe("cargo check");
    // The whole crate with its edition; one file goes through rustfmt with the edition (#1681).
    expect(p.format).toBe("cargo fmt");
    expect(p.formatFile).toBe("rustfmt");
  });
});

// ── Go ──────────────────────────────────────────────────────

describe("Go project (go.mod)", () => {
  it("detects go with golangci-lint", async () => {
    const cwd = makeProject("go-lint", {
      "go.mod": "module example.com/myapp\n\ngo 1.21",
      ".golangci.yml": "linters:\n  enable:\n    - gofmt",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("go test ./...");
    expect(p.lint).toBe("golangci-lint run");
    expect(p.format).toBe("gofmt -w");
    expect(p.formatFile).toBe("gofmt -w");
  });

  it("falls back to go vet without golangci config", async () => {
    const cwd = makeProject("go-noconfig", {
      "go.mod": "module example.com/myapp\n\ngo 1.21",
    });
    const p = await detectProfile(cwd);
    expect(p.lint).toBe("go vet ./...");
    expect(p.format).toBe("gofmt -w");
  });
});

// ── Python ──────────────────────────────────────────────────

describe("Python project (pyproject.toml)", () => {
  it("detects uv with ruff", async () => {
    const cwd = makeProject("py-uv-ruff", {
      "pyproject.toml": "[project]\nname = 'myapp'",
      "uv.lock": "",
      "ruff.toml": "[lint]\nselect = ['E', 'F']",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("uv run pytest");
    expect(p.lint).toBe("uv run ruff check");
    expect(p.format).toBe("uv run ruff format");
  });

  it("detects poetry with black fallback", async () => {
    const cwd = makeProject("py-poetry-black", {
      "pyproject.toml": "[tool.poetry]\nname = 'myapp'",
      "poetry.lock": "",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("poetry run pytest");
    expect(p.format).toBe("poetry run black");
  });

  it("detects plain python with Django", async () => {
    const cwd = makeProject("py-django", {
      "requirements.txt": "django>=4.0\nblack",
      "manage.py": "#!/usr/bin/env python",
    });
    const p = await detectProfile(cwd);
    expect(p.run).toContain("manage.py");
    expect(p.format).toBe("black");
  });
});

// ── PHP ─────────────────────────────────────────────────────

describe("PHP project (composer.json)", () => {
  it("detects Laravel with Pint", async () => {
    const cwd = makeProject("php-laravel", {
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^10" } }),
      "artisan": "",
      "pint.json": "{}",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("vendor/bin/phpunit");
    expect(p.lint).toContain("pint");
    expect(p.format).toBe("vendor/bin/pint");
    expect(p.run).toContain("artisan");
  });

  it("detects PHP with php-cs-fixer", async () => {
    const cwd = makeProject("php-fixer", {
      "composer.json": JSON.stringify({}),
      ".php-cs-fixer.php": "<?php return [];",
    });
    const p = await detectProfile(cwd);
    expect(p.format).toBe("vendor/bin/php-cs-fixer fix");
  });
});

// ── Flutter/Dart ────────────────────────────────────────────

describe("Flutter project (pubspec.yaml)", () => {
  it("detects flutter/dart toolchain", async () => {
    const cwd = makeProject("flutter", {
      "pubspec.yaml": "name: myapp\ndescription: A Flutter app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("flutter test");
    expect(p.lint).toBe("dart analyze");
    expect(p.format).toBe("dart format");
  });

  // A Dart package without the Flutter SDK has no `flutter` command (#1494).
  it("detects a plain Dart package", async () => {
    const cwd = makeProject("dart", { "pubspec.yaml": "name: calc\ndev_dependencies:\n  test: ^1.25.0\n" });
    const p = await detectProfile(cwd);
    expect([p.test, p.build, p.run]).toEqual(["dart test", null, "dart run"]);
  });
});

// ── Elixir ──────────────────────────────────────────────────

describe("Elixir project (mix.exs)", () => {
  it("detects mix toolchain", async () => {
    const cwd = makeProject("elixir", {
      "mix.exs": 'defmodule MyApp.MixProject do\n  use Mix.Project\nend',
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("mix test");
    expect(p.lint).toBe("mix credo");
    expect(p.format).toBe("mix format");
  });
});

// ── Ruby ────────────────────────────────────────────────────

describe("Ruby project (Gemfile)", () => {
  it("detects Rails with rspec", async () => {
    const cwd = makeProject("ruby-rails", {
      "Gemfile": "source 'https://rubygems.org'\ngem 'rails'",
      "config.ru": "require_relative 'config/environment'",
      "spec/.keep": "",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("bundle exec rspec");
    expect(p.lint).toBe("bundle exec rubocop");
    expect(p.format).toContain("rubocop");
    expect(p.run).toContain("rails server");
  });
});

// ── Swift ───────────────────────────────────────────────────

describe("Swift project (Package.swift)", () => {
  it("detects swift with swiftformat", async () => {
    const cwd = makeProject("swift", {
      "Package.swift": "// swift-tools-version:5.9\nimport PackageDescription",
      ".swiftformat": "",
      ".swiftlint.yml": "",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("swift test");
    expect(p.build).toBe("swift build");
    expect(p.lint).toBe("swiftlint");
    expect(p.format).toBe("swiftformat");
  });

  it("no formatter without .swiftformat config", async () => {
    const cwd = makeProject("swift-noformat", {
      "Package.swift": "// swift-tools-version:5.9",
    });
    const p = await detectProfile(cwd);
    expect(p.format).toBeNull();
  });
});

// ── Java/Kotlin: Gradle ─────────────────────────────────────

describe("Gradle project", () => {
  it("detects gradle with spotless", async () => {
    const cwd = makeProject("gradle-spotless", {
      "gradlew": "#!/bin/sh",
      "build.gradle.kts": 'plugins {\n  id("com.diffplug.spotless")\n}',
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("./gradlew test");
    expect(p.lint).toBe("./gradlew spotlessCheck");
    expect(p.format).toBeNull(); // spotless doesn't support single-file
  });

  it("detects gradle with ktlint", async () => {
    const cwd = makeProject("gradle-ktlint", {
      "gradlew": "#!/bin/sh",
      "build.gradle.kts": 'plugins {\n  id("org.jlleitschuh.gradle.ktlint")\n}',
    });
    const p = await detectProfile(cwd);
    expect(p.lint).toBe("./gradlew ktlintCheck");
  });

  it("falls back to gradle check without linter plugin", async () => {
    const cwd = makeProject("gradle-plain", {
      "build.gradle": "apply plugin: 'java'",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("gradle test");
    expect(p.lint).toBe("gradle check");
  });
});

// ── Java: Maven ─────────────────────────────────────────────

describe("Maven project (pom.xml)", () => {
  it("detects maven with wrapper", async () => {
    const cwd = makeProject("maven", {
      "mvnw": "#!/bin/sh",
      "pom.xml": "<project></project>",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("./mvnw test");
    expect(p.build).toBe("./mvnw package");
  });
});

// ── C/C++ ───────────────────────────────────────────────────

describe("CMake project", () => {
  it("detects cmake with clang-tidy", async () => {
    const cwd = makeProject("cmake", {
      "CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)",
      ".clang-tidy": "Checks: '-*,clang-analyzer-*'",
    });
    const p = await detectProfile(cwd);
    expect(p.build).toBe("cmake --build build");
    expect(p.lint).toBe("clang-tidy");
  });
});

describe("Makefile project", () => {
  it("detects make", async () => {
    const cwd = makeProject("make", {
      "Makefile": "all:\n\tgcc main.c",
    });
    const p = await detectProfile(cwd);
    expect(p.build).toBe("make");
    expect(p.test).toBe("make test");
  });
});

// ── Zig ─────────────────────────────────────────────────────

describe("Zig project", () => {
  it("detects zig toolchain", async () => {
    const cwd = makeProject("zig", {
      "build.zig": "const std = @import(\"std\");",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("zig build test");
    expect(p.build).toBe("zig build");
    expect(p.format).toBe("zig fmt");
  });
});

// ── .NET ────────────────────────────────────────────────────

describe(".NET project", () => {
  it("detects dotnet with csproj", async () => {
    const cwd = makeProject("dotnet", {
      "MyApp.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\" />",
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("dotnet test");
    expect(p.build).toBe("dotnet build");
    expect(p.run).toBe("dotnet run");
  });
});

// ── Monorepo (Turbo/pnpm/yarn) ──────────────────────────────

describe("pnpm monorepo (turbo)", () => {
  it("detects typecheck from scripts even without tsconfig.json in root", async () => {
    const cwd = makeProject("pnpm-turbo-root", {
      "package.json": JSON.stringify({
        scripts: { build: "turbo build", lint: "turbo lint", typecheck: "turbo typecheck", dev: "turbo dev" },
      }),
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'",
      "turbo.json": "{}",
    });
    const p = await detectProfile(cwd);
    expect(p.typecheck).toBe("pnpm typecheck");
    expect(p.build).toBe("pnpm build");
    expect(p.lint).toBe("pnpm lint");
    expect(p.run).toBe("pnpm dev");
  });

  it("sub-package detects pnpm from root lockfile", async () => {
    const root = makeProject("pnpm-turbo-sub", {
      "package.json": JSON.stringify({ scripts: { dev: "turbo dev" } }),
      "pnpm-lock.yaml": "",
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'",
      "apps/web/package.json": JSON.stringify({
        scripts: { build: "next build", dev: "next dev", lint: "eslint", typecheck: "tsc --noEmit" },
      }),
      "apps/web/tsconfig.json": "{}",
    });
    const p = await detectProfile(join(root, "apps/web"));
    expect(p.build).toBe("pnpm build");
    expect(p.lint).toBe("pnpm lint");
    expect(p.typecheck).toBe("pnpm typecheck");
    expect(p.run).toBe("pnpm dev");
  });

  it("sub-package without scripts falls back to pnpm tsc", async () => {
    const root = makeProject("pnpm-turbo-sub-noscript", {
      "pnpm-lock.yaml": "",
      "apps/api/package.json": JSON.stringify({ scripts: { dev: "wrangler dev" } }),
      "apps/api/tsconfig.json": "{}",
    });
    const p = await detectProfile(join(root, "apps/api"));
    expect(p.typecheck).toBe("npx tsc --noEmit");
    expect(p.run).toBe("pnpm dev");
  });
});

describe("yarn monorepo", () => {
  it("sub-package detects yarn from root lockfile", async () => {
    const root = makeProject("yarn-mono-sub", {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "yarn.lock": "",
      "packages/ui/package.json": JSON.stringify({
        scripts: { build: "tsc", test: "jest", lint: "eslint ." },
      }),
      "packages/ui/tsconfig.json": "{}",
    });
    const p = await detectProfile(join(root, "packages/ui"));
    expect(p.test).toBe("yarn test");
    expect(p.build).toBe("yarn build");
    expect(p.lint).toBe("yarn lint");
  });

  it("sub-package without lockfile does not fall back to npm", async () => {
    const root = makeProject("yarn-mono-no-npm", {
      "yarn.lock": "",
      "packages/core/package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    });
    const p = await detectProfile(join(root, "packages/core"));
    expect(p.build).toBe("yarn build");
  });
});

describe("bun monorepo", () => {
  it("detects typecheck from scripts without tsconfig.json", async () => {
    const cwd = makeProject("bun-turbo-root", {
      "bun.lock": "",
      "package.json": JSON.stringify({
        scripts: { typecheck: "turbo typecheck", build: "turbo build" },
      }),
    });
    const p = await detectProfile(cwd);
    expect(p.typecheck).toBe("bun run typecheck");
    expect(p.build).toBe("bun run build");
  });
});

// ── Edge Cases ──────────────────────────────────────────────

describe("edge cases", () => {
  it("returns all nulls for empty directory", async () => {
    const cwd = makeProject("empty", {});
    const p = await detectProfile(cwd);
    expect(p.test).toBeNull();
    expect(p.build).toBeNull();
    expect(p.lint).toBeNull();
    expect(p.typecheck).toBeNull();
    expect(p.run).toBeNull();
    expect(p.format).toBeNull();
  });

  it("bun takes priority over npm when both exist", async () => {
    const cwd = makeProject("bun-over-npm", {
      "bun.lock": "",
      "package.json": JSON.stringify({}),
    });
    const p = await detectProfile(cwd);
    expect(p.test).toBe("bun test"); // bun default, not npm
  });

  it("Cargo.toml takes priority over Makefile", async () => {
    const cwd = makeProject("rust-with-makefile", {
      "Cargo.toml": '[package]\nname = "app"',
      "Makefile": "all:\n\tcargo build",
    });
    const p = await detectProfile(cwd);
    expect(p.build).toBe("cargo build"); // Cargo, not make
  });

  it("handles nonexistent directory gracefully", async () => {
    const p = await detectProfile("/tmp/nonexistent-baked-test-dir-xyz");
    expect(p.test).toBeNull();
  });
});
