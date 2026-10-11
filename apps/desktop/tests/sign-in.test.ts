import { describe, expect, test } from "bun:test";
import type { CliSignIn } from "../src/renderer/client/setup.ts";
import { signInView } from "../src/renderer/screens/setup/logic.ts";

const base: CliSignIn = {
  installed: true,
  loggedIn: false,
  message: "Not logged in",
  command: "claude auth login",
  login: null,
};

describe("CLI provider sign-in row", () => {
  test("offers sign-in, sign-out, cancel or install as the CLI's state says", () => {
    expect(signInView(base)).toEqual({ note: "not signed in", action: "sign-in" });
    expect(signInView({ ...base, loggedIn: true }).action).toBe("sign-out");
    expect(signInView({ ...base, installed: false }).action).toBe("install");
    const running = { provider: "codex", state: "running" as const, lines: [], startedAt: "" };
    expect(signInView({ ...base, login: running })).toEqual({ note: "signing in…", action: "cancel" });
    expect(signInView({ ...base, login: { ...running, state: "failed" } }).action).toBe("sign-in");
  });
});
