/**
 * The locale gate is a security control, and a security control that has never
 * been shown a hostile input is a wish. Each case below is a real thing a
 * translation pull request could contain, built from escape sequences so this
 * file stays readable in a diff.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "validate-locales.ts");

/** English source used by every case. Small, with one plural and one placeholder. */
const EN = {
  "common.action.cancel": "Cancel",
  "common.label.files": "Files",
  "session.steps": "{count, plural, one {# step} other {# steps}}",
  // A plural whose ONE branch is a bare word. `{step}` here is a branch BODY,
  // not a placeholder — the case that made the gate demand a `{step}` no
  // translation could supply.
  "session.one-or-many": "{count, plural, one {step} other {# steps}}",
  "session.nested": "{count, plural, one {# file in {dir}} other {# files in {dir}}}",
  "session.greeting": "Welcome back, {name}",
  // A genuinely two-paragraph message: its translation needs newlines too.
  "session.confirm": "Discard these changes?\n\nThis cannot be undone.",
  "common.state.ready": "Ready",
};

/** Run the gate over a throwaway locale tree. */
function gate(
  locale: Record<string, unknown>,
  source: Record<string, unknown> = EN,
): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "baked-locales-"));
  writeFileSync(join(dir, "en.json"), JSON.stringify(source));
  writeFileSync(join(dir, "zz.json"), JSON.stringify(locale));
  const proc = Bun.spawnSync(["bun", SCRIPT], {
    env: { ...process.env, LOCALES_DIR: dir },
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString() + proc.stderr.toString(),
  };
}

describe("locale gate", () => {
  test("accepts an honest translation", () => {
    const { code, out } = gate({
      "common.action.cancel": "取消",
      "common.label.files": "文件",
      "session.steps": "{count, plural, other {# 步}}",
      "session.greeting": "欢迎回来，{name}",
    });
    expect(code).toBe(0);
    expect(out).toContain("ok");
  });

  test("refuses an em dash in the English source", () => {
    const { code, out } = gate({}, { ...EN, "common.action.cancel": "Cancel\u2014now" });
    expect(code).not.toBe(0);
    expect(out).toContain("common.action.cancel");
    expect(out).toContain("colon, a comma or a full stop");
  });

  test("refuses an en dash in the English source", () => {
    const { code, out } = gate({}, { ...EN, "common.action.cancel": "Cancel\u2013now" });
    expect(code).not.toBe(0);
    expect(out).toContain("common.action.cancel");
  });

  test("accepts a hyphen and middle dot in the English source", () => {
    const { code } = gate({}, { ...EN, "common.action.cancel": "Cancel-now \u00b7 later" });
    expect(code).toBe(0);
  });

  test("accepts an em dash in a translation", () => {
    const { code } = gate({ "common.action.cancel": "\u041c\u043e\u0441\u043a\u0432\u0430 \u2014 \u0441\u0442\u043e\u043b\u0438\u0446\u0430" });
    expect(code).toBe(0);
  });

  test("accepts right-to-left text without explicit overrides", () => {
    // Arabic derives direction from its own letters; no control marks needed.
    const { code } = gate({ "common.action.cancel": "إلغاء", "common.label.files": "الملفات" });
    expect(code).toBe(0);
  });

  test("refuses OSC 52, which would write the user's clipboard", () => {
    const osc = `\u001b]52;c;${btoa("stolen")}\u0007Cancel`;
    const { code, out } = gate({ "common.action.cancel": osc });
    expect(code).not.toBe(0);
    expect(out).toContain("control-char");
  });

  test("refuses cursor-movement sequences that could forge a prompt", () => {
    const { code, out } = gate({ "common.action.cancel": "\u001b[2J\u001b[HCancel" });
    expect(code).not.toBe(0);
    expect(out).toContain("control-char");
  });

  test("refuses C1 controls, which some terminals treat as escape introducers", () => {
    const { code, out } = gate({ "common.action.cancel": "Cancel\u009b0m" });
    expect(code).not.toBe(0);
    expect(out).toContain("control-char");
  });

  test("refuses bidi overrides (Trojan Source)", () => {
    const { code, out } = gate({ "common.action.cancel": "\u202eCancel" });
    expect(code).not.toBe(0);
    expect(out).toContain("bidi-override");
  });

  test("refuses invisible padding", () => {
    const { code, out } = gate({ "common.action.cancel": `Cancel${"\u200b".repeat(20)}` });
    expect(code).not.toBe(0);
    expect(out).toContain("invisible");
  });

  test("refuses an oversized value", () => {
    const { code, out } = gate({ "common.action.cancel": "x".repeat(500) });
    expect(code).not.toBe(0);
    expect(out).toContain("length");
  });

  test("a newline is allowed where the English has one", () => {
    const { code, out } = gate({ "session.confirm": "تجاهل هذه التغييرات؟\n\nلا يمكن التراجع." });
    expect(out).not.toContain("control-char");
    expect(code).toBe(0);
  });

  test("a newline the English never had is still refused", () => {
    const { code, out } = gate({ "common.action.cancel": "إلغاء\nOSC" });
    expect(code).not.toBe(0);
    expect(out).toContain("control-char");
  });

  test("refuses a dropped placeholder", () => {
    const { code, out } = gate({ "session.greeting": "Welcome back" });
    expect(code).not.toBe(0);
    expect(out).toContain("missing {name}");
  });

  test("a plural branch body is not a placeholder", () => {
    // Translating the branch bodies is the whole job; a gate that reads them as
    // required placeholders rejects every correct translation of this shape.
    const { code, out } = gate({
      "session.one-or-many": "{count, plural, zero {لا خطوات} one {خطوة} two {خطوتان} few {# خطوات} many {# خطوة} other {# خطوة}}",
    });
    expect(out).not.toContain("missing {step}");
    expect(code).toBe(0);
  });

  test("a placeholder nested inside a plural branch is still required", () => {
    const { code, out } = gate({
      "session.nested": "{count, plural, one {# ملف} other {# ملفات}}",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("missing {dir}");
  });

  test("refuses an invented placeholder", () => {
    const { code, out } = gate({ "session.greeting": "Welcome, {name} ({email})" });
    expect(code).not.toBe(0);
    expect(out).toContain("unexpected {email}");
  });

  test("refuses a plural that lost its plural form", () => {
    const { code, out } = gate({ "session.steps": "{count} steps" });
    expect(code).not.toBe(0);
    expect(out).toContain("plural");
  });

  test("refuses a plural with no `other` branch", () => {
    const { code, out } = gate({ "session.steps": "{count, plural, one {# krok}}" });
    expect(code).not.toBe(0);
    expect(out).toContain("other");
  });

  test("refuses unbalanced braces", () => {
    const { code, out } = gate({ "common.action.cancel": "Cancel {" });
    expect(code).not.toBe(0);
    expect(out).toContain("braces");
  });

  test("refuses a key that is not in the source catalog", () => {
    const { code, out } = gate({ "totally.made.up": "hi" });
    expect(code).not.toBe(0);
    expect(out).toContain("unknown-key");
  });

  test("refuses a non-string value", () => {
    const { code, out } = gate({ "common.action.cancel": 42 });
    expect(code).not.toBe(0);
    expect(out).toContain("type");
  });

  test("reports coverage so a partial translation reads as partial", () => {
    // The fraction, not a fixed percentage: the English fixture grows whenever
    // a new shape needs covering, and a hardcoded number turns that into a
    // failing test about nothing.
    const { out } = gate({ "common.action.cancel": "取消" });
    expect(out).toMatch(new RegExp(`\\(1/${Object.keys(EN).length}\\)`));
    expect(out).toMatch(/% translated/);
  });

  /**
   * Invisible-character classes the first version of this gate let straight
   * through. Each renders as nothing, so each is a channel that survives review.
   */
  test("refuses Unicode Tag characters, the ASCII-smuggling block", () => {
    const smuggled = `Cancel${String.fromCodePoint(0xe0001, 0xe0041, 0xe0042)}`;
    const { code, out } = gate({ "common.action.cancel": smuggled });
    expect(code).not.toBe(0);
    expect(out).toContain("invisible");
  });

  test("refuses variation selectors used as a hidden channel", () => {
    for (const cp of [0xfe00, 0xe0100]) {
      const { code } = gate({ "common.action.cancel": `Cancel${String.fromCodePoint(cp)}` });
      expect(code).not.toBe(0);
    }
  });

  test("refuses line and paragraph separators", () => {
    for (const cp of [0x2028, 0x2029]) {
      const { code } = gate({ "common.action.cancel": `Cancel${String.fromCodePoint(cp)}` });
      expect(code).not.toBe(0);
    }
  });

  test("refuses soft hyphen, ALM, MVS and interlinear annotation", () => {
    for (const cp of [0x00ad, 0x061c, 0x180e, 0xfff9]) {
      const { code } = gate({ "common.action.cancel": `Cancel${String.fromCodePoint(cp)}` });
      expect(code).not.toBe(0);
    }
  });

  test("still accepts ordinary text after all that tightening", () => {
    const { code } = gate({
      "common.action.cancel": "キャンセル",
      "common.label.files": "ファイル",
      "session.greeting": "{name}さん、おかえりなさい",
    });
    expect(code).toBe(0);
  });

  test("refuses a file too large to be a translation, before parsing it", () => {
    // 5 MB of a valid-looking value: the size check must fire, not JSON.parse.
    const { code, out } = gate({ "common.action.cancel": "x".repeat(5 * 1024 * 1024) });
    expect(code).not.toBe(0);
    expect(out).toContain("size");
    expect(out).not.toContain("length"); // never got as far as the per-value rule
  });
});
