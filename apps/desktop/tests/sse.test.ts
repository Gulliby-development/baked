import { describe, expect, test } from "bun:test";
import { SseParser } from "../src/main/sse.ts";

describe("SseParser", () => {
  test("parses events split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("id: 4\nda")).toEqual([]);
    expect(parser.push('ta: {"a":1}\n\n')).toEqual([{ id: "4", event: "message", data: '{"a":1}' }]);
  });

  test("keeps the event name, joins data lines and skips heartbeats", () => {
    const parser = new SseParser();
    const events = parser.push(": heartbeat\n\nevent: attention\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(events).toEqual([{ id: null, event: "attention", data: "a\nb" }]);
  });

  test("carries the last id to later events", () => {
    const parser = new SseParser();
    const events = parser.push("id: 7\ndata: x\n\ndata: y\n\n");
    expect(events.map((e) => e.id)).toEqual(["7", "7"]);
  });
});
