import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEATURES,
  GROUPS,
  issueOf,
  reachOf,
  SURFACES,
  type Surface,
  type SurfaceEntry,
  targetOf,
} from "../src/core/features/registry.js";
import { withParityTable } from "../src/core/features/render.js";
import { apiRoutes, desktopScreens, tuiCommands } from "./helpers/surface-inventory.js";

const root = join(import.meta.dir, "..");

const targets = (surface: Surface): string[] =>
  FEATURES.flatMap((f) => reachOf(f[surface]).map(targetOf));

/** Every string literal the CLI parses: subcommand names and flags. */
function cliWords(): Set<string> {
  const files = [
    join(root, "src/boot.tsx"),
    ...readdirSync(join(root, "src/headless")).map((f) => join(root, "src/headless", f)),
  ];
  const words = new Set<string>();
  for (const file of files)
    for (const m of readFileSync(file, "utf8").matchAll(/"(-{0,2}[a-z][a-z-]*)"/g))
      words.add(m[1] ?? "");
  return words;
}

/** An API route is covered by a reach naming it or its parent, for an optional trailing ID. */
const covers = (reach: string, route: string): boolean =>
  route === reach || route === `${reach}/:id`;

describe("feature registry", () => {
  test("feature IDs are unique and every group is known", () => {
    const ids = FEATURES.map((f) => f.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(FEATURES.filter((f) => !(GROUPS as readonly string[]).includes(f.group))).toEqual([]);
  });

  test("every surface of every feature has a reach, a gap issue or a reason", () => {
    const problems: string[] = [];
    const check = (id: string, surface: Surface, entry: SurfaceEntry): void => {
      const where = `${id}.${surface}`;
      if (Array.isArray(entry)) {
        if (entry.length === 0) problems.push(`${where}: empty reach; use a gap or an exemption`);
        return;
      }
      const e = entry as Exclude<SurfaceEntry, readonly string[]>;
      if (e.status === "gap" || e.status === "partial") {
        if (!Number.isInteger(e.issue) || e.issue <= 0) problems.push(`${where}: no issue`);
        if (e.status === "partial" && (e.reach.length === 0 || !e.note.trim()))
          problems.push(`${where}: a partial entry needs a reach and a note`);
      } else if (!e.reason.trim()) problems.push(`${where}: an exemption needs a reason`);
    };
    for (const f of FEATURES) for (const s of SURFACES) check(f.id, s, f[s]);
    expect(problems).toEqual([]);
  });

  test("a feature on the desktop is served by the API", () => {
    // The desktop reaches the core only through `baked serve`, so a desktop screen with no API
    // reach means the registry is wrong.
    const wrong = FEATURES.filter(
      (f) => reachOf(f.desktop).length > 0 && issueOf(f.api) !== null && reachOf(f.api).length === 0,
    );
    expect(wrong.map((f) => f.id)).toEqual([]);
  });

  test("every TUI slash command is in the registry", () => {
    const listed = new Set(targets("tui"));
    expect(tuiCommands().filter((cmd) => !listed.has(cmd))).toEqual([]);
  });

  test("every TUI reach names a slash command or a key", () => {
    const commands = new Set(tuiCommands());
    const unknown = targets("tui").filter((t) => !t.startsWith("key ") && !commands.has(t));
    expect(unknown).toEqual([]);
  });

  test("every /v1 route the local API serves is in the registry", () => {
    const listed = targets("api");
    const missing = apiRoutes().filter((route) => !listed.some((reach) => covers(reach, route)));
    expect(missing).toEqual([]);
  });

  test("every API reach names a route the local API serves", () => {
    const routes = new Set(apiRoutes());
    expect(targets("api").filter((t) => !routes.has(t))).toEqual([]);
  });

  test("every desktop screen is in the registry", () => {
    const listed = new Set(targets("desktop"));
    expect(desktopScreens().filter((screen) => !listed.has(screen))).toEqual([]);
  });

  test("every desktop reach names a screen", () => {
    const screens = new Set(desktopScreens());
    expect(targets("desktop").filter((t) => !screens.has(t))).toEqual([]);
  });

  test("every CLI reach names commands and flags the CLI parses", () => {
    const words = cliWords();
    const unknown = targets("cli").filter((t) => {
      const parts = t.startsWith("baked ") ? t.slice(6).split(" ") : [t];
      return parts.some((p) => !words.has(p));
    });
    expect(unknown).toEqual([]);
  });

  test("docs/parity.md matches the registry", () => {
    const doc = readFileSync(join(root, "docs/parity.md"), "utf8");
    // Run `bun scripts/parity-docs.ts` after changing the registry.
    expect(doc).toBe(withParityTable(doc));
  });
});

describe("surface inventory", () => {
  test("finds routes from literals, regexes and action lists", () => {
    const routes = apiRoutes();
    for (const route of [
      "/v1/health",
      "/v1/sessions/:id/prompts/:id",
      "/v1/workflow/runs/:id/recover",
      "/v1/workflow/runs/:id/deliver/execute",
      "/v1/initiatives/:id/replan",
      "/v1/providers/:id/logout",
      "/v1/workflow/checks/:id/run",
    ])
      expect(routes).toContain(route);
    expect(routes.some((r) => r.includes(":action") || r.endsWith("/"))).toBe(false);
  });

  test("finds desktop sections", () => {
    expect(desktopScreens()).toContain("project/chat");
    expect(desktopScreens()).toContain("settings/providers");
  });
});
