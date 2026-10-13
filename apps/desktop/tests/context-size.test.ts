import { describe, expect, test } from "bun:test";
import { formatWindow } from "../src/renderer/screens/chat/ContextSizeMenu.tsx";

describe("context size picker", () => {
  test("shows windows in k below a million and in M above", () => {
    expect(formatWindow(200_000)).toBe("200k");
    expect(formatWindow(272_000)).toBe("272k");
    expect(formatWindow(1_000_000)).toBe("1M");
    expect(formatWindow(1_050_000)).toBe("1.05M");
  });
});
