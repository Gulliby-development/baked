import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { chat } = await import("../src/renderer/client/chat.ts");
const { coordinator } = await import("../src/renderer/client/coordinator.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
const model = await import("../src/renderer/screens/coordinator/model.ts");
delete scope.window;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(25);
  }
}

describe("coordinator client", () => {
  test("opens one coordinator per project, left out of the chat list", async () => {
    const first = await coordinator.open("docs");
    const again = await coordinator.open("docs");
    expect(again.id).toBe(first.id);
    expect(first.mode).toBe("architect");
    const { sessions } = await chat.list("docs", 200);
    expect(sessions.map((s) => s.id)).not.toContain(first.id);
  });

  test("saves a brief edit and refuses one made against an older revision", async () => {
    await coordinator.open("site");
    const brief = await coordinator.brief("site");
    const saved = await coordinator.saveBrief(
      "site",
      model.withList(brief, "conventions", ["  Squash merge only ", "", "x".repeat(1200)]),
      brief.revision,
    );
    expect(saved.revision).toBe(brief.revision + 1);
    expect(saved.conventions).toEqual(["Squash merge only", "x".repeat(model.BRIEF_LINE_MAX)]);
    const stale = coordinator.saveBrief("site", saved, brief.revision);
    await expect(stale).rejects.toBeInstanceOf(ApiError);
    await expect(stale).rejects.toMatchObject({ status: 409 });
  });

  test("an approved split shows its runs and tasks among launched work", async () => {
    const session = await coordinator.open("baked");
    const before = (await coordinator.launched("baked")).launched.length;
    await chat.send("baked", session.id, "Add usage export to the API and the desktop");
    const waiting = await until(
      () => chat.get("baked", session.id),
      (detail) => detail.prompts.some((p) => p.kind === "split"),
    );
    const card = waiting.prompts.find((p) => p.kind === "split");
    if (!card || card.kind !== "split") throw new Error("no split card");
    expect(card.flows.map((f) => f.task)).toEqual(["new issue", "acme/baked#120"]);
    await chat.approve("baked", session.id, card.id, true, card.digest);
    const { launched } = await until(
      () => coordinator.launched("baked"),
      (view) => view.launched.length === before + 2,
    );
    expect(launched.slice(-2).map((l) => [l.kind, l.active, l.task?.ref])).toEqual([
      ["run", true, "acme/baked#231"],
      ["run", true, "acme/baked#120"],
    ]);
    const detail = await until(
      () => chat.get("baked", session.id),
      (d) => d.messages.some((m) => m.launch),
    );
    expect(detail.messages.find((m) => m.launch)?.launch).toMatchObject({
      kind: "run",
      title: "API endpoint",
      status: "waiting: approval",
      event: "status",
    });
  });
});

describe("coordinator workflows", () => {
  test("a fix gets a Run workflow card, and the approved run shows its stages live", async () => {
    const session = await coordinator.open("docs");
    const events: string[] = [];
    const stop = chat.subscribe("docs", session.id, (await chat.get("docs", session.id)).lastSeq, (e) => {
      events.push(e.type);
    });
    await chat.send("docs", session.id, "Fix the failing link check");
    const waiting = await until(
      () => chat.get("docs", session.id),
      (detail) => detail.prompts.some((p) => p.kind === "workflow"),
    );
    const card = waiting.prompts.find((p) => p.kind === "workflow");
    if (!card || card.kind !== "workflow") throw new Error("no workflow card");
    expect(card.workflow).toBe("sdd");
    expect(card.stages[0]).toBe("research");
    await chat.approve("docs", session.id, card.id, true, card.digest);
    const { launched } = await until(
      () => coordinator.launched("docs"),
      (view) => view.launched.some((l) => l.workflow === "sdd"),
    );
    const run = launched.find((l) => l.workflow === "sdd");
    expect(run?.progress?.stages.map((s) => s.id)).toEqual(card.stages);
    await until(
      async () => events,
      (seen) => seen.includes("launched"),
    );
    stop();
  });
});

describe("coordinator screen model", () => {
  test("shows where a launched run is", () => {
    const progress = {
      stage: "plan",
      stages: [
        { id: "research", status: "completed" },
        { id: "spec", status: "skipped" },
        { id: "plan", status: "running" },
        { id: "tasks", status: "pending" },
      ],
      tasks: { done: 2, total: 5 },
    };
    expect(model.stageLooks(progress, true)).toEqual(["done", "skipped", "current", "ahead"]);
    expect(model.stageLooks({ ...progress, stage: null }, false)).toEqual([
      "done",
      "skipped",
      "failed",
      "ahead",
    ]);
    expect(model.stageLine(progress)).toBe("Stage 3 of 4: plan · tasks 2/5");
    expect(model.stageLine({ ...progress, stage: null, tasks: { done: 0, total: 0 } })).toBe(
      "1 of 4 stages done",
    );
  });

  test("has its own project section", () => {
    expect(parseRoute(projectHref("baked", "coordinator"))).toEqual({
      name: "project",
      key: "baked",
      section: "coordinator",
      id: null,
    });
  });

  test("links launched work, names tasks and colours statuses", () => {
    expect(model.launchedHref("baked", { kind: "run", id: "r1" })).toBe("#/p/baked/runs/r1");
    expect(model.launchedHref("baked", { kind: "session", id: "s1" })).toBe("#/p/baked/chat/s1");
    expect(model.launchedHref("baked", { kind: "initiative", id: "i1" })).toBe(
      "#/p/baked/initiatives/i1",
    );
    expect(model.taskLabel({ ref: "acme/baked#120", state: "open" })).toBe("#120");
    expect(model.taskLabel({ ref: "acme/baked#120", state: "closed" })).toBe("#120 (closed)");
    expect(model.taskLabel({ ref: "local:checkout/api", state: "local" })).toBe("local task");
    expect(model.launchedTone({ status: "waiting: approval", active: true })).toBe("warn");
    expect(model.launchedTone({ status: "running", active: true })).toBe("busy");
    expect(model.launchedTone({ status: "failed: check", active: false })).toBe("err");
    expect(model.launchedTone({ status: "completed", active: false })).toBe("ok");
  });

  test("names launched work by its title, not its id", () => {
    const uuid = "e372f9bc-ae25-4098-96b0-3c7188fb7fd3";
    expect(model.launchName({ id: uuid, title: "Deploy to Vercel" })).toBe("Deploy to Vercel");
    expect(model.launchName({ id: uuid })).toBe("e372f9bc");
    expect(model.launchName({ id: "checkout", feature: "api" })).toBe("api");
    expect(model.launchKind({ kind: "session", id: uuid })).toBe("Session");
    expect(model.launchKind({ kind: "initiative", id: "checkout", feature: "api" })).toBe(
      "Feature of checkout",
    );
    expect(model.launchWhy({ title: "API endpoint", why: "API endpoint (split)" })).toBe("");
    expect(model.launchWhy({ title: "Deploy", why: "Publish the page" })).toBe("Publish the page");
    const note = { kind: "run" as const, id: "r1", why: "Ship", status: "completed" };
    expect(model.noteTone({ ...note, event: "status" })).toBe("ok");
    expect(model.noteTone({ ...note, status: "waiting for you", event: "status" })).toBe("warn");
    expect(model.noteTone({ ...note, status: "failed: check", event: "status" })).toBe("err");
    expect(model.noteTone({ ...note, status: "working", event: "status" })).toBe("busy");
    expect(model.noteTone({ ...note, event: "task-closed" })).toBe("ok");
  });

  test("recognises a message the coordinator sent a launched session", () => {
    expect(model.fromCoordinator("Message from the project coordinator:\n\nCheck the CLI")).toBe(
      "Check the CLI",
    );
    expect(model.fromCoordinator("Check the CLI")).toBeNull();
  });

  test("hands a chat's last request to the coordinator", () => {
    const message = (role: "user" | "assistant", content: string) => ({
      id: content,
      role,
      content,
      timestamp: 0,
    });
    expect(
      model.handOffText("Retries", [
        message("user", "First ask"),
        message("assistant", "Done"),
        message("user", "Now split the router work"),
        message("assistant", "Sure"),
      ]),
    ).toBe('Take over this request from the chat "Retries":\n\nNow split the router work');
    expect(model.handOffText("Empty", [])).toBe('Take over the work of the chat "Empty".');
  });
});
