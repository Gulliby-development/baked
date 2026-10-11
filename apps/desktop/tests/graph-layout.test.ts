import { describe, expect, test } from "bun:test";
import type { GraphAnswer } from "../src/renderer/client/graph.ts";
import { graphRoutes } from "../src/renderer/client/mock-graph.ts";
import { href, parseRoute } from "../src/renderer/router.ts";
import {
  type Box,
  chipGrid,
  exitDistance,
  formatCount,
  gridHomes,
  isInside,
  rectCollide,
  visibleEdges,
  waffle,
} from "../src/renderer/screens/graph/layout.ts";

async function mockView(key: string, body: object = {}) {
  const answer = await graphRoutes({
    key,
    method: "POST",
    path: "/v1/graph",
    query: new URLSearchParams(),
    body,
  });
  const graph = answer?.body as GraphAnswer;
  if (graph.state !== "ready") throw new Error("mock graph is not ready");
  return graph.view;
}

describe("graph layout helpers", () => {
  test("rectangle collision separates overlapping blocks", () => {
    const boxes: Box[] = [
      { id: "a", w: 100, h: 40, x: 0, y: 0 },
      { id: "b", w: 100, h: 40, x: 10, y: 5 },
    ];
    const force = rectCollide<Box>(8);
    force.initialize(boxes);
    force();
    const [a, b] = boxes as [Box, Box];
    const overlapX = (a.w + b.w) / 2 + 8 - Math.abs(b.x - a.x);
    const overlapY = (a.h + b.h) / 2 + 8 - Math.abs(b.y - a.y);
    expect(overlapX <= 0.001 || overlapY <= 0.001).toBe(true);
  });

  test("pinned blocks do not move", () => {
    const boxes: Box[] = [
      { id: "a", w: 50, h: 50, x: 0, y: 0, fx: 0, fy: 0 },
      { id: "b", w: 50, h: 50, x: 5, y: 0 },
    ];
    const force = rectCollide<Box>(0);
    force.initialize(boxes);
    force();
    expect(boxes[0]?.x).toBe(0);
    expect(boxes[1]?.x).toBe(50);
  });

  test("grid homes are centred, distinct and nearest first", () => {
    const homes = gridHomes(9, 100, 50);
    expect(homes).toHaveLength(9);
    expect(new Set(homes.map((h) => h.join())).size).toBe(9);
    const dist = homes.map(([x, y]) => Math.hypot(x / 1.5, y));
    expect(dist).toEqual(dist.slice().sort((p, q) => p - q));
    const sx = homes.reduce((s, h) => s + h[0], 0);
    expect(Math.abs(sx)).toBeLessThan(1e-9);
  });

  test("chip grid and exit distance", () => {
    expect(chipGrid(5, 24)).toEqual([
      [0, 0],
      [24, 0],
      [48, 0],
      [72, 0],
      [0, 24],
    ]);
    expect(exitDistance(100, 40, 1, 0, 0)).toBe(50);
    expect(exitDistance(100, 40, 0, 1, 0)).toBe(20);
  });

  test("waffle squares and counts", () => {
    expect(waffle(10, 2, 200)).toMatchObject({ count: 10, keyed: 2, per: 1 });
    const big = waffle(5000, 40, 200);
    expect(big.count).toBeLessThanOrEqual(big.cols * 3);
    expect(formatCount(944)).toBe("944");
    expect(formatCount(54_700)).toBe("54.7k");
    expect(formatCount(2_800_000)).toBe("2.8M");
  });

  test("the graph section has a route", () => {
    expect(parseRoute("#/p/baked/graph")).toEqual({ name: "project", key: "baked", section: "graph", id: null });
    expect(href({ name: "project", key: "baked", section: "graph", id: null })).toBe("#/p/baked/graph");
  });
});

describe("graph mock and edge pruning", () => {
  test("the sample projects cover tiny, real and huge graphs", async () => {
    const tiny = await mockView("docs");
    expect(tiny.flat).toBe(true);
    expect(tiny.units).toHaveLength(9);
    const real = await mockView("baked");
    expect(real.flat).toBe(false);
    expect(real.stats.files).toBeGreaterThan(500);
    const huge = await mockView("site");
    expect(huge.stats.files).toBeGreaterThan(20_000);
    expect(huge.units.length).toBeLessThan(40);
  });

  test("each block keeps a few links and the selected block keeps all", async () => {
    const view = await mockView("baked");
    const shown = visibleEdges(view, null, null, null);
    expect(shown.length).toBeLessThanOrEqual(view.edges.length);
    expect(shown.length).toBeGreaterThan(0);
    const busiest = view.units
      .map((u) => ({ id: u.id, n: view.edges.filter((e) => e.from === u.id || e.to === u.id).length }))
      .sort((a, b) => b.n - a.n)[0];
    if (!busiest) throw new Error("no units");
    const selected = visibleEdges(view, null, busiest.id, null);
    const touching = view.edges.filter((e) => e.from === busiest.id || e.to === busiest.id);
    for (const e of touching) expect(selected).toContain(e);
  });

  test("opening a folder nests its blocks inside it", async () => {
    const top = await mockView("baked");
    const dir = top.units.find((u) => u.kind === "dir" && u.files > 50);
    if (!dir) throw new Error("no big folder");
    const open = await mockView("baked", { expanded: [dir.id] });
    const inside = open.units.filter((u) => isInside(open, u.id, dir.id));
    expect(inside.length).toBeGreaterThan(1);
    expect(open.units.filter((u) => !isInside(open, u.id, dir.id)).length).toBeGreaterThan(0);
  });
});
