import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoMap } from "../src/core/intelligence/repo-map.js";

const dir = mkdtempSync(join(tmpdir(), "repo-map-background-"));
let repoMap: RepoMap | undefined;

afterAll(async () => {
  await repoMap?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a later scan rebuilds the edges of files re-indexed one by one after edits", async () => {
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/b.ts"), "export function b(): number {\n  return 1;\n}\n");
  writeFileSync(join(dir, "src/c.ts"), "export function c(): number {\n  return 2;\n}\n");
  writeFileSync(
    join(dir, "src/a.ts"),
    'import { b } from "./b.js";\n\nexport function a(): number {\n  return b();\n}\n',
  );
  repoMap = new RepoMap(dir);
  await repoMap.scan();
  expect(repoMap.getFileDependencies("src/a.ts").map((d) => d.path)).toEqual(["src/b.ts"]);

  writeFileSync(
    join(dir, "src/a.ts"),
    'import { b } from "./b.js";\nimport { c } from "./c.js";\n\nexport function a(): number {\n  return b() + c();\n}\n',
  );
  repoMap.onFileChanged(join(dir, "src/a.ts"));
  await Bun.sleep(400);

  await repoMap.scan();
  expect(
    repoMap
      .getFileDependencies("src/a.ts")
      .map((d) => d.path)
      .sort(),
  ).toEqual(["src/b.ts", "src/c.ts"]);
});
