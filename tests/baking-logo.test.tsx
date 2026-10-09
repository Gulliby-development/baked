import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { renderBakingFrame } from "../src/components/layout/BakingLogo.js";
import { LandingPage } from "../src/components/layout/LandingPage.js";
import { DARK_THEME, LIGHT_THEME } from "../src/core/theme/tokens.js";

for (const width of [80, 50, 25]) {
  const height = 8;
  for (const [name, theme] of [["dark", DARK_THEME], ["light", LIGHT_THEME]] as const) {
    for (const [seconds, caption] of [[0, "Rising dough"], [5, "Golden crust"], [9, "Freshly baked"]] as const) {
      test(`${caption} fits ${width} × ${height} in ${name} theme`, async () => {
        const view = await testRender(
          <text wrapMode="none" content={renderBakingFrame(width, seconds, theme)} />,
          { width, height },
        );
        try {
          await act(async () => {
            await view.flush();
            await view.renderOnce();
          });
          const frame = view.captureCharFrame();
          expect(frame).toContain(caption);
          if (width >= 50) expect(frame).toContain("Ready for your next idea");
          expect(frame).toContain("╱");
          expect(frame).not.toContain("╚═════╝");
          expect(frame.trimEnd().split("\n").at(-1)).toContain(caption);
        } finally {
          await act(async () => view.renderer.destroy());
        }
      });
    }
  }
}

for (const width of [50, 80, 120]) {
  test(`landing bread and caption share the center of a ${width}-column chat`, async () => {
    const view = await testRender(
      <box width="100%" height="100%" flexDirection="column">
        <LandingPage bootProviders={[]} bootPrereqs={[]} />
        <box height={3} width="100%" border />
      </box>,
      { width, height: 30 },
    );
    try {
      for (let frame = 0; frame < 3; frame++) {
        await act(async () => { await view.flush(); await view.renderOnce(); });
      }
      const lines = view.captureCharFrame().split("\n");
      const bread = lines.find((line) => line.includes("▐"));
      const caption = lines.find((line) => line.includes("Ready for your next idea"));
      expect(bread).toBeDefined();
      expect(caption).toBeDefined();
      for (const line of [bread!, caption!]) {
        const left = line.search(/\S/);
        const right = line.trimEnd().length - 1;
        expect(Math.abs((left + right) / 2 - (width - 1) / 2)).toBeLessThanOrEqual(1);
      }
    } finally {
      await act(async () => view.renderer.destroy());
    }
  });
}
