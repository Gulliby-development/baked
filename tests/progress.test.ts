import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import {
  indexProgress,
  type ProgressItem,
  ProgressTracker,
  progress,
  progressLine,
} from "../src/core/progress.js";
import { followProgress } from "../src/headless/progress.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("progress tracker", () => {
  test("keeps one item per id, notifies on change and drops ended work", () => {
    const tracker = new ProgressTracker();
    const seen: ProgressItem[][] = [];
    const unsubscribe = tracker.subscribe((items) => seen.push(items));
    tracker.set("index", "Indexing files", { done: 0, total: 10 });
    const startedAt = tracker.list()[0]?.startedAt;
    tracker.set("index", "Indexing files", { done: 0, total: 10 });
    tracker.set("index", "Indexing files", { done: 5, total: 10 });
    expect(seen.length).toBe(2);
    expect(tracker.list()).toEqual([
      { id: "index", task: "index", label: "Indexing files", done: 5, total: 10, startedAt: startedAt ?? "" },
    ]);
    tracker.set("index", "Building edges");
    expect(tracker.list()[0]).toMatchObject({ label: "Building edges", done: null, total: null });
    tracker.end("index");
    tracker.end("index");
    expect(seen.at(-1)).toEqual([]);
    expect(seen.length).toBe(4);
    unsubscribe();
    tracker.set("open", "Opening the project");
    expect(seen.length).toBe(4);
  });

  test("track ends the item when the work fails", async () => {
    const tracker = new ProgressTracker();
    await expect(
      tracker.track("run-start", "Starting the run", async () => {
        expect(tracker.list().map((item) => item.task)).toEqual(["run-start"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(tracker.list()).toEqual([]);
  });

  test("translates repository map progress into counts and phase labels", () => {
    expect(indexProgress(412, 1380)).toEqual({ label: "Indexing files", counts: { done: 412, total: 1380 } });
    expect(indexProgress(-2, -2)).toEqual({ label: "Building the call graph", counts: null });
    expect(indexProgress(-9, -9).label).toBe("Indexing the project");
    const item: ProgressItem = {
      id: "index",
      task: "index",
      label: "Indexing files",
      done: 412,
      total: 1380,
      startedAt: "",
    };
    expect(progressLine(item)).toBe("Indexing files 412/1,380");
    expect(progressLine({ ...item, done: null, total: null })).toBe("Indexing files");
  });
});

describe("headless progress lines", () => {
  test("prints new labels at once and counts at most every two seconds", () => {
    const tracker = new ProgressTracker();
    const lines: string[] = [];
    let clock = 0;
    tracker.set("open", "Opening the project");
    const stop = followProgress((line) => lines.push(line), tracker, () => clock);
    tracker.set("index", "Indexing files", { done: 0, total: 100 });
    tracker.set("index", "Indexing files", { done: 5, total: 100 });
    clock = 2500;
    tracker.set("index", "Indexing files", { done: 50, total: 100 });
    tracker.set("index", "Building edges");
    tracker.end("open");
    stop();
    tracker.set("index", "Linking tests");
    expect(lines).toEqual([
      "Opening the project",
      "Indexing files 0/100",
      "Indexing files 50/100",
      "Building edges",
    ]);
  });
});

describe("progress over the local API", () => {
  test("answers the current work as JSON and streams changes", async () => {
    const fixture = workflowFixture();
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
    const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, homeDir, log: () => {} });
    cleanups.push(async () => {
      progress.end("index");
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
      await removeTempDir(homeDir);
    });
    const call = (path: string, accept = "application/json") =>
      fetch(`${server.url}${path}`, { headers: { Authorization: `Bearer ${server.token}`, Accept: accept } });

    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("progress");
    progress.set("index", "Indexing files", { done: 3, total: 9 });
    const answer = (await (await call("/v1/progress")).json()) as { items: ProgressItem[] };
    expect(answer.items).toEqual([expect.objectContaining({ task: "index", done: 3, total: 9 })]);

    const stream = await call("/v1/progress", "text/event-stream");
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("no stream body");
    const decoder = new TextDecoder();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += decoder.decode(value);
      }
    };
    await until('"done":3');
    progress.set("index", "Building edges");
    await until("Building edges");
    expect(text).toContain("event: progress");
    await reader.cancel();
    expect((await fetch(`${server.url}/v1/progress`, { method: "POST", headers: { Authorization: `Bearer ${server.token}` } })).status).toBe(405);
  });
});
