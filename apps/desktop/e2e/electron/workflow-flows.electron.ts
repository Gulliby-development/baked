import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * Workflow runs against the repository's own `baked serve`, whose run agent is scripted
 * (BAKED_TEST_WORKFLOW, `src/core/workflows/scripted-executor.ts`): every stage, approval,
 * check and event is the real runtime's. The scripted task writes `e2e-output.txt`.
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

test("a run from New run waits for its approval, then builds, checks and completes", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted());
  await openProject(page);
  await nav(page).getByRole("link", { name: "New run" }).click();
  const form = page.getByRole("form", { name: "New workflow run" });
  await form.getByRole("textbox", { name: "What should change?" }).fill("Write the output file");
  await form.getByRole("button", { name: /^quick/ }).click();
  await form.getByRole("button", { name: "Start run" }).click();

  // The run waits for a person before it writes anything.
  const part = page.getByRole("region", { name: "Your part" });
  await expect(part.getByRole("heading", { name: /wait for your approval/ })).toBeVisible();
  expect(existsSync(join(root, "e2e-output.txt"))).toBe(false);
  await part.getByRole("button", { name: "Approve and implement" }).click();

  const done = page.getByRole("list", { name: "Stages" }).getByRole("button", { name: /^Done finish/ });
  await expect(done).toHaveAccessibleName(/, done$/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Fork run" })).toBeVisible();
  expect(readFileSync(join(root, "e2e-output.txt"), "utf8")).toBe("ready");

  // The finished run is in the run list.
  await page.getByRole("link", { name: "All runs" }).click();
  await expect(page.getByText("write-the-output-file").first()).toBeVisible();
});

test("the coordinator starts a run after its card, and the run's news comes back to it", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch({
    ...scripted(),
    script: {
      delayMs: 2,
      turns: [
        {
          when: "write the output",
          steps: [
            { text: "Starting a run. " },
            {
              tool: "start_run",
              input: { prompt: "Write the output file", workflow: "quick", why: "a small change" },
              run: true,
            },
          ],
        },
        ...Array.from({ length: 8 }, () => ({ steps: [{ text: "Noted the run." }] })),
      ],
    },
  });
  await openProject(page);
  const conversation = page.getByRole("region", { name: "Conversation" });
  const launched = page.getByRole("region", { name: "Launched work" });
  const composer = page.getByRole("textbox", { name: "Message BAKED" });
  await composer.fill("Please write the output file");
  await composer.press("Enter");

  const proposal = conversation.getByRole("region", { name: "Workflow proposal" });
  await expect(proposal).toContainText("Run workflow quick?");
  await proposal.getByRole("button", { name: "Run workflow" }).click();

  // The run shows in Launched work; it waits for its plan approval, which the person gives
  // in the run's own window.
  const item = launched.getByRole("listitem").filter({ hasText: "Write the output file" });
  await expect(item).toBeVisible();
  await expect(item).toContainText(/waiting/i, { timeout: 15_000 });
  await item.getByRole("link").first().click();
  const part = page.getByRole("region", { name: "Your part" });
  await part.getByRole("button", { name: "Approve and implement" }).click();
  await expect(
    page.getByRole("list", { name: "Stages" }).getByRole("button", { name: /^Done finish/ }),
  ).toHaveAccessibleName(/, done$/, { timeout: 30_000 });

  // Back in the coordinator: the run is done and the coordinator took a turn on the news.
  await nav(page).getByRole("link", { name: "Coordinator" }).click();
  await expect(item).toContainText(/done|completed/i, { timeout: 15_000 });
  await expect(conversation.getByText("Noted the run.").first()).toBeVisible();
  expect(readFileSync(join(root, "e2e-output.txt"), "utf8")).toBe("ready");
});

test("a workflow duplicated in the editor is saved to the project and runs", async ({
  workspace,
  launch,
}) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted());
  await openProject(page);
  await nav(page).getByRole("link", { name: "Workflows" }).click();
  await page.getByRole("link", { name: "quick", exact: true }).click();
  await page.getByRole("button", { name: "Duplicate as custom" }).click();
  await expect(page.getByRole("heading", { name: "quick-custom", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Save…" }).click();
  await page.getByRole("dialog", { name: "Write the workflow file?" }).getByRole("button", { name: "Write file" }).click();
  await expect(page.getByText("baked/workflows/quick-custom.json", { exact: true })).toBeVisible();
  expect(existsSync(join(root, "baked", "workflows", "quick-custom.json"))).toBe(true);

  await nav(page).getByRole("link", { name: "New run" }).click();
  const form = page.getByRole("form", { name: "New workflow run" });
  await form.getByRole("textbox", { name: "What should change?" }).fill("Write the output file");
  await form.getByRole("button", { name: /^More workflows/ }).click();
  await form.getByRole("button", { name: /^quick-custom \(project\)/ }).click();
  await form.getByRole("button", { name: "Start run" }).click();
  await page.getByRole("region", { name: "Your part" }).getByRole("button", { name: "Approve and implement" }).click();
  await expect(
    page.getByRole("list", { name: "Stages" }).getByRole("button", { name: /^Done finish/ }),
  ).toHaveAccessibleName(/, done$/, { timeout: 30_000 });
  expect(readFileSync(join(root, "e2e-output.txt"), "utf8")).toBe("ready");
});

test("two runs in their own worktrees work at the same time", async ({ workspace, launch }) => {
  const root = workspace.project("gamma");
  runnableProject(root);
  const { page } = await launch(scripted(400));
  await openProject(page);
  for (const name of ["Write the first file", "Write the second file"]) {
    await nav(page).getByRole("link", { name: "New run" }).click();
    const form = page.getByRole("form", { name: "New workflow run" });
    await form.getByRole("textbox", { name: "What should change?" }).fill(name);
    await form.getByRole("button", { name: /^quick/ }).click();
    await form.getByRole("group").filter({ hasText: "Oven settings" }).click();
    await form.getByRole("checkbox", { name: "Run in a Git worktree" }).check();
    await form.getByRole("button", { name: "Start run" }).click();
    await expect(page.getByRole("region", { name: "Your part" })).toBeVisible({ timeout: 15_000 });
  }
  // Both wait for their approval at the same time; each is approved in its own window.
  for (const slug of ["write-the-first-file", "write-the-second-file"])
    await expect(nav(page).getByRole("link", { name: `${slug} approve` })).toBeVisible();
  for (const slug of ["write-the-first-file", "write-the-second-file"]) {
    await nav(page).getByRole("link", { name: new RegExp(`^${slug}`) }).click();
    await page.getByRole("region", { name: "Your part" }).getByRole("button", { name: "Approve and implement" }).click();
    await expect(page.getByRole("region", { name: "Your part" })).toBeHidden();
  }
  // The second run starts while the first still builds, and both finish.
  for (const slug of ["write-the-first-file", "write-the-second-file"]) {
    await nav(page).getByRole("link", { name: new RegExp(`^${slug}`) }).click();
    await expect(
      page.getByRole("list", { name: "Stages" }).getByRole("button", { name: /^Done finish/ }),
    ).toHaveAccessibleName(/, done$/, { timeout: 30_000 });
  }
  // The main checkout is untouched: each run wrote in its own worktree.
  expect(existsSync(join(root, "e2e-output.txt"))).toBe(false);
});
