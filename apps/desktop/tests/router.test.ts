import { describe, expect, test } from "bun:test";
import { href, parseRoute } from "../src/renderer/router.ts";

describe("routes", () => {
  test("parse and print round trip", () => {
    for (const hash of ["#/projects", "#/attention", "#/settings/routing", "#/settings/chat/provider-options", "#/p/abc123/runs/run%201"])
      expect(href(parseRoute(hash))).toBe(hash);
  });

  test("unknown routes fall back", () => {
    expect(parseRoute("")).toEqual({ name: "projects" });
    expect(parseRoute("#/p/abc/nope")).toEqual({ name: "project", key: "abc", section: "overview", id: null });
    expect(parseRoute("#/settings/x")).toEqual({ name: "settings", section: "app" });
    expect(parseRoute("#/settings/global")).toEqual({ name: "settings", section: "providers" });
    expect(parseRoute("#/settings/chat")).toEqual({ name: "settings", section: "chat" });
  });

  test("old acceptance links open the run", () => {
    expect(parseRoute("#/p/abc/acceptance/r1")).toEqual({ name: "project", key: "abc", section: "runs", id: "r1" });
    expect(parseRoute("#/p/abc/acceptance")).toEqual({ name: "project", key: "abc", section: "runs", id: null });
  });
});
