import { describe, expect, test } from "bun:test";
import { imageExtension, imageUrl, promptImage } from "../src/core/llm/providers/prompt-images.js";

describe("prompt images", () => {
  test("reads bytes, base64, data URLs and http URLs", () => {
    expect(promptImage({ type: "file", mediaType: "image/png", data: new Uint8Array([1, 2]) })).toEqual({
      mediaType: "image/png",
      base64: "AQI=",
    });
    expect(promptImage({ type: "file", mediaType: "image/png", data: "AQI=" })).toEqual({
      mediaType: "image/png",
      base64: "AQI=",
    });
    expect(promptImage({ type: "file", mediaType: "image/*", data: "data:image/jpeg;base64,AQI=" })).toEqual({
      mediaType: "image/jpeg",
      base64: "AQI=",
    });
    const remote = promptImage({ type: "file", mediaType: "image/png", data: new URL("https://x.test/a.png") });
    expect(remote).toEqual({ mediaType: "image/png", url: "https://x.test/a.png" });
    expect(remote && imageUrl(remote)).toBe("https://x.test/a.png");
  });

  test("ignores text and non-image files", () => {
    expect(promptImage({ type: "text" })).toBeNull();
    expect(promptImage({ type: "file", mediaType: "application/pdf", data: "AQI=" })).toBeNull();
  });

  test("names files by media type", () => {
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/webp")).toBe("webp");
  });
});
