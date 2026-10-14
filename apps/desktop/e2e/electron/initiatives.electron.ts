import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * Initiatives against the repository's own `baked serve`, whose agent is scripted
 * (BAKED_TEST_WORKFLOW, `src/core/workflows/scripted-executor.ts`): it always proposes the same
 * split, `SCRIPTED_SPLIT`. Service API (sdd, large) and User guide (quick, small) start first;
 * Web screens (quick, medium) and Command line (quick, small) build on the Service API.
 */

/** A Git project whose feature check passes once every run's file says ready. */
function runnableProject(root: string, policy: Record<string, unknown> = {}): void {
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
          ...policy,
          checks: [
            {
              id: "output",
              executable: "bun",
              args: [
                "-e",
                "let n = 0; for await (const f of new Bun.Glob('out/*.txt').scan('.')) { n++; if ((await Bun.file(f).text()) !== 'ready') process.exit(1); } if (!n) process.exit(1);",
              ],
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

/** Each feature run writes `out/RUN_ID.txt`, so runs in one working copy never share a file. */
const scripted = { script: { turns: [] }, env: { BAKED_TEST_WORKFLOW: "out/{run}.txt" } };

async function openProject(page: Page, project = "gamma") {
  await page.getByRole("article", { name: project }).getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("heading", { name: "Coordinator", level: 1 })).toBeVisible();
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const board = (page: Page) => page.getByRole("region", { name: "Features" });
const card = (page: Page, title: string) => board(page).getByRole("listitem", { name: title });

/** No native dialog may open: confirmations are the app's own. */
function noNativeDialogs(page: Page): string[] {
  const opened: string[] = [];
  page.on("dialog", (dialog) => {
    opened.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return opened;
}

/** Starts an initiative from the full form and waits for the scripted split. */
async function startInitiative(page: Page, id: string) {
  await nav(page).getByRole("link", { name: "Initiatives" }).click();
  const newButton = page.getByRole("button", { name: "New initiative" });
  if (await newButton.isVisible()) await newButton.click();
  await page.getByRole("button", { name: "Start without the coordinator" }).click();
  const form = page.getByRole("dialog", { name: "New initiative" });
  await form.getByRole("textbox", { name: "Request" }).fill("Build the shop");
  await form.getByRole("textbox", { name: "Initiative ID" }).fill(id);
  await form.getByRole("button", { name: "Start initiative" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole("button", { name: "Approve split" })).toBeVisible({ timeout: 30_000 });
}

/** Approves the plan of a feature's run in the run screen, then comes back. */
async function decide(page: Page, title: string) {
  const back = await page.evaluate(() => window.location.hash);
  await card(page, title).getByRole("link", { name: `Decide: ${title}` }).click({ timeout: 30_000 });
  await page
    .getByRole("region", { name: "Your part" })
    .getByRole("button", { name: /^Approve/ })
    .first()
    .click({ timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Your part" })).toHaveCount(0, { timeout: 30_000 });
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, back);
}

test("a big idea goes to the coordinator, and a split is edited, approved and run step by step", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted);
  const native = noNativeDialogs(page);
  await openProject(page);

  // The empty screen asks for the big idea and hands it to the coordinator.
  await nav(page).getByRole("link", { name: "Initiatives" }).click();
  await page.getByRole("textbox", { name: "What is the big idea?" }).fill("Build the shop");
  await page.getByRole("button", { name: "Plan it with the coordinator" }).click();
  await expect(page.getByRole("textbox", { name: "Message BAKED" })).toHaveValue(
    "Plan this as an initiative: Build the shop",
  );
  await page.getByRole("textbox", { name: "Message BAKED" }).fill("");

  await startInitiative(page, "shop");
  const detail = page.getByRole("region", { name: "Scripted initiative initiative" });
  await expect(detail.getByText("approve split", { exact: true })).toBeVisible();
  await expect(board(page).getByRole("heading", { name: "Step 1 · starts first" })).toBeVisible();
  await expect(board(page).getByRole("heading", { name: "Step 2 · after step 1" })).toBeVisible();
  await expect(card(page, "Service API").getByText("sdd", { exact: true })).toBeVisible();
  await expect(card(page, "User guide").getByText("quick", { exact: true })).toBeVisible();
  await expect(
    card(page, "Service API").getByRole("button", { name: "large" }),
  ).toHaveAttribute("aria-pressed", "true");

  // A feature others build on keeps a workflow that writes a spec.
  await card(page, "Service API").getByRole("button", { name: "Workflow: Service API" }).click();
  const workflow = page.getByRole("dialog", { name: "Feature workflow" });
  await expect(workflow).toContainText("Other features build on its spec");
  await workflow.getByRole("button", { name: "Cancel" }).click();

  // Size, rename, split, merge and remove each make a new plan revision.
  await card(page, "User guide").getByRole("button", { name: "medium" }).click();
  await expect(card(page, "User guide").getByRole("button", { name: "medium" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await card(page, "Command line").getByRole("button", { name: "Rename: Command line" }).click();
  const rename = page.getByRole("dialog", { name: "Rename feature" });
  await rename.getByRole("textbox", { name: "Title" }).fill("Terminal commands");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(card(page, "Terminal commands")).toBeVisible();

  await card(page, "Web screens").getByRole("button", { name: "Split: Web screens" }).click();
  const split = page.getByRole("dialog", { name: "Split feature" });
  await split.getByRole("textbox", { name: "Title" }).nth(0).fill("Shop screens");
  await split.getByRole("textbox", { name: "Title" }).nth(1).fill("Admin screens");
  await split.getByRole("button", { name: "Split", exact: true }).click();
  await expect(card(page, "Shop screens")).toBeVisible();
  await expect(card(page, "Admin screens")).toBeVisible();

  await page.getByRole("checkbox", { name: "Select Shop screens to merge" }).check();
  await page.getByRole("checkbox", { name: "Select Admin screens to merge" }).check();
  await page.getByRole("button", { name: "Merge selected (2)" }).click();
  const merge = page.getByRole("dialog", { name: "Merge 2 features" });
  await merge.getByRole("textbox", { name: "Title" }).fill("Web screens");
  await merge.getByRole("button", { name: "Merge" }).click();
  await expect(card(page, "Web screens")).toBeVisible();
  await expect(card(page, "Shop screens")).toBeHidden();

  await card(page, "Terminal commands")
    .getByRole("button", { name: "Remove: Terminal commands" })
    .click();
  await page.getByRole("dialog", { name: "Remove feature" }).getByRole("button", { name: "Remove" }).click();
  await expect(card(page, "Terminal commands")).toBeHidden();
  // An initiative keeps at least three features.
  await expect(card(page, "Web screens").getByRole("button", { name: /^Remove/ })).toBeHidden();
  await expect(detail).toContainText("plan revision 6");

  // Approved, the features run one at a time in the working copy; each plan waits for a person.
  await page.getByRole("button", { name: "Approve split" }).click();
  await expect(detail.getByText("active", { exact: true })).toBeVisible();
  await expect(card(page, "Service API")).toContainText("needs decision", { timeout: 30_000 });
  await decide(page, "Service API");
  await expect(card(page, "Service API")).toContainText("done", { timeout: 30_000 });
  await expect(card(page, "User guide")).toContainText("needs decision", { timeout: 30_000 });
  await decide(page, "User guide");
  await expect(card(page, "Web screens")).toContainText("needs decision", { timeout: 30_000 });
  await decide(page, "Web screens");
  await expect(detail.getByText("completed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("img", { name: "3 of 3 features done" })).toBeVisible();
  expect(native).toEqual([]);
});

/** The tokens a card says a feature starts with, as a number. */
async function startsWith(page: Page, title: string): Promise<number> {
  const text = (await card(page, title).textContent()) ?? "";
  const match = /starts with ([\d.]+)([kM]?)/.exec(text);
  if (!match) throw new Error(`No share on ${title}: ${text}`);
  return Number(match[1]) * ({ k: 1e3, M: 1e6 }[match[2] ?? ""] ?? 1);
}

test("features in worktrees run side by side on size-weighted shares, and the budget, pause and re-plan work", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root, { executionMode: "worktree" });
  const { page } = await launch(scripted);
  const native = noNativeDialogs(page);
  await openProject(page);
  await startInitiative(page, "shop");
  const detail = page.getByRole("region", { name: "Scripted initiative initiative" });
  await expect(detail).toContainText("up to 2 features at once");

  // Both features of step 1 start at once; step 2 waits with shares weighted by size.
  await page.getByRole("button", { name: "Approve split" }).click();
  await expect(card(page, "Service API")).toContainText("needs decision", { timeout: 30_000 });
  await expect(card(page, "User guide")).toContainText("needs decision");
  await expect(card(page, "Web screens")).toContainText("waits for api");
  const medium = await startsWith(page, "Web screens");
  const small = await startsWith(page, "Command line");
  expect(medium / small).toBeCloseTo(2, 1);

  // The shared budget only goes up.
  await detail.getByRole("button", { name: "Extend budget" }).click();
  const extend = page.getByRole("dialog", { name: "Extend budget" });
  await extend.getByRole("textbox", { name: "Tokens" }).fill("1000");
  await expect(extend).toContainText(/only go up|lower/i);
  await extend.getByRole("textbox", { name: "Tokens" }).fill("9M");
  await extend.getByRole("button", { name: "Extend" }).click();
  await expect(detail).toContainText("of 9.00M tokens");

  // Paused, nothing moves; resumed, it goes on.
  await detail.getByRole("button", { name: "Pause" }).click();
  await expect(detail.getByText("paused", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Resume" }).click();
  await expect(detail.getByText("active", { exact: true })).toBeVisible();

  await decide(page, "Service API");
  await decide(page, "User guide");
  await expect(card(page, "Web screens")).toContainText("needs decision", { timeout: 30_000 });
  await expect(card(page, "Command line")).toContainText("needs decision");

  // A finished feature is planned again by a new run after the question; it starts once one of
  // the two parallel slots frees.
  await card(page, "User guide").getByRole("button", { name: "Re-plan: User guide" }).click();
  await page
    .getByRole("dialog", { name: "Re-plan feature" })
    .getByRole("button", { name: "Re-plan" })
    .click();
  await expect(card(page, "User guide")).toContainText("ready");
  await decide(page, "Web screens");
  await decide(page, "Command line");
  await expect(card(page, "User guide")).toContainText("needs decision", { timeout: 30_000 });
  await decide(page, "User guide");
  await expect(detail.getByText("completed", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("img", { name: "4 of 4 features done" })).toBeVisible();
  expect(native).toEqual([]);
});

test("a rejected split comes back with the reason, and an edit proposes it again", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted);
  const native = noNativeDialogs(page);
  await openProject(page);
  await startInitiative(page, "shop");
  await page.getByRole("button", { name: "Reject split" }).click();
  const reject = page.getByRole("dialog", { name: "Reject the split" });
  await expect(reject).toContainText("Edit it to propose a new revision");
  await expect(reject.getByRole("button", { name: "Reject split" })).toBeDisabled();
  await reject.getByRole("textbox", { name: "Reason" }).fill("Docs belong in each feature");
  await reject.getByRole("button", { name: "Reject split" }).click();
  const detail = page.getByRole("region", { name: "Scripted initiative initiative" });
  await expect(detail.getByText("split rejected", { exact: true })).toBeVisible();
  await expect(
    detail.getByText(
      "Split rejected: Docs belong in each feature. Edit the split to propose a new revision.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve split" })).toBeHidden();

  await card(page, "User guide").getByRole("button", { name: "Remove: User guide" }).click();
  await page.getByRole("dialog", { name: "Remove feature" }).getByRole("button", { name: "Remove" }).click();
  await expect(card(page, "User guide")).toBeHidden();
  await expect(detail.getByText("approve split", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve split" })).toBeVisible();
  await expect(detail.getByText(/^Split rejected/)).toBeHidden();
  expect(native).toEqual([]);
});
