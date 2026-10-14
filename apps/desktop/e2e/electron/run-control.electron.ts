import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * Controlling workflow runs against the repository's own `baked serve`, whose run agent is
 * scripted (BAKED_TEST_WORKFLOW, `src/core/workflows/scripted-executor.ts`): a quick task from
 * the overview, Needs you, pause and resume, cancel, undo and the run's sections. The scripted
 * task writes `e2e-output.txt`.
 */

/** A Git project whose feature check passes once the run wrote its file. */
function runnableProject(root: string): void {
  execSync(
    "git init -q && git -c user.email=e2e@baked.dev -c user.name=e2e commit -q --allow-empty -m init",
    { cwd: root },
  );
  mkdirSync(join(root, ".baked"), { recursive: true });
  writeFileSync(
    join(root, ".baked", "config.json"),
    JSON.stringify({
      workflows: {
        enabled: true,
        importsEnabled: false,
        defaultWorkflow: "sdd",
        policy: {
          checks: [
            {
              id: "output",
              executable: "bun",
              args: ["-e", "if ((await Bun.file('e2e-output.txt').text()) !== 'ready') process.exit(1)"],
              cwd: ".",
              timeoutMs: 20000,
              required: true,
              scope: "feature",
              envNames: [],
              writes: [],
            },
          ],
        },
      },
    }),
  );
}

const scripted = (delayMs = 0) => ({
  script: { turns: [] },
  env: { BAKED_TEST_WORKFLOW: "1", BAKED_TEST_WORKFLOW_DELAY_MS: String(delayMs) },
});

async function openProject(page: Page, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const stages = (page: Page) => page.getByRole("list", { name: "Stages" });
const part = (page: Page) => page.getByRole("region", { name: "Your part" });

/** No native dialog may open: confirmations are the app's own. */
function noNativeDialogs(page: Page): string[] {
  const opened: string[] = [];
  page.on("dialog", (dialog) => {
    opened.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return opened;
}

/** Starts a quick run from the New run form. */
async function startQuick(page: Page, text = "Write the output file") {
  await nav(page).getByRole("link", { name: "New run" }).click();
  const form = page.getByRole("form", { name: "New workflow run" });
  await form.getByRole("textbox", { name: "What should change?" }).fill(text);
  await form.getByRole("button", { name: /^quick/ }).click();
  await form.getByRole("button", { name: "Start run" }).click();
}

async function finished(page: Page) {
  await expect(stages(page).getByRole("button", { name: /^Done finish/ })).toHaveAccessibleName(
    /, done$/,
    { timeout: 30_000 },
  );
}

test("a quick task from the overview waits in Needs you, is approved there and is counted", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted());
  const dialogs = noNativeDialogs(page);
  await openProject(page);
  await nav(page).getByRole("link", { name: "Overview" }).click();
  await page.getByRole("textbox", { name: "What should change?" }).fill("Write the output file");
  await page.getByRole("button", { name: "Quick", exact: true }).click();
  const form = page.getByRole("form", { name: "Quick task" });
  await expect(form.getByRole("textbox", { name: "What should change?" })).toHaveValue(
    "Write the output file",
  );
  await expect(form.getByRole("textbox", { name: "Feature ID" })).toHaveValue(
    "write-the-output-file",
  );
  await form.getByRole("button", { name: "Plan it" }).click();
  await expect(part(page)).toBeVisible({ timeout: 15_000 });
  const runHash = await page.evaluate(() => window.location.hash);

  // The approval is listed in Needs you, across projects, and answered there.
  await page.evaluate(() => {
    window.location.hash = "#/attention";
  });
  const items = page.getByRole("region", { name: "Waiting items" });
  await expect(items.getByRole("heading", { name: "Needs you", level: 1 })).toBeVisible();
  await items.getByRole("link", { name: /write-the-output-file/ }).first().click();
  const selected = page.getByRole("region", { name: "Selected item" });
  await expect(selected.getByText("e2e-output.txt").first()).toBeVisible();
  expect(existsSync(join(root, "e2e-output.txt"))).toBe(false);
  await selected.getByRole("button", { name: /^Approve/ }).first().click();
  await expect(items.getByText("Nothing waits for you in the open projects.")).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(() => existsSync(join(root, "e2e-output.txt")), { timeout: 30_000 }).toBe(true);
  expect(readFileSync(join(root, "e2e-output.txt"), "utf8")).toBe("ready");

  // The overview lists the run, and Usage counts the scripted agent's tokens.
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, runHash);
  await finished(page);
  await nav(page).getByRole("link", { name: "Overview" }).click();
  const runs = page.getByRole("region", { name: "Runs in this project" });
  await expect(runs.getByText("write-the-output-file").first()).toBeVisible({ timeout: 30_000 });
  await nav(page).getByRole("link", { name: "Usage" }).click();
  await expect(page.getByRole("button", { name: /^Total tokens [1-9]/ })).toBeVisible({
    timeout: 30_000,
  });
  const byStage = page.getByRole("region", { name: "Tokens by stage" });
  await expect(byStage.getByText("No agent attempts match these filters.")).toHaveCount(0);
  const byModel = page.getByRole("region", { name: "By model" });
  await expect(byModel.getByText(/gpt-scripted/).first()).toBeVisible();
  expect(dialogs).toEqual([]);
});

test("a paused run writes nothing until it is resumed", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted(1500));
  await openProject(page);
  await startQuick(page);
  await page.getByRole("button", { name: "Pause", exact: true }).click({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveCount(0);
  await page.waitForTimeout(2500);
  await expect(part(page)).toHaveCount(0);
  expect(existsSync(join(root, "e2e-output.txt"))).toBe(false);

  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await part(page).getByRole("button", { name: "Approve and implement" }).click({ timeout: 30_000 });
  await finished(page);
  expect(readFileSync(join(root, "e2e-output.txt"), "utf8")).toBe("ready");
});

test("a cancelled run asks first in the app's own dialog and then stops for good", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted());
  const dialogs = noNativeDialogs(page);
  await openProject(page);
  await startQuick(page);
  await expect(part(page)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Cancel run" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toBeVisible();
  // Closing the dialog keeps the run.
  await confirm.getByRole("button", { name: /^(Keep|Cancel|Close)/ }).first().click();
  await expect(confirm).toHaveCount(0);
  await expect(part(page)).toBeVisible();

  await page.getByRole("button", { name: "Cancel run" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0, { timeout: 15_000 });
  await expect(part(page)).toHaveCount(0);
  await page.getByRole("link", { name: "All runs" }).click();
  const list = page.getByRole("region", { name: "Workflow runs" });
  await list.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: "Waiting" }).click();
  await expect(list.getByText("write-the-output-file")).toHaveCount(0);
  expect(existsSync(join(root, "e2e-output.txt"))).toBe(false);
  expect(dialogs).toEqual([]);
});

test("Undo edits on a finished run keeps the edits the run committed", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted());
  const dialogs = noNativeDialogs(page);
  await openProject(page);
  await startQuick(page);
  await part(page).getByRole("button", { name: "Approve and implement" }).click({ timeout: 15_000 });
  await finished(page);
  expect(readFileSync(join(root, "e2e-output.txt"), "utf8")).toBe("ready");

  // A finished task's edits joined the run's baseline: undo restores only uncommitted ones.
  await page.getByRole("button", { name: "Undo edits" }).click();
  const confirm = page.getByRole("dialog", { name: "Undo this run's edits?" });
  await confirm.getByRole("button", { name: "Undo edits" }).click();
  const report = page.getByRole("region", { name: "Undo report" });
  await expect(report).toContainText("Nothing to undo", { timeout: 15_000 });
  expect(readFileSync(join(root, "e2e-output.txt"), "utf8")).toBe("ready");
  await report.getByRole("button", { name: "Dismiss" }).click();
  await expect(report).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test("every section of a finished run opens and shows the run's own records", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted());
  await openProject(page);
  await startQuick(page);
  await part(page).getByRole("button", { name: "Approve and implement" }).click({ timeout: 15_000 });
  await finished(page);

  const panel = page.getByRole("tabpanel");
  const open = async (station: RegExp, section: string) => {
    await stages(page).getByRole("button", { name: station }).click();
    const tabs = page.getByRole("tablist", { name: /sections$/ });
    const tab = tabs.getByRole("tab", { name: new RegExp(`^${section}`) });
    if (await tab.count()) await tab.click();
    else {
      const other = page.getByRole("combobox", { name: "Other sections" });
      const option = other.locator("option").filter({ hasText: new RegExp(`^${section}`) });
      await other.selectOption((await option.getAttribute("value")) ?? "");
    }
    await expect(page.getByRole("tab", { name: new RegExp(`^${section}`), selected: true })).toBeVisible();
  };
  await open(/^Done finish/, "Overview");
  await expect(panel).toBeVisible();
  await open(/^Done finish/, "Report");
  await expect(panel).not.toBeEmpty();
  await open(/^Done finish/, "Criteria");
  // quick has no spec stage, so no criteria.
  await expect(panel).toContainText("No acceptance criteria yet.");
  await open(/^Done finish/, "Plan");
  await expect(panel.getByText("Write e2e-output.txt.").first()).toBeVisible();
  await open(/^Done finish/, "Tasks");
  await expect(panel.getByText("Write the output file").first()).toBeVisible();
  await open(/^Done finish/, "Changes");
  await expect(panel.getByText("e2e-output.txt").first()).toBeVisible();
  await open(/^Done finish/, "Checks");
  await expect(panel.getByText("output").first()).toBeVisible();
  await open(/^Done finish/, "Findings");
  await expect(panel).toBeVisible();
  await open(/^Done finish/, "Decision");
  await expect(panel.getByText("Nothing waits for you here.")).toBeVisible();
});

test("cleaning up old runs is picked from the app's own controls and keeps recent runs", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted());
  const dialogs = noNativeDialogs(page);
  await openProject(page);
  await startQuick(page);
  await expect(part(page)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Cancel run" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0, { timeout: 15_000 });

  await page.getByRole("link", { name: "All runs" }).click();
  await page.getByRole("button", { name: "Clean up old runs…" }).click();
  const cleanup = page.getByRole("dialog", { name: "Clean up old runs" });
  // No platform date picker: the age is one of the app's segments.
  await expect(cleanup.locator("input[type=date], input[type=datetime-local]")).toHaveCount(0);
  const ages = cleanup.getByRole("group", { name: "Last changed before" });
  await expect(ages.getByRole("button", { name: "90 days ago" })).toHaveAttribute("aria-pressed", "true");
  await ages.getByRole("button", { name: "30 days ago" }).click();
  await expect(ages.getByRole("button", { name: "30 days ago" })).toHaveAttribute("aria-pressed", "true");
  await cleanup.getByRole("button", { name: "Preview" }).click();
  // The run ended just now, so it is kept.
  await expect(cleanup.getByRole("status")).toContainText("Nothing to clean up");
  await cleanup.getByRole("button", { name: "Done" }).click();
  await expect(cleanup).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Workflow runs" }).getByText("write-the-output-file").first(),
  ).toBeVisible();
  expect(dialogs).toEqual([]);
});
