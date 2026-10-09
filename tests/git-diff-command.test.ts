import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InfoPopupConfig } from "../src/components/modals/InfoPopup.js";
import { register } from "../src/core/commands/git.js";
import type { CommandContext, CommandHandler } from "../src/core/commands/types.js";

test("git diff opens added and removed lines in the information popup", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "baked-diff-command-"));
  try {
    expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd }).exitCode).toBe(0);
    writeFileSync(join(cwd, "bread.txt"), "before\n");
    expect(Bun.spawnSync(["git", "add", "bread.txt"], { cwd }).exitCode).toBe(0);
    writeFileSync(join(cwd, "bread.txt"), "after\n");
    const popups: InfoPopupConfig[] = [];
    const context = {
      cwd,
      openInfoPopup: (popup: InfoPopupConfig) => popups.push(popup),
    } as unknown as CommandContext;
    const commands = new Map<string, CommandHandler>();
    register(commands);
    await commands.get("/git diff")?.("/git diff", context);
    expect(popups).toHaveLength(1);
    expect(popups[0]?.title).toBe("Git Diff");
    const lines = popups[0]?.lines.map((line) => "label" in line ? line.label : "") ?? [];
    expect(lines).toContain("-before");
    expect(lines).toContain("+after");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
