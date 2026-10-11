import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { setup } = await import("../src/renderer/client/setup.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
delete scope.window;

describe("skills client", () => {
  test("searches the catalog, installs, reads and removes a skill", async () => {
    const popular = await setup.skillCatalog("baked", "");
    expect(popular.skills.length).toBeGreaterThan(0);
    const { skills } = await setup.skillCatalog("baked", "pdf");
    const pdf = skills.find((s) => s.skillId === "pdf");
    if (!pdf) throw new Error("No pdf skill in the mock catalog");

    const installed = await setup.installSkill("baked", pdf, "project");
    expect(installed.skill).toMatchObject({ id: "pdf", scope: "project" });
    expect(installed.skills.filter((s) => s.id === "pdf").map((s) => s.scope).sort()).toEqual(["global", "project"]);

    const file = await setup.skill("baked", "project", "pdf");
    expect(file.content).toContain("# pdf");

    const removed = await setup.removeSkill("baked", "project", "pdf");
    expect(removed.skills.some((s) => s.id === "pdf" && s.scope === "project")).toBe(false);
    await expect(setup.removeSkill("baked", "project", "pdf")).rejects.toBeInstanceOf(ApiError);
  });

  test("a failed install is an error the dialog shows", async () => {
    const { skills } = await setup.skillCatalog("baked", "sqlite");
    const broken = skills[0];
    if (!broken) throw new Error("No sqlite skill in the mock catalog");
    await expect(setup.installSkill("baked", broken, "global")).rejects.toThrow("SKILL.md");
  });

  test("has its own project section", () => {
    expect(parseRoute(projectHref("baked", "skills"))).toEqual({ name: "project", key: "baked", section: "skills", id: null });
  });
});
