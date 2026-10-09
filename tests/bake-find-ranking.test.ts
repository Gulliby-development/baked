import { describe, expect, test } from "bun:test";
import { fileTypePenalty } from "../src/core/tools/bake-find";

describe("fileTypePenalty", () => {
  // ── Source code (no penalty) ──

  test("source files return 1.0", () => {
    expect(fileTypePenalty("src/core/tools/bake-find.ts")).toBe(1);
    expect(fileTypePenalty("lib/utils.py")).toBe(1);
    expect(fileTypePenalty("main.go")).toBe(1);
    expect(fileTypePenalty("src/App.tsx")).toBe(1);
    expect(fileTypePenalty("pkg/server/handler.rs")).toBe(1);
    expect(fileTypePenalty("Sources/App/main.swift")).toBe(1);
  });

  // ── Generated / build output (0.05) ──

  describe("generated files (0.05)", () => {
    test("universal build dirs", () => {
      expect(fileTypePenalty("dist/index.js")).toBe(0.05);
      expect(fileTypePenalty("build/main.js")).toBe(0.05);
      expect(fileTypePenalty("out/compiled.js")).toBe(0.05);
      expect(fileTypePenalty("target/debug/binary")).toBe(0.05);
      expect(fileTypePenalty("obj/Release/app.dll")).toBe(0.05);
      expect(fileTypePenalty("coverage/lcov.info")).toBe(0.05);
    });

    test("JS/TS framework dirs", () => {
      expect(fileTypePenalty(".next/server/page.js")).toBe(0.05);
      expect(fileTypePenalty(".nuxt/dist/server.js")).toBe(0.05);
      expect(fileTypePenalty(".svelte-kit/output/client.js")).toBe(0.05);
      expect(fileTypePenalty(".turbo/cache/hash")).toBe(0.05);
      expect(fileTypePenalty(".vite/deps/react.js")).toBe(0.05);
      expect(fileTypePenalty(".bun/install/cache/pkg")).toBe(0.05);
      expect(fileTypePenalty(".swc/cache/compiled.js")).toBe(0.05);
      expect(fileTypePenalty(".parcel-cache/data")).toBe(0.05);
    });

    test("TS build info", () => {
      expect(fileTypePenalty("tsconfig.tsbuildinfo")).toBe(0.05);
      expect(fileTypePenalty("packages/core/tsconfig.tsbuildinfo")).toBe(0.05);
    });

    test("mobile build dirs", () => {
      expect(fileTypePenalty(".expo/web/cache")).toBe(0.05);
      expect(fileTypePenalty("DerivedData/Build/Products/app")).toBe(0.05);
      expect(fileTypePenalty("Pods/React/React.podspec")).toBe(0.05);
      expect(fileTypePenalty("Carthage/Build/iOS/lib.framework")).toBe(0.05);
      expect(fileTypePenalty("android/build/outputs/apk")).toBe(0.05);
      expect(fileTypePenalty("ios/build/Debug/app")).toBe(0.05);
      expect(fileTypePenalty(".dart_tool/package_config.json")).toBe(0.05);
    });

    test("Python cache dirs", () => {
      expect(fileTypePenalty("__pycache__/module.cpython-312.pyc")).toBe(0.05);
      expect(fileTypePenalty(".mypy_cache/3.12/module.meta.json")).toBe(0.05);
      expect(fileTypePenalty(".pytest_cache/v/cache")).toBe(0.05);
      expect(fileTypePenalty(".ruff_cache/content")).toBe(0.05);
      expect(fileTypePenalty(".tox/py312/lib/site-packages")).toBe(0.05);
    });

    test("PHP cache dirs", () => {
      expect(fileTypePenalty("storage/framework/cache/data")).toBe(0.05);
      expect(fileTypePenalty("var/cache/prod/pools")).toBe(0.05);
      expect(fileTypePenalty("bootstrap/cache/services.php")).toBe(0.05);
    });

    test("Java/IDE dirs", () => {
      expect(fileTypePenalty(".gradle/caches/modules")).toBe(0.05);
      expect(fileTypePenalty(".kotlin/sessions/info")).toBe(0.05);
      expect(fileTypePenalty(".settings/org.eclipse.prefs")).toBe(0.05);
      expect(fileTypePenalty(".idea/workspace.xml")).toBe(0.05);
    });

    test("C/C++ build dirs", () => {
      expect(fileTypePenalty("cmake-build-debug/CMakeCache.txt")).toBe(0.05);
      expect(fileTypePenalty("cmake-build-release/Makefile")).toBe(0.05);
      expect(fileTypePenalty("CMakeFiles/cmake.check_cache")).toBe(0.05);
    });

    test("Zig/Haskell/Elixir build dirs", () => {
      expect(fileTypePenalty("zig-cache/artifacts")).toBe(0.05);
      expect(fileTypePenalty("zig-out/bin/main")).toBe(0.05);
      expect(fileTypePenalty(".stack-work/dist/build")).toBe(0.05);
      expect(fileTypePenalty("dist-newstyle/build/x86_64")).toBe(0.05);
      expect(fileTypePenalty("_build/dev/lib/app/ebin")).toBe(0.05);
    });

    test("minified files and sourcemaps", () => {
      expect(fileTypePenalty("vendor.min.js")).toBe(0.05);
      expect(fileTypePenalty("styles.min.css")).toBe(0.05);
      expect(fileTypePenalty("app.bundle.min.js")).toBe(0.05);
      expect(fileTypePenalty("index.js.map")).toBe(0.05);
      expect(fileTypePenalty("styles.css.map")).toBe(0.05);
    });
  });

  // ── Lock files (0.05) ──

  describe("lock files (0.05)", () => {
    test("JS ecosystem", () => {
      expect(fileTypePenalty("package-lock.json")).toBe(0.05);
      expect(fileTypePenalty("yarn.lock")).toBe(0.05);
      expect(fileTypePenalty("pnpm-lock.yaml")).toBe(0.05);
      expect(fileTypePenalty("bun.lockb")).toBe(0.05);
      expect(fileTypePenalty("bun.lock")).toBe(0.05);
    });

    test("other ecosystems", () => {
      expect(fileTypePenalty("Cargo.lock")).toBe(0.05);
      expect(fileTypePenalty("Gemfile.lock")).toBe(0.05);
      expect(fileTypePenalty("composer.lock")).toBe(0.05);
      expect(fileTypePenalty("poetry.lock")).toBe(0.05);
      expect(fileTypePenalty("uv.lock")).toBe(0.05);
      expect(fileTypePenalty("Package.resolved")).toBe(0.05);
      expect(fileTypePenalty("deno.lock")).toBe(0.05);
      expect(fileTypePenalty("gradle.lockfile")).toBe(0.05);
    });
  });

  // ── Junk / OS / AI tools (0.1) ──

  describe("junk files (0.1)", () => {
    test("OS metadata", () => {
      expect(fileTypePenalty(".DS_Store")).toBe(0.1);
      expect(fileTypePenalty("src/.DS_Store")).toBe(0.1);
      expect(fileTypePenalty("Thumbs.db")).toBe(0.1);
      expect(fileTypePenalty("desktop.ini")).toBe(0.1);
    });

    test("AI tool config dirs", () => {
      expect(fileTypePenalty(".claude/settings.json")).toBe(0.1);
      expect(fileTypePenalty(".copilot/config.yml")).toBe(0.1);
      expect(fileTypePenalty(".cursor/rules/react.mdc")).toBe(0.1);
      expect(fileTypePenalty(".windsurf/config")).toBe(0.1);
      expect(fileTypePenalty(".aider/cache")).toBe(0.1);
      expect(fileTypePenalty(".cline/settings")).toBe(0.1);
      expect(fileTypePenalty(".codeium/config")).toBe(0.1);
      expect(fileTypePenalty(".tabnine/config")).toBe(0.1);
      expect(fileTypePenalty(".codex/config")).toBe(0.1);
    });

    test("git internals", () => {
      expect(fileTypePenalty(".git/HEAD")).toBe(0.1);
      expect(fileTypePenalty(".git/config")).toBe(0.1);
    });

    test("hooks and changeset dirs", () => {
      expect(fileTypePenalty(".husky/pre-commit")).toBe(0.1);
      expect(fileTypePenalty(".changeset/config.json")).toBe(0.1);
    });

    test(".github is NOT penalized as junk", () => {
      expect(fileTypePenalty(".github/workflows/ci.yml")).not.toBe(0.1);
    });
  });

  // ── Documentation (0.15) ──

  describe("documentation files (0.15)", () => {
    test("markdown and doc formats", () => {
      expect(fileTypePenalty("README.md")).toBe(0.15);
      expect(fileTypePenalty("docs/guide.md")).toBe(0.15);
      expect(fileTypePenalty("CHANGELOG.md")).toBe(0.15);
      expect(fileTypePenalty("architecture.mdx")).toBe(0.15);
      expect(fileTypePenalty("guide.rst")).toBe(0.15);
      expect(fileTypePenalty("manual.adoc")).toBe(0.15);
      expect(fileTypePenalty("notes.txt")).toBe(0.15);
    });

    test("doc directories", () => {
      expect(fileTypePenalty("docs/api.md")).toBe(0.15);
      expect(fileTypePenalty("doc/usage.md")).toBe(0.15);
      expect(fileTypePenalty("documentation/setup.md")).toBe(0.15);
      expect(fileTypePenalty("examples/basic.ts")).toBe(0.15);
      expect(fileTypePenalty("demos/showcase.js")).toBe(0.15);
      expect(fileTypePenalty("samples/hello.py")).toBe(0.15);
    });

    test("named files", () => {
      expect(fileTypePenalty("LICENSE")).toBe(0.15);
      expect(fileTypePenalty("LICENSE.md")).toBe(0.15);
      expect(fileTypePenalty("LICENCE")).toBe(0.15);
      expect(fileTypePenalty("CONTRIBUTING.md")).toBe(0.15);
      expect(fileTypePenalty("CODE_OF_CONDUCT.md")).toBe(0.15);
      expect(fileTypePenalty("SECURITY.md")).toBe(0.15);
      expect(fileTypePenalty("CITATION")).toBe(0.15);
    });
  });

  // ── Test files (0.3) ──

  describe("test files (0.3)", () => {
    test("JS/TS test patterns", () => {
      expect(fileTypePenalty("src/utils.test.ts")).toBe(0.3);
      expect(fileTypePenalty("src/utils.spec.tsx")).toBe(0.3);
      expect(fileTypePenalty("__tests__/utils.ts")).toBe(0.3);
      expect(fileTypePenalty("src/Button.cy.ts")).toBe(0.3);
      expect(fileTypePenalty("src/Button.stories.tsx")).toBe(0.3);
    });

    test("Python test patterns", () => {
      expect(fileTypePenalty("test_utils.py")).toBe(0.3);
      expect(fileTypePenalty("tests/test_auth.py")).toBe(0.3);
      expect(fileTypePenalty("utils_test.py")).toBe(0.3);
      expect(fileTypePenalty("conftest.py")).toBe(0.3);
    });

    test("Go test patterns", () => {
      expect(fileTypePenalty("handler_test.go")).toBe(0.3);
      expect(fileTypePenalty("server_bench_test.go")).toBe(0.3);
    });

    test("Java/Kotlin test patterns", () => {
      expect(fileTypePenalty("UserServiceTest.java")).toBe(0.3);
      expect(fileTypePenalty("UserServiceTests.java")).toBe(0.3);
      expect(fileTypePenalty("UserServiceIT.java")).toBe(0.3);
      expect(fileTypePenalty("UserSpec.scala")).toBe(0.3);
      expect(fileTypePenalty("src/androidTest/java/com/app/Test.java")).toBe(0.3);
      expect(fileTypePenalty("src/test/java/com/app/UserTest.java")).toBe(0.3);
    });

    test("Ruby test patterns", () => {
      expect(fileTypePenalty("user_spec.rb")).toBe(0.3);
      expect(fileTypePenalty("user_test.rb")).toBe(0.3);
      expect(fileTypePenalty("spec/models/user_spec.rb")).toBe(0.3);
    });

    test("other language test patterns", () => {
      expect(fileTypePenalty("auth_test.exs")).toBe(0.3);
      expect(fileTypePenalty("handler_SUITE.erl")).toBe(0.3);
      expect(fileTypePenalty("utils_test.dart")).toBe(0.3);
      expect(fileTypePenalty("main_test.zig")).toBe(0.3);
      expect(fileTypePenalty("UserTests.swift")).toBe(0.3);
      expect(fileTypePenalty("UserTest.php")).toBe(0.3);
    });

    test("test directories", () => {
      expect(fileTypePenalty("tests/unit/auth.ts")).toBe(0.3);
      expect(fileTypePenalty("test/helpers.ts")).toBe(0.3);
      expect(fileTypePenalty("spec/models/user.rb")).toBe(0.3);
      expect(fileTypePenalty("__mocks__/api.ts")).toBe(0.3);
      expect(fileTypePenalty("__snapshots__/Button.snap")).toBe(0.3);
      expect(fileTypePenalty("__fixtures__/data.json")).toBe(0.3);
      expect(fileTypePenalty("fixtures/seed.sql")).toBe(0.3);
    });

    test("e2e directories", () => {
      expect(fileTypePenalty("cypress/e2e/login.cy.ts")).toBe(0.3);
      expect(fileTypePenalty("playwright/tests/home.spec.ts")).toBe(0.3);
      expect(fileTypePenalty("e2e/smoke.test.ts")).toBe(0.3);
    });

    test("mobile test directories", () => {
      expect(fileTypePenalty("test_driver/app_test.dart")).toBe(0.3);
      expect(fileTypePenalty("integration_test/app_test.dart")).toBe(0.3);
    });
  });

  // ── Config files (0.4) ──

  describe("config files (0.4)", () => {
    test("config extensions", () => {
      expect(fileTypePenalty("tsconfig.json")).toBe(0.4);
      expect(fileTypePenalty("config.yaml")).toBe(0.4);
      expect(fileTypePenalty("settings.yml")).toBe(0.4);
      expect(fileTypePenalty("pyproject.toml")).toBe(0.4);
      expect(fileTypePenalty("app.ini")).toBe(0.4);
      expect(fileTypePenalty("server.xml")).toBe(0.4);
      expect(fileTypePenalty("database.properties")).toBe(0.4);
    });

    test("dotfiles", () => {
      expect(fileTypePenalty(".prettierrc")).toBe(0.4);
      expect(fileTypePenalty(".eslintrc")).toBe(0.4);
      expect(fileTypePenalty(".editorconfig")).toBe(0.4);
    });
  });

  // ── Priority ordering ──

  describe("penalty priority ordering", () => {
    test("generated beats everything else", () => {
      expect(fileTypePenalty("dist/test/config.json")).toBe(0.05);
    });

    test("lock beats junk/docs/tests/config", () => {
      expect(fileTypePenalty("package-lock.json")).toBe(0.05);
    });

    test("junk beats docs/tests/config", () => {
      expect(fileTypePenalty(".DS_Store")).toBe(0.1);
    });
  });
});
