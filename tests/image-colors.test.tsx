import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ImageDisplay } from "../src/components/chat/ImageDisplay.js";
import { styleImageLines } from "../src/components/chat/image-colors.js";

test("half-block images preserve both pixel colors and reset between runs", () => {
  const [line] = styleImageLines(["\x1b[38;2;255;80;20m\x1b[48;2;10;20;30m▀\x1b[0m plain"]);
  expect(line?.chunks[0]?.fg?.toInts()).toEqual([255, 80, 20, 255]);
  expect(line?.chunks[0]?.bg?.toInts()).toEqual([10, 20, 30, 255]);
  expect(line?.chunks[1]?.fg).toBeUndefined();
  expect(line?.chunks[1]?.bg).toBeUndefined();
  expect(line?.chunks.map(chunk => chunk.text).join("")).toBe("▀ plain");
});

test("chafa colors carry over rows and support indexed and reversed cells", () => {
  const [first, second] = styleImageLines(["\x1b[38;5;196;48;5;21m▀", "▄\x1b[7m▀\x1b[27;39;49m."]);
  expect(first?.chunks[0]?.fg?.toInts()).toEqual([255, 0, 0, 255]);
  expect(second?.chunks[0]?.fg?.toInts()).toEqual([255, 0, 0, 255]);
  expect(second?.chunks[1]?.fg?.toInts()).toEqual([0, 0, 255, 255]);
  expect(second?.chunks[1]?.bg?.toInts()).toEqual([255, 0, 0, 255]);
  expect(second?.chunks[2]?.fg).toBeUndefined();
  expect(second?.chunks[2]?.bg).toBeUndefined();
});

test("image controls are consumed without leaking escape codes into text", () => {
  const [line] = styleImageLines(["\x1b[?25l\x1b[91;104m▀\x1b[m\x1b[2K end"]);
  expect(line?.chunks.map(chunk => chunk.text).join("")).toBe("▀ end");
  expect(line?.chunks.find(chunk => chunk.text === "▀")?.fg).toBeDefined();
});

test("chat renders colored image art using standard OpenTUI elements", async () => {
  const view = await testRender(
    <ImageDisplay img={{ name: "bread.png", width: 1, height: 2, lines: ["\x1b[38;2;255;80;20m▀\x1b[0m"] }} />,
    { width: 40, height: 6 },
  );
  try {
    await act(async () => { await view.flush(); await view.renderOnce(); });
    const frame = view.captureCharFrame();
    expect(frame).toContain("bread.png");
    expect(frame).toContain("▀");
    expect(frame).not.toContain("38;2");
    expect(frame).not.toContain("Error:");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});
