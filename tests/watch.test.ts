import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitFileEdited } from "../src/core/tools/file-events.ts";
import { WATCH_DEFAULTS, watchOptions } from "../src/core/watch/config.ts";
import { WatchController, type WatchTurn } from "../src/core/watch/controller.ts";
import { markerIn, parseMarkers } from "../src/core/watch/markers.ts";
import { buildWatchPrompt, triggerLabel } from "../src/core/watch/prompt.ts";
import { MarkerTracker } from "../src/core/watch/trigger.ts";
import { FileWatcher, isWatchedPath, watchIgnore } from "../src/core/watch/watcher.ts";
import { parseHeadlessArgs } from "../src/headless/parse.ts";
import { watchPromptSource } from "../src/headless/watch.ts";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-watch-"));
  dirs.push(dir);
  return dir;
}

const kinds = (path: string, text: string) =>
  parseMarkers(path, text).map((m) => [m.kind, m.line, m.text]);

describe("marker comments", () => {
  test("act, ask and context markers in line comments of several languages", () => {
    expect(kinds("a.ts", "// baked! extract this\nconst x = 1;")).toEqual([
      ["act", 1, "extract this"],
    ]);
    expect(kinds("a.py", "x = 1  # why twice baked?")).toEqual([["ask", 1, "why twice"]]);
    expect(kinds("q.sql", "-- BAKED! add an index\nselect 1;")).toEqual([
      ["act", 1, "add an index"],
    ]);
    expect(kinds("c.yaml", "# baked: the staging values")).toEqual([
      ["context", 1, "the staging values"],
    ]);
    expect(kinds("x.el", "; baked? what calls this")).toEqual([["ask", 1, "what calls this"]]);
  });

  test("block comments in C-like, markup and CSS files", () => {
    expect(kinds("a.go", "/* baked! use a map */")).toEqual([["act", 1, "use a map"]]);
    expect(kinds("README.md", "# Title\n<!-- baked! shorten this -->")).toEqual([
      ["act", 2, "shorten this"],
    ]);
    expect(kinds("s.css", "a { color: red; } /* baked? why red */")).toEqual([
      ["ask", 1, "why red"],
    ]);
    expect(kinds("j.java", "/**\n * baked! make it final\n */")).toEqual([
      ["act", 1, "make it final"],
    ]);
  });

  test("consecutive comment lines form one request; a trailing comment stands alone", () => {
    const text = "// baked! extract this\n// into a hook\nf(); // baked? why\n";
    expect(parseMarkers("a.ts", text)).toEqual([
      { kind: "act", line: 1, endLine: 2, text: "extract this\ninto a hook" },
      { kind: "ask", line: 3, endLine: 3, text: "why" },
    ]);
  });

  test("strings, URLs and prose do not count", () => {
    expect(parseMarkers("a.ts", 'const s = "// baked! no";')).toEqual([]);
    expect(parseMarkers("a.ts", "const t = `\n// baked! no\n`;")).toEqual([]);
    expect(parseMarkers("a.py", '"""\n# baked! no\n"""\nx = "# baked?"')).toEqual([]);
    expect(parseMarkers("a.ts", 'fetch("http://x.dev//baked!")')).toEqual([]);
    expect(parseMarkers("a.ts", "// we baked the bread for ten minutes")).toEqual([]);
    expect(parseMarkers("a.ts", "// half-baked! idea")).toEqual([]);
    expect(markerIn("bakedgoods!")).toBeNull();
  });

  test("unknown file types match whole lines that start or end with the marker", () => {
    expect(kinds("notes.unknown", "intro\nbaked! rewrite the intro\n")).toEqual([
      ["act", 2, "rewrite the intro"],
    ]);
  });

  test("a configured marker word replaces baked", () => {
    expect(parseMarkers("a.ts", "// ai! do it", "ai").map((m) => m.kind)).toEqual(["act"]);
    expect(parseMarkers("a.ts", "// baked! do it", "ai")).toEqual([]);
  });
});

describe("triggers", () => {
  test("only a newly added request starts a turn, with pending context", () => {
    const tracker = new MarkerTracker();
    expect(tracker.update([{ path: "a.ts", text: "// baked: uses the v2 API" }])).toBeNull();
    const first = tracker.update([{ path: "b.ts", text: "// baked! call it here" }]);
    expect(first?.requests.map((r) => [r.path, r.text])).toEqual([["b.ts", "call it here"]]);
    expect(first?.context.map((c) => c.text)).toEqual(["uses the v2 API"]);
    // Code above the marker moved it down a line: not new.
    expect(tracker.update([{ path: "b.ts", text: "x();\n// baked! call it here" }])).toBeNull();
    // Removing it, as the agent does, triggers nothing.
    expect(tracker.update([{ path: "b.ts", text: "x();" }])).toBeNull();
    // A new question does.
    const ask = tracker.update([{ path: "b.ts", text: "x(); // baked? why x" }]);
    expect(ask?.requests.map((r) => r.kind)).toEqual(["ask"]);
    expect(ask?.context).toEqual([]);
  });

  test("files BAKED wrote are remembered without a turn", () => {
    const tracker = new MarkerTracker();
    tracker.remember("a.ts", "// baked! old");
    expect(tracker.update([{ path: "a.ts", text: "// baked! old\nx();" }])).toBeNull();
  });

  test("the prompt quotes each request with its code and says what to do", () => {
    const tracker = new MarkerTracker();
    const text = "function f() {\n  // baked! return early\n  return 1;\n}";
    const trigger = tracker.update([{ path: "src/f.ts", text }]);
    if (!trigger) throw new Error("no trigger");
    expect(triggerLabel(trigger)).toBe("src/f.ts:2 (baked!)");
    const prompt = buildWatchPrompt(trigger, () => text);
    expect(prompt).toContain("## src/f.ts:2 (baked!)");
    expect(prompt).toContain("> return early");
    expect(prompt).toContain("2    // baked! return early");
    expect(prompt).toContain("then remove the `baked!` comment lines you handled");

    const ask = new MarkerTracker().update([{ path: "q.py", text: "# baked? why" }]);
    if (!ask) throw new Error("no trigger");
    expect(buildWatchPrompt(ask, () => null)).toContain("without editing files");
    expect(buildWatchPrompt(ask, () => null, { removeAnswered: true })).toContain(
      "remove the `baked?` comment lines you answered",
    );
  });
});

describe("watch options and ignore rules", () => {
  test("defaults and clamps", () => {
    expect(watchOptions(undefined)).toEqual(WATCH_DEFAULTS);
    expect(watchOptions({ debounceMs: 1, marker: "two words", poll: true })).toMatchObject({
      debounceMs: 50,
      marker: "baked",
      poll: true,
    });
  });

  test("skips dependency, build and BAKED folders and the project's ignore files", () => {
    const root = project();
    writeFileSync(join(root, ".gitignore"), "generated/\n*.log\n");
    writeFileSync(join(root, ".bakedignore"), "fixtures/\n");
    const matcher = watchIgnore(root, ["secret.txt"]);
    expect(isWatchedPath("src/a.ts", matcher)).toBe(true);
    for (const skipped of [
      "node_modules/x/index.js",
      ".git/HEAD",
      ".baked/state.db",
      "dist/a.js",
      "generated/a.ts",
      "debug.log",
      "fixtures/a.ts",
      "secret.txt",
    ])
      expect(isWatchedPath(skipped, matcher)).toBe(false);
  });
});

describe("watch controller", () => {
  function controller(root: string) {
    const turns: WatchTurn[] = [];
    const watch = new WatchController(root, WATCH_DEFAULTS, { send: (t) => turns.push(t) });
    return { watch, turns };
  }

  test("a saved request becomes one turn; BAKED's own write of the file does not", () => {
    const root = project();
    const { watch, turns } = controller(root);
    watch.start();
    stops.push(() => watch.stop());
    writeFileSync(join(root, "a.ts"), "// baked! add a test\nexport const a = 1;\n");
    watch.batch(["a.ts"]);
    expect(turns.map((t) => [t.label, t.kind])).toEqual([["a.ts:1 (baked!)", "act"]]);

    // The agent writes the file with a new marker it was asked to keep: no second turn.
    const agentText = "// baked! a marker the agent wrote\nexport const a = 1;\n";
    writeFileSync(join(root, "a.ts"), agentText);
    emitFileEdited(join(root, "a.ts"), agentText);
    watch.batch(["a.ts"]);
    expect(turns).toHaveLength(1);
  });

  test("binary and large files are not read", () => {
    const root = project();
    const { watch, turns } = controller(root);
    writeFileSync(join(root, "b.ts"), Buffer.from([0, 1, 2, 0, 98, 97, 107, 101, 100, 33]));
    writeFileSync(join(root, "big.ts"), `// baked! too big\n${"x".repeat(1024 * 1024)}`);
    watch.batch(["b.ts", "big.ts"]);
    expect(turns).toEqual([]);
  });

  test("native file events reach the controller after the debounce", async () => {
    const root = project();
    mkdirSync(join(root, "src"));
    const got = new Promise<WatchTurn>((resolve) => {
      const watch = new WatchController(
        root,
        { ...WATCH_DEFAULTS, debounceMs: 50 },
        { send: resolve },
      );
      watch.start();
      stops.push(() => watch.stop());
    });
    await Bun.sleep(100);
    writeFileSync(join(root, "src", "x.ts"), "// baked? what is x\n");
    const turn = await Promise.race([
      got,
      Bun.sleep(5000).then(() => {
        throw new Error("no turn within 5 s");
      }),
    ]);
    expect(turn.label).toBe("src/x.ts:1 (baked?)");
  });

  test("polling finds changes where file events are not used", async () => {
    const root = project();
    writeFileSync(join(root, "a.ts"), "export {};\n");
    const batches: string[][] = [];
    const watcher = new FileWatcher({
      root,
      ignore: [],
      debounceMs: 50,
      poll: true,
      onBatch: (paths) => batches.push(paths),
    });
    expect(watcher.start()).toBe("poll");
    stops.push(() => watcher.stop());
    await Bun.sleep(50);
    writeFileSync(join(root, "a.ts"), "// baked! now\nexport {};\n");
    writeFileSync(join(root, "node_modules.ts"), "x");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "skip.js"), "// baked! no");
    for (let i = 0; i < 40 && batches.length === 0; i++) await Bun.sleep(100);
    expect(batches[0]).toEqual(["a.ts", "node_modules.ts"]);
  });
});

describe("headless --watch", () => {
  test("--watch starts a chat whose prompts come from the watch", async () => {
    const action = await parseHeadlessArgs(["--headless", "--watch"]);
    expect(action).toMatchObject({ type: "chat", opts: { watch: true, watchPoll: false } });
    const poll = await parseHeadlessArgs(["--headless", "--watch-poll"]);
    expect(poll).toMatchObject({ type: "chat", opts: { watch: true, watchPoll: true } });
  });

  test("the prompt source hands out turns in order and ends when closed", async () => {
    const root = project();
    const events: string[] = [];
    const seen: string[] = [];
    const source = watchPromptSource(
      root,
      { debounceMs: 50 },
      { onEvent: (e) => events.push(e.type), onTurn: (t) => seen.push(t.label) },
    );
    stops.push(source.close);
    await Bun.sleep(100);
    writeFileSync(join(root, "a.ts"), "// baked! first\n");
    await Bun.sleep(400);
    writeFileSync(join(root, "b.ts"), "// baked? second\n");
    await Bun.sleep(400);
    const first = await source.next();
    const second = await source.next();
    expect(first).toContain("a.ts:1 (baked!)");
    expect(second).toContain("b.ts:1 (baked?)");
    expect(seen).toEqual(["a.ts:1 (baked!)", "b.ts:1 (baked?)"]);
    const pending = source.next();
    source.close();
    expect(await pending).toBeNull();
    expect(events).toEqual(["started", "triggered", "triggered", "stopped"]);
  });
});
