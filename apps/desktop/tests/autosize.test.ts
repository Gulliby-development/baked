import { describe, expect, test } from "bun:test";
import { type AutoSizedField, autoSizeTextarea } from "../src/renderer/lib/autosize.ts";

/** A textarea whose content height is 24 px per 40 characters, like a field that wraps. */
function field(value: string, placeholder: string): AutoSizedField & { measured: string[] } {
  const measured: string[] = [];
  return {
    value,
    placeholder,
    style: { height: "" },
    measured,
    get scrollHeight() {
      measured.push(this.value);
      return Math.max(1, Math.ceil(this.value.length / 40)) * 24;
    },
  };
}

describe("autoSizeTextarea (#2680)", () => {
  const hint = "Ask BAKED to do something · / runs a custom command · @ adds a file or symbol · ! runs a command";

  test("an empty field is sized to its placeholder and stays empty", () => {
    const el = field("", hint);
    autoSizeTextarea(el, 240);
    expect(el.measured).toEqual([hint]);
    expect(el.style.height).toBe("72px");
    expect(el.value).toBe("");
  });

  test("typed text is measured, not the placeholder", () => {
    const el = field("fix it", hint);
    autoSizeTextarea(el, 240);
    expect(el.measured).toEqual(["fix it"]);
    expect(el.style.height).toBe("24px");
  });

  test("the placeholder's height is capped like typed text", () => {
    const el = field("", hint.repeat(10));
    autoSizeTextarea(el, 240);
    expect(el.style.height).toBe("240px");
    expect(el.value).toBe("");
  });
});
