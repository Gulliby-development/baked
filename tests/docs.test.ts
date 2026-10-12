import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { getCommandDefs, isDefHidden } from "../src/core/commands/registry.js";
import { BUNDLED_DOCS } from "../src/core/help/bundled-docs.js";
import { GateSchema, validateGate } from "../src/core/workflows/v2/definition.js";

const root = resolve(import.meta.dir, "..");

function walk(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, accept));
    else if (accept(path)) out.push(path);
  }
  return out;
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces as hyphens, repeats numbered. */
function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading?.[1]) continue;
    const base = heading[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

function links(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...withoutCode.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? "");
}

const markdownFiles = [
  ...walk(join(root, "docs"), (path) => path.endsWith(".md")),
  ...["README.md", "CONTRIBUTING.md", "AGENTS.md", "apps/desktop/README.md"].map((file) => join(root, file)),
];

describe("documentation", () => {
  test("relative links and their anchors resolve", () => {
    const broken: string[] = [];
    for (const file of markdownFiles) {
      const text = readFileSync(file, "utf8");
      for (const link of links(text)) {
        if (/^[a-z]+:/.test(link)) continue;
        const [target = "", anchor] = link.split("#");
        const path = target ? resolve(dirname(file), target) : file;
        const where = `${relative(root, file)} -> ${link}`;
        if (!existsSync(path)) {
          broken.push(`${where} (missing file)`);
          continue;
        }
        if (anchor && path.endsWith(".md") && !anchors(readFileSync(path, "utf8")).has(anchor)) {
          broken.push(`${where} (missing heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("docs paths named in source comments exist", () => {
    const sources = [
      ...walk(join(root, "src"), (path) => /\.tsx?$/.test(path)),
      ...walk(join(root, "apps/desktop/src"), (path) => /\.tsx?$/.test(path)),
    ];
    const missing: string[] = [];
    for (const file of sources) {
      const comments = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^\s*(\/\/|\/\*|\*)/.test(line));
      for (const line of comments) {
        for (const match of line.matchAll(/\bdocs\/[\w./-]+\.(?:md|json)\b/g)) {
          if (!existsSync(join(root, match[0]))) missing.push(`${relative(root, file)}: ${match[0]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the command reference lists every slash command of the palette", () => {
    const reference = readFileSync(join(root, "docs/commands.md"), "utf8");
    const absent = getCommandDefs()
      .filter((def) => !isDefHidden(def))
      .map((def) => def.cmd)
      .filter((cmd) => !reference.includes(`\`${cmd}\``));
    expect(absent).toEqual([]);
  });

  test("the example gate is a valid gate definition", () => {
    const raw = JSON.parse(readFileSync(join(root, "docs/workflows/examples/ai-acceptance-gate.json"), "utf8"));
    const gate = GateSchema.parse(raw);
    expect(validateGate(gate)).toEqual([]);
  });

  test("every docs page is bundled for baked_help, with its current text", () => {
    const pages = walk(join(root, "docs"), (path) => path.endsWith(".md"))
      .map((path) => relative(join(root, "docs"), path).replace(/\\/g, "/"))
      .sort();
    expect(BUNDLED_DOCS.map(([path]) => path).sort()).toEqual(pages);
    for (const [path, text] of BUNDLED_DOCS) {
      expect(text).toBe(readFileSync(join(root, "docs", path), "utf8"));
    }
  });
});
