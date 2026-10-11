/** Regenerates the feature parity tables in docs/parity.md from src/core/features/registry.ts. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withParityTable } from "../src/core/features/render.js";

const file = join(import.meta.dir, "..", "docs", "parity.md");
const before = readFileSync(file, "utf8");
const after = withParityTable(before);
if (after === before) console.log("docs/parity.md is up to date");
else {
  writeFileSync(file, after);
  console.log("Updated docs/parity.md");
}
