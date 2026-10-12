import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import type { EditorView } from "../src/core/workflows/v2/editor-service.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = workflowFixture();
  const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
  const server = await startApiServer({ service: fixture.service, configDir, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
    await removeTempDir(configDir);
  });
  const post = async <T>(path: string, body: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  };
  type Answer = { view: EditorView; error?: string };
  const edit = (view: EditorView, op?: unknown) =>
    post<Answer>("/v1/workflow/editor", {
      from: view.from,
      ...(view.copy ? { copy: true } : {}),
      definition: view.definition,
      ...(op ? { op } : {}),
    });
  return { fixture, post, edit };
}

describe("workflow editor over the local API", () => {
  test("opens a preset read only, duplicates it, edits and saves it, then reopens the file", async () => {
    const { fixture, post, edit } = await setup();
    const opened = await post<{ view: EditorView }>("/v1/workflow/editor", { from: "quick-fix" });
    expect(opened.status).toBe(200);
    expect(opened.body.view.readOnly).toContain("read only");
    expect(opened.body.view.stages.map((s) => s.id)).toContain("approve");

    const refused = await edit(opened.body.view, { op: "changeField", stageId: "approve", key: "decision", delta: 1 });
    expect(refused.body.error).toContain("read only");

    const copy = (await edit(opened.body.view, { op: "duplicate" })).body.view;
    expect([copy.id, copy.copy, copy.readOnly, copy.dirty]).toEqual(["quick-fix-custom", true, null, true]);
    expect(copy.problems).toEqual([]);

    const auto = (await edit(copy, { op: "changeField", stageId: "approve", key: "decision", delta: 1 })).body.view;
    expect(auto.stages.find((s) => s.id === "approve")?.fields.find((f) => f.key === "decision")?.value).toBe("auto");

    type Review = { review: { kind: string; path: string; diff: string[]; gates: string[]; autoApproval: { prefix: string; limits: string } | null } };
    const review = await post<Review>("/v1/workflow/editor/review", { from: auto.from, copy: true, definition: auto.definition });
    expect(review.body.review.kind).toBe("review");
    expect(review.body.review.diff.every((line) => line.startsWith("+"))).toBe(true);
    expect(review.body.review.autoApproval?.limits).toContain("at most 3 tasks");
    // Auto approval needs its limits confirmed with the typed hash prefix.
    type Saved = { saved: boolean; path?: string; confirmationNeeded?: boolean; review?: { kind: string; autoApproval: { prefix: string } | null }; view: EditorView };
    const body = { from: auto.from, copy: true, definition: auto.definition };
    const unconfirmed = await post<Saved>("/v1/workflow/editor/save", body);
    expect(unconfirmed.body).toMatchObject({ saved: false, confirmationNeeded: true });
    const prefix = unconfirmed.body.review?.autoApproval?.prefix ?? "";
    expect(prefix).toHaveLength(12);
    const saved = await post<Saved>("/v1/workflow/editor/save", { ...body, confirm: prefix });
    expect(saved.body.saved).toBe(true);
    const file = join(fixture.root, "baked", "workflows", "quick-fix-custom.json");
    expect(saved.body.path).toBe(file);
    expect(existsSync(file)).toBe(true);
    expect(saved.body.view).toMatchObject({ id: "quick-fix-custom", from: "quick-fix-custom", copy: false, dirty: false, readOnly: null });

    const reopened = await post<{ view: EditorView }>("/v1/workflow/editor", { from: "quick-fix-custom" });
    expect(JSON.parse(readFileSync(file, "utf8")).autoApproval).toMatchObject({ enabled: true });
    expect(reopened.body.view.dirty).toBe(false);
    const unchanged = await post<Saved>("/v1/workflow/editor/save", { from: "quick-fix-custom", definition: reopened.body.view.definition });
    expect(unchanged.body).toMatchObject({ saved: false, review: { kind: "unchanged" } });
  });

  test("a broken working copy reports problems by stage and is not saved", async () => {
    const { post, edit } = await setup();
    const opened = (await post<{ view: EditorView }>("/v1/workflow/editor", { from: "quick-fix" })).body.view;
    const copy = (await edit(opened, { op: "duplicate" })).body.view;
    const done = copy.stages.flatMap((s) => s.targets).find((t) => t.transition?.to === "done");
    if (done?.target.kind !== "transition") throw new Error("No transition to done");
    const broken = (await edit(copy, { op: "removeTransition", id: done.target.id })).body.view;
    expect(broken.problems.length).toBeGreaterThan(0);
    const refused = await post<{ saved: boolean; review: { kind: string } }>("/v1/workflow/editor/save", {
      from: broken.from,
      copy: true,
      definition: broken.definition,
    });
    expect(refused.body).toMatchObject({ saved: false, review: { kind: "problems" } });

    expect((await post("/v1/workflow/editor", { from: "nope" })).status).toBe(404);
    const renamed = await post("/v1/workflow/editor", { from: "quick-fix", definition: { ...opened.definition, id: "other" } });
    expect(renamed.status).toBe(400);
  });
});
