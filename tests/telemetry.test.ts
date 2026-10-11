import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir } from "../src/core/platform/index.js";

// Isolate config/anon-id writes into a throwaway dir.
let tmp: string;
let origHome: string | undefined;
let origLocal: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sf-telem-"));
  // configDir() resolves from HOME → ~/.baked. Redirect HOME so the
  // rotating anon-id never touches the real config dir.
  origHome = process.env.HOME;
  process.env.HOME = tmp;
  // On Windows configDir() resolves from LOCALAPPDATA instead.
  origLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = join(tmp, "local");
  delete process.env.DO_NOT_TRACK;
  delete process.env.BAKED_TELEMETRY;
  delete process.env.BAKED_TELEMETRY_URL;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = origLocal;
  rmSync(tmp, { recursive: true, force: true });
  mock.restore();
});

async function load() {
  // Fresh module each test so module-level state doesn't bleed.
  return await import(`../src/core/telemetry.js?t=${Date.now()}`);
}

describe("telemetryDisabled", () => {
  test("DO_NOT_TRACK=1 disables", async () => {
    const { telemetryDisabled } = await load();
    process.env.DO_NOT_TRACK = "1";
    expect(telemetryDisabled(true)).toBe(true);
  });

  test("BAKED_TELEMETRY=0 disables", async () => {
    const { telemetryDisabled } = await load();
    process.env.BAKED_TELEMETRY = "0";
    expect(telemetryDisabled(undefined)).toBe(true);
  });

  test("config telemetry:false disables", async () => {
    const { telemetryDisabled } = await load();
    expect(telemetryDisabled(false)).toBe(true);
  });

  test("enabled by default", async () => {
    const { telemetryDisabled } = await load();
    expect(telemetryDisabled(undefined)).toBe(false);
  });

  test("env enable overrides nothing harmful", async () => {
    const { telemetryDisabled } = await load();
    process.env.BAKED_TELEMETRY = "1";
    expect(telemetryDisabled(true)).toBe(false);
  });
});

describe("sendBeacon", () => {
  test("does not fire when opted out", async () => {
    const { sendBeacon } = await load();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    process.env.DO_NOT_TRACK = "1";
    sendBeacon({ surface: "tui", version: "1.0.0" }, true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("fires a GET with only anonymous fields, no PII", async () => {
    const { sendBeacon } = await load();
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      calledUrl = String(url);
      calledInit = init as RequestInit;
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    process.env.BAKED_TELEMETRY_URL = "https://example.test/b";

    sendBeacon(
      {
        surface: "headless",
        version: "2.20.1",
        install: "brew",
        family: "claude",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      },
      undefined,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // UA marker the beacon gate checks — version only, no PII.
    const ua = (calledInit?.headers as Record<string, string>)["user-agent"];
    expect(ua).toBe("baked/2.20.1");
    const u = new URL(calledUrl);
    expect(u.origin + u.pathname).toBe("https://example.test/b");
    expect(u.searchParams.get("sf")).toBe("headless");
    expect(u.searchParams.get("v")).toBe("2.20.1");
    expect(u.searchParams.get("im")).toBe("brew");
    expect(u.searchParams.get("mf")).toBe("claude");
    expect(u.searchParams.get("pv")).toBe("anthropic");
    expect(u.searchParams.get("md")).toBe("claude-sonnet-4-5");
    expect(u.searchParams.get("id")).toBeTruthy();

    // No PII leakage: the URL must not contain home dir, cwd, username, or env secrets.
    const lower = calledUrl.toLowerCase();
    expect(lower).not.toContain((process.env.USER ?? "no-user-xyz").toLowerCase());
    expect(lower).not.toContain(process.cwd().toLowerCase());
    expect(lower).not.toContain("/users/");
    expect(lower).not.toContain("apikey");
    expect(lower).not.toContain("sk-");
  });

  test("never throws even when fetch explodes", async () => {
    const { sendBeacon } = await load();
    spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network down");
    });
    expect(() => sendBeacon({ surface: "tui", version: "1.0.0" }, true)).not.toThrow();
  });

  test("records locally and sends nothing without a receiver URL", async () => {
    const { sendBeacon, summarizeTelemetry, telemetryLogPath } = await load();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    sendBeacon({ surface: "tui", version: "1.0.0", provider: "anthropic" }, undefined);
    sendBeacon({ surface: "headless", version: "1.0.0" }, undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(telemetryLogPath())).toBe(true);
    const summary = summarizeTelemetry();
    expect(summary.events).toBe(2);
    expect(summary.by.sf).toEqual({ tui: 1, headless: 1 });
    expect(summary.by.pv).toEqual({ anthropic: 1 });
    expect(summary.days).toHaveLength(1);
  });

  test("sends to the config receiver URL when set", async () => {
    const { sendBeacon } = await load();
    let calledUrl = "";
    spyOn(globalThis, "fetch").mockImplementation((url) => {
      calledUrl = String(url);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    sendBeacon({ surface: "tui", version: "1.0.0" }, undefined, "https://config.test/b");
    expect(new URL(calledUrl).origin).toBe("https://config.test");
  });

  test("records nothing when opted out", async () => {
    const { sendBeacon, telemetryLogPath } = await load();
    process.env.BAKED_TELEMETRY = "0";
    sendBeacon({ surface: "tui", version: "1.0.0" }, undefined);
    expect(existsSync(telemetryLogPath())).toBe(false);
  });
});

describe("maybeShowTelemetryNotice", () => {
  test("shows once and marks, skips when already shown", async () => {
    const { maybeShowTelemetryNotice } = await load();
    const writeSpy = spyOn(process.stderr, "write").mockReturnValue(true);
    let marked = 0;
    maybeShowTelemetryNotice({ telemetry: true }, () => {
      marked++;
    });
    expect(marked).toBe(1);
    maybeShowTelemetryNotice({ telemetry: true, telemetryNoticeShown: true }, () => {
      marked++;
    });
    expect(marked).toBe(1);
    writeSpy.mockRestore();
  });

  test("does not show when opted out", async () => {
    const { maybeShowTelemetryNotice } = await load();
    const writeSpy = spyOn(process.stderr, "write").mockReturnValue(true);
    let marked = 0;
    maybeShowTelemetryNotice({ telemetry: false }, () => {
      marked++;
    });
    expect(marked).toBe(0);
    writeSpy.mockRestore();
  });
});

describe("runTelemetryCli", () => {
  const configFile = () => join(configDir(), "config.json");

  test("on and off write telemetry to the global config", async () => {
    const { runTelemetryCli } = await load();
    const out = spyOn(process.stdout, "write").mockReturnValue(true);
    expect(await runTelemetryCli(["off"])).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8")).telemetry).toBe(false);
    expect(String(out.mock.calls.at(-1)?.[0])).toContain("Recording is off");
    expect(await runTelemetryCli(["on"])).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), "utf8")).telemetry).toBe(true);
    out.mockRestore();
  });

  test("the summary reports a config opt-out and rejects unknown words", async () => {
    const { runTelemetryCli } = await load();
    const out = spyOn(process.stdout, "write").mockReturnValue(true);
    const err = spyOn(process.stderr, "write").mockReturnValue(true);
    await runTelemetryCli(["off"]);
    expect(await runTelemetryCli([])).toBe(0);
    expect(String(out.mock.calls.at(-1)?.[0])).toContain("config telemetry: false");
    expect(await runTelemetryCli(["maybe"])).toBe(2);
    out.mockRestore();
    err.mockRestore();
  });
});
