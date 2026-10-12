import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import { idleInputBorder } from "../src/components/chat/InputBox";
import { isCompactTerminal } from "../src/components/layout/compact";
import {
  buildContextMeter,
  ContextBar,
  METER_DANGER_PCT,
  METER_WIDTH,
} from "../src/components/layout/ContextBar";
import { Footer, FOOTER_SHORTCUTS, footerLayout } from "../src/components/layout/Footer";
import { SystemBanner } from "../src/components/layout/SystemBanner";
import { TabBar } from "../src/components/layout/TabBar";
import { PremiumPopup } from "../src/components/ui/PremiumPopup";
import type { ContextManager } from "../src/core/context/manager";
import { getThemeTokens } from "../src/core/theme/index";
import { DARK_THEME, LIGHT_THEME } from "../src/core/theme/tokens";
import { artPalette, inkOn } from "../src/core/utils/bake-art";
import { SPINNER_FRAMES, spinnerGlyph } from "../src/core/utils/spinner";
import { resetStatusBarStore, useStatusBarStore } from "../src/stores/statusbar";
import type { ChatMessage } from "../src/types/index";

type View = Awaited<ReturnType<typeof testRender>>;

async function settle(view: View) {
  for (let frame = 0; frame < 3; frame++) {
    await act(async () => {
      await view.flush();
      await view.renderOnce();
    });
  }
}

async function withView(node: ReactNode, width: number, height: number, check: (view: View) => Promise<void> | void) {
  const view = await testRender(node, { width, height });
  try {
    await settle(view);
    await check(view);
  } finally {
    await act(async () => {
      view.renderer.destroy();
    });
  }
}

/** Foreground and background of the cell at (x, y) as `#rrggbb`. */
function cellColors(view: View, x: number, y: number): { fg: string; bg: string } {
  const spans = view.captureSpans().lines[y]?.spans ?? [];
  let col = 0;
  for (const span of spans) {
    if (x < col + span.width) {
      const hex = (c: typeof span.fg) =>
        `#${c
          .toInts()
          .slice(0, 3)
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("")}`;
      return { fg: hex(span.fg), bg: hex(span.bg) };
    }
    col += span.width;
  }
  return { fg: "", bg: "" };
}

function findLine(frame: string, needle: string): { x: number; y: number } {
  const lines = frame.split("\n");
  const y = lines.findIndex((line) => line.includes(needle));
  expect(y).toBeGreaterThanOrEqual(0);
  return { x: (lines[y] ?? "").indexOf(needle), y };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const idleActivity = () => ({
  isLoading: false,
  isCompacting: false,
  hasUnread: false,
  hasError: false,
  needsAttention: false,
  editedFileCount: 0,
});

describe("footer key chips", () => {
  test("shortcuts render as filled key chips in one notation", async () => {
    await withView(<Footer />, 120, 30, (view) => {
      const frame = view.captureCharFrame();
      for (const s of FOOTER_SHORTCUTS) {
        expect(s.key).toMatch(/^\^[A-Z]$/);
        expect(frame).toContain(` ${s.key} `);
      }
      expect(frame).toContain("Palette");
      const at = findLine(frame, " ^K ");
      const palette = artPalette(getThemeTokens());
      expect(cellColors(view, at.x + 1, at.y).bg).toBe(palette.fill.toLowerCase());
    });
  });

  test("the footer has no rotating hints or glitch timers", () => {
    const source = readFileSync("src/components/layout/Footer.tsx", "utf8");
    expect(source).not.toMatch(/setTimeout|setInterval|garble|HINT/);
  });

  test("narrower terminals keep labels and drop the less used keys", () => {
    expect(footerLayout(200, 40)).toEqual({ items: FOOTER_SHORTCUTS, mode: "full" });
    const narrow = footerLayout(80, 24);
    expect(narrow.mode).not.toBe("none");
    expect(narrow.items.map((s) => s.key)).toEqual(["^K", "^L", "^D", "^S", "^G"]);
  });
});

describe("compact layout", () => {
  test("applies below 80 columns or 24 rows", () => {
    expect(isCompactTerminal(80, 24)).toBe(false);
    expect(isCompactTerminal(79, 24)).toBe(true);
    expect(isCompactTerminal(120, 23)).toBe(true);
  });

  test("the footer shows only the palette chip", async () => {
    expect(footerLayout(79, 40).items.map((s) => s.key)).toEqual(["^K"]);
    await withView(<Footer />, 70, 20, (view) => {
      const frame = view.captureCharFrame();
      expect(frame).toContain(" ^K ");
      expect(frame).toContain("Palette");
      expect(frame).not.toContain("^L");
    });
  });

  test("tabs are numbered and stay clickable", async () => {
    let selected = "";
    await withView(
      <TabBar
        tabs={Array.from({ length: 3 }, (_, i) => ({ id: String(i), label: `Feature branch ${i}` }))}
        activeTabId="0"
        onSwitch={(id) => {
          selected = id;
        }}
        getMode={() => "default"}
        getModelLabel={() => null}
        getActivity={idleActivity}
      />,
      70,
      20,
      async (view) => {
        const frame = view.captureCharFrame();
        expect(frame).toContain(" 1 ");
        expect(frame).toContain(" 3 ");
        expect(frame).not.toContain("Feature branch");
        const third = view.renderer.root.findDescendantById("workspace-tab-2");
        expect(third).toBeDefined();
        await act(async () => {
          await view.mockMouse.click((third?.x ?? 0) + 1, third?.y ?? 0);
        });
        expect(selected).toBe("2");
      },
    );
  });

  test("wide terminals keep labelled tabs", async () => {
    await withView(
      <TabBar
        tabs={[{ id: "a", label: "Feature branch" }, { id: "b", label: "Docs" }]}
        activeTabId="a"
        onSwitch={() => {}}
        getMode={() => "default"}
        getModelLabel={() => null}
        getActivity={idleActivity}
      />,
      100,
      30,
      (view) => {
        expect(view.captureCharFrame()).toContain("Feature branch");
      },
    );
  });
});

describe("context meter", () => {
  test("is a block meter that turns red at 85%", () => {
    const tk = getThemeTokens();
    const color = (pct: number) =>
      buildContextMeter({ pct, live: true, usedTokens: 1, windowTokens: 100 }).chunks[0]?.fg;
    const meter = buildContextMeter({ pct: 50, live: true, usedTokens: 100_000, windowTokens: 200_000 });
    const text = meter.chunks.map((c) => c.text).join("");
    expect(text).toStartWith(`${"█".repeat(METER_WIDTH / 2)}${"░".repeat(METER_WIDTH / 2)} 50%`);
    expect(color(METER_DANGER_PCT)?.toString()).toBe(color(100)?.toString());
    expect(String(color(METER_DANGER_PCT))).not.toBe(String(color(METER_DANGER_PCT - 1)));
    expect(METER_DANGER_PCT).toBe(85);
    expect(tk.error).toBeDefined();
  });

  test("the meter schedules no timer while idle and stops after easing", async () => {
    resetStatusBarStore();
    const contextManager = {
      getContextBreakdown: () => [],
      getMemoryManager: () => ({ cleanupHint: () => null }),
    } as unknown as ContextManager;
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const live = new Set<unknown>();
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = realSet(fn, ms);
      live.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
      live.delete(id);
      realClear(id);
    }) as typeof clearInterval;
    try {
      await withView(<ContextBar contextManager={contextManager} modelId="m" />, 80, 4, async (view) => {
        const before = live.size;
        await act(async () => {
          useStatusBarStore.setState({ contextTokens: 120_000, contextWindow: 200_000 });
        });
        expect(live.size).toBe(before + 1);
        await act(async () => {
          await Bun.sleep(800);
        });
        await settle(view);
        expect(live.size).toBe(before);
        expect(view.captureCharFrame()).toContain("60%");
      });
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      resetStatusBarStore();
    }
  });
});

describe("one spinner", () => {
  test("uses CP437 block glyphs only", () => {
    const cp437Blocks = new Set(["█", "▀", "▄", "▌", "▐", "░", "▒", "▓", "■"]);
    expect(SPINNER_FRAMES.length).toBeGreaterThan(1);
    for (const frame of SPINNER_FRAMES) expect(cp437Blocks.has(frame)).toBe(true);
    expect(spinnerGlyph(SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0] as string);
  });

  test("no other spinner glyph sets remain in the terminal UI", () => {
    const glob = new Bun.Glob("src/{components,index.tsx}/**/*.tsx");
    const files = [...glob.scanSync("."), "src/index.tsx"];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect({ file, braille: /[⠀-⣿]/.test(source) }).toEqual({ file, braille: false });
      expect({ file, arcs: /[◴-◷]|"◐", "◓"/.test(source) }).toEqual({ file, arcs: false });
    }
  });
});

describe("system banner", () => {
  test("appears at once as a colour block", async () => {
    const message: ChatMessage = {
      id: "s1",
      role: "system",
      content: "Model switched to fixture/model",
      timestamp: Date.now(),
    } as ChatMessage;
    await withView(<SystemBanner messages={[message]} />, 80, 4, (view) => {
      const frame = view.captureCharFrame();
      expect(frame).toContain("SYSTEM");
      expect(frame).toContain("Model switched to fixture/model");
      const fill = artPalette(getThemeTokens()).fill.toLowerCase();
      expect(cellColors(view, 0, 0).bg).toBe(fill);
      expect(cellColors(view, 79, 0).bg).toBe(fill);
    });
  });

  test("schedules only its dismiss timer", () => {
    const source = readFileSync("src/components/layout/SystemBanner.tsx", "utf8");
    expect(source).not.toMatch(/setInterval|FADE|revealCount/);
  });
});

describe("heavy chrome", () => {
  test("popups have a heavy border and a hard shadow", async () => {
    await withView(
      <PremiumPopup visible width={40} height={10} title="Shadowed" footerHints={[{ key: "Esc", label: "close" }]}>
        <text>body</text>
      </PremiumPopup>,
      80,
      24,
      (view) => {
        const frame = view.captureCharFrame();
        expect(frame).toContain("┏");
        expect(frame).toContain("┛");
        const popup = view.renderer.root.findDescendantById("baked-popup");
        expect(popup).toBeDefined();
        const below = (frame.split("\n")[(popup?.y ?? 0) + (popup?.height ?? 0)] ?? "").slice(
          (popup?.x ?? 0) + 1,
          (popup?.x ?? 0) + (popup?.width ?? 0) + 1,
        );
        expect(below).toBe("▀".repeat(popup?.width ?? 0));
      },
    );
  });

  test("the idle input border reads at 4.5:1 or better in both themes", () => {
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      expect(contrast(idleInputBorder(theme), theme.bgInput)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("chip text stays readable on every mode colour", () => {
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      for (const fill of [theme.textMuted, theme.brand, theme.info, theme.success, theme.error, artPalette(theme).fill]) {
        expect(contrast(inkOn(fill), fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

afterEach(() => {
  resetStatusBarStore();
});
