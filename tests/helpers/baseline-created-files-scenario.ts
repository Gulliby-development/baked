import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Check } from "../../src/core/workflows/schemas.js";
import { fixturePolicy, workflowFixture } from "./workflow-fixture.js";

/**
 * What each toolchain's first check run creates in a project that does not ignore it (#1815):
 * `cargo test` on a `cargo init` crate writes `Cargo.lock`, pytest `__pycache__/`, `dotnet test`
 * without a `.gitignore` `obj/` and `bin/`, Maven `target/`, Gradle `.gradle/` and `build/`,
 * Kotlin 2 `.kotlin/`, a `make` target `build/`, PHPUnit `.phpunit.cache/` and PHP-CS-Fixer
 * `.php-cs-fixer.cache`.
 */
export const FIRST_RUN_OUTPUTS: Record<string, string[]> = {
  rust: ["Cargo.lock"],
  python: ["src/__pycache__/app.cpython-312.pyc", "tests/__pycache__/test_app.cpython-312-pytest-8.3.4.pyc"],
  csharp: ["obj/project.assets.json", "bin/Debug/net10.0/App.dll"],
  maven: ["target/classes/app/App.class"],
  gradle: [".gradle/8.10/fileHashes/fileHashes.lock", "build/classes/kotlin/main/AppKt.class"],
  kotlin: [".kotlin/sessions/kotlin-compiler.salive"],
  "c and cpp": ["build/app.o"],
  php: [".phpunit.cache/test-results", ".php-cs-fixer.cache"],
};

/**
 * A run whose required check creates `outputs` on its first run and leaves them alone after:
 * where it stops before approval, the files its baseline lists, and how it ends once approved.
 The check creates `later` once the task has written its file, as pytest writes the `.pyc` of a
 * module a task added. A real toolchain cell seeds a project with `files` and runs its own
 * `checks` instead.
 */
export async function baselineCreatedFilesScenario(
  outputs: string[],
  project: { files: Record<string, string>; checks: Check[] } | null = null,
  later: string[] = [],
) {
  // `mkdirSync(".", { recursive: true })` throws on Windows, so a root file makes no directory.
  const write = `const fs = require("node:fs"); const path = require("node:path"); const make = (ps) => { for (const p of ps) if (!fs.existsSync(p)) { if (path.dirname(p) !== ".") fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "first run"); } }; make(${JSON.stringify(outputs)}); if (fs.existsSync("value.txt")) make(${JSON.stringify(later)});`;
  const build: Check = { id: "build", executable: "bun", args: ["-e", write], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
  const policy = { ...fixturePolicy, checks: [...fixturePolicy.checks, ...(project ? project.checks : [build])] };
  const f = workflowFixture({ policy });
  try {
    for (const [path, text] of Object.entries(project?.files ?? {})) {
      mkdirSync(dirname(join(f.root, path)), { recursive: true });
      writeFileSync(join(f.root, path), text);
    }
    const run = await f.start();
    const drive = async () => {
      for (let i = 0; i < 8; i++) {
        const view = await f.service.get(run.runId);
        if (view.pendingRequestIds.length || view.status === "blocked" || view.status === "completed") return view;
        if (view.status === "paused" || view.status === "created") await f.resume(run.runId);
        await f.service.drive(run.runId, new AbortController().signal);
      }
      return f.service.get(run.runId);
    };
    const approval = await drive();
    const artifact = f.service.store.artifacts(run.runId).find((a) => a.logical_path.startsWith("baselines/"));
    const baseline = artifact
      ? (JSON.parse(f.service.store.readArtifact(run.runId, artifact.id)) as { snapshotId: string; createdByChecks?: string[] })
      : null;
    const state = f.service.store.state(run.runId);
    let final = approval;
    if (approval.status === "waiting" && approval.reason === "approval") {
      await f.approve(run.runId);
      final = await drive();
    }
    return {
      approval: { status: approval.status, reason: approval.reason },
      baseline,
      baselineIsSnapshot: baseline?.snapshotId === state.manifest.baselineSnapshotId,
      final: { status: final.status, reason: final.reason },
    };
  } finally {
    await f.dispose();
  }
}
