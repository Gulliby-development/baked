import { describe, expect, test } from "bun:test";
import {
  MAX_IMAGES,
  pendingText,
  pickImages,
  sniffType,
  storedImageUrl,
} from "../src/renderer/screens/chat/images.ts";

describe("composer images", () => {
  test("keep image files only, up to four per message", () => {
    const png = { type: "image/png", name: "a" };
    const jpeg = { type: "image/jpeg", name: "c" };
    const heic = { type: "image/heic", name: "d" };
    const files = [png, { type: "text/plain", name: "b" }, jpeg, heic];
    expect(pickImages(files, 0)).toEqual({ take: [png, jpeg, heic], dropped: 0 });
    expect(pickImages(files, MAX_IMAGES - 1)).toEqual({ take: [png], dropped: 2 });
    expect(pickImages([{ type: "text/plain" }], 0)).toEqual({ take: [], dropped: 0 });
  });

  test("the file header decides the type the server sees", () => {
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe1]))).toBe("image/jpeg");
    expect(sniffType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffType(new TextEncoder().encode("RIFF0000WEBP"))).toBe("image/webp");
    expect(sniffType(new TextEncoder().encode("BM bitmap"))).toBeNull();
  });

  test("the pending bubble names the images it waits to send", () => {
    expect(pendingText("Look", 0)).toBe("Look");
    expect(pendingText("Look", 2)).toBe("Look\n[2 images]");
    expect(pendingText("", 1)).toBe("[1 image]");
  });

  test("stored images render as data URLs", () => {
    expect(storedImageUrl({ label: "image-1", mediaType: "image/png", base64: "AAAA" })).toBe(
      "data:image/png;base64,AAAA",
    );
  });
});
