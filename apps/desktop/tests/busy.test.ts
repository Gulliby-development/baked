import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { kneadPose, proofPose } from "../src/renderer/components/ui/bun.tsx";
import { Busy } from "../src/renderer/components/ui/busy.tsx";
import { Skeleton } from "../src/renderer/components/ui/skeleton.tsx";

describe("bun scenes", () => {
  test("kneading squashes the dough and springs back each cycle", () => {
    expect(kneadPose(0).rise).toBe(1);
    expect(kneadPose(700).rise).toBeCloseTo(0.45);
    expect(kneadPose(1400).rise).toBeCloseTo(1);
  });

  test("proofing rises and browns with the work done", () => {
    const early = proofPose(0.1, 0);
    const late = proofPose(0.9, 0);
    expect(late.rise).toBeGreaterThan(early.rise);
    expect(late.bake).toBeGreaterThan(early.bake);
    expect(proofPose(1, 0).face).toBe("happy");
  });
});

describe("waits", () => {
  test("a counted wait shows a bar and the count", () => {
    const html = renderToStaticMarkup(
      createElement(Busy, { label: "Indexing files", done: 412, total: 1380, unit: "files" }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Indexing files");
    expect(html).toContain("412 / 1,380 files");
    expect(html).toContain("<svg");
  });

  test("an uncounted wait has no bar", () => {
    const html = renderToStaticMarkup(createElement(Busy, { label: "Starting the run" }));
    expect(html).not.toContain("progress");
    expect(html).not.toContain(" / ");
  });

  test("a skeleton names what loads and stops pulsing with reduced motion", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { lines: 2, label: "Loading runs" }));
    expect(html).toContain('aria-label="Loading runs"');
    expect(html.match(/motion-reduce:animate-none/g)?.length).toBe(2);
  });
});
