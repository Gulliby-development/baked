import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sharedHandlerCount, subscribeShared } from "../src/hooks/useTerminalEvents.js";

describe("subscribeShared", () => {
  test("many handlers share one emitter listener", () => {
    const emitter = new EventEmitter();
    const offs = Array.from({ length: 50 }, () => subscribeShared(emitter, "resize", () => {}));
    expect(emitter.listenerCount("resize")).toBe(1);
    expect(sharedHandlerCount(emitter, "resize")).toBe(50);
    for (const off of offs) off();
    expect(emitter.listenerCount("resize")).toBe(0);
    expect(sharedHandlerCount(emitter, "resize")).toBe(0);
  });

  test("handlers run in subscription order and receive the event arguments", () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];
    subscribeShared(emitter, "resize", (w, h) => calls.push(`a:${w}x${h}`));
    subscribeShared(emitter, "resize", (w, h) => calls.push(`b:${w}x${h}`));
    emitter.emit("resize", 80, 24);
    expect(calls).toEqual(["a:80x24", "b:80x24"]);
  });

  test("a stopped key event is not passed to later handlers", () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];
    subscribeShared(emitter, "keypress", (key) => {
      calls.push("first");
      (key as { propagationStopped: boolean }).propagationStopped = true;
    });
    subscribeShared(emitter, "keypress", () => calls.push("second"));
    emitter.emit("keypress", { propagationStopped: false });
    expect(calls).toEqual(["first"]);
  });

  test("a handler unsubscribed during dispatch is skipped, others still run", () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];
    let offB = () => {};
    subscribeShared(emitter, "resize", () => {
      calls.push("a");
      offB();
    });
    offB = subscribeShared(emitter, "resize", () => calls.push("b"));
    subscribeShared(emitter, "resize", () => calls.push("c"));
    emitter.emit("resize", 1, 1);
    expect(calls).toEqual(["a", "c"]);
  });

  test("resubscribing after the last handler left attaches a fresh listener", () => {
    const emitter = new EventEmitter();
    subscribeShared(emitter, "keypress", () => {})();
    const calls: number[] = [];
    subscribeShared(emitter, "keypress", () => calls.push(1));
    emitter.emit("keypress", {});
    expect(emitter.listenerCount("keypress")).toBe(1);
    expect(calls).toEqual([1]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("TUI components use the shared keyboard and resize hooks", () => {
  // opentui's own hooks add one listener per mounted component; the TUI keeps
  // its modals mounted, which pushed the count past Node's leak warning.
  const offenders = sourceFiles(join(import.meta.dir, "..", "src")).filter((file) =>
    /import\s*\{[^}]*\b(useKeyboard|useTerminalDimensions|useOnResize)\b[^}]*\}\s*from\s*"@opentui\/react"/.test(
      readFileSync(file, "utf8"),
    ),
  );
  expect(offenders).toEqual([]);
});
