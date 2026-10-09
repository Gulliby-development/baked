import { afterEach, expect, test } from "bun:test";
import { type Renderable, RGBA, TextareaRenderable, TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { InputBox } from "../src/components/chat/InputBox.js";
import { MessageList } from "../src/components/chat/MessageList.js";
import { applyTheme, resolveTheme } from "../src/core/theme/loader.js";

afterEach(() => applyTheme("dark", false));
type View = Awaited<ReturnType<typeof testRender>>;
async function settle(view: View) {
  for (let frame = 0; frame < 3; frame++) await act(async () => { await view.flush(); await view.renderOnce(); });
}
function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)];
}

test("focused chat input and sent messages change foreground with the live theme", async () => {
  const view = await testRender(<box flexDirection="column"><MessageList chatStyle="bubble" messages={[{ id: "contrast", role: "user", content: "Fresh bread", timestamp: Date.now() }]} /><InputBox tabId="contrast" isLoading={false} isFocused onSubmit={() => {}} /></box>, { width: 100, height: 30 });
  try {
    for (const name of ["dark", "light", "dark"]) {
      await act(async () => applyTheme(name, false));
      await settle(view);
      const theme = resolveTheme(name);
      const nodes = descendants(view.renderer.root);
      const input = nodes.find((node) => node instanceof TextareaRenderable) as TextareaRenderable;
      expect(input.focused).toBe(true);
      expect(input.textColor.equals(RGBA.fromHex(theme.textPrimary))).toBe(true);
      expect(input.backgroundColor.equals(RGBA.fromHex(theme.bgInput))).toBe(true);
      const message = nodes.find((node) => node instanceof TextRenderable && node.plainText === "Fresh bread") as TextRenderable;
      expect(message).toBeDefined();
      expect(message.fg.equals(RGBA.fromHex(theme.textPrimary))).toBe(true);
    }
  } finally { await act(async () => view.renderer.destroy()); }
});
