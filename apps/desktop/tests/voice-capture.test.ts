import { describe, expect, test } from "bun:test";
import { insertAtCaret } from "../src/renderer/screens/chat/Composer.tsx";
import {
  clock,
  joinFrames,
  level,
  microphoneError,
  resample,
  VOICE_RATE,
} from "../src/renderer/screens/chat/voice.ts";

describe("voice capture", () => {
  test("resamples 48 kHz to 16 kHz and keeps 16 kHz as is", () => {
    const second = new Float32Array(48_000).map((_, i) => Math.sin(i / 10));
    const out = resample(second, 48_000);
    expect(out.length).toBe(VOICE_RATE);
    expect(out[1]).toBeCloseTo(second[3] ?? 0, 5);
    const same = new Float32Array(10);
    expect(resample(same, VOICE_RATE)).toBe(same);
  });

  test("joins frames up to the clip limit", () => {
    const frames = [new Float32Array([1, 2]), new Float32Array([3, 4, 5])];
    expect([...joinFrames(frames)]).toEqual([1, 2, 3, 4, 5]);
    expect([...joinFrames(frames, 3)]).toEqual([1, 2, 3]);
  });

  test("level is 0 for silence and capped at 1", () => {
    expect(level(new Float32Array(100))).toBe(0);
    expect(level(new Float32Array(100).fill(0.9))).toBe(1);
    expect(level(new Float32Array(100).fill(0.1))).toBeCloseTo(0.5, 5);
  });

  test("shows the recording time as m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(9.7)).toBe("0:09");
    expect(clock(30)).toBe("0:30");
  });

  test("explains microphone failures", () => {
    expect(microphoneError(new DOMException("denied", "NotAllowedError"))).toContain("blocked");
    expect(microphoneError(new DOMException("none", "NotFoundError"))).toBe(
      "No microphone was found.",
    );
    expect(microphoneError(new DOMException("busy", "NotReadableError"))).toContain("in use");
    expect(microphoneError(new Error("odd"))).toContain("odd");
  });

  test("inserts the transcript at the caret with spaces where words would touch", () => {
    expect(insertAtCaret("", 0, "hello")).toEqual({ text: "hello", caret: 5 });
    expect(insertAtCaret("fix bug", 3, "the")).toEqual({ text: "fix the bug", caret: 7 });
    expect(insertAtCaret("fix ", 4, "it")).toEqual({ text: "fix it", caret: 6 });
    expect(insertAtCaret("now", 0, "do it")).toEqual({ text: "do it now", caret: 5 });
  });
});
