import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { DiffView } from "../src/components/chat/DiffView.js";
import { HighlightedCode } from "../src/components/chat/highlighted-result.js";
import { Markdown } from "../src/components/chat/Markdown.js";
import { getSyntaxStyle } from "../src/core/utils/syntax.js";

// #2404: OpenTUI 0.6 gives every native resource an owner, and a syntax style binds only in the
// scene of the context that made it. The TUI kept one process-wide style; each renderer now gets
// its own (`getSyntaxStyle(renderer.nativeScene)` through `useSyntaxStyle`), and the components
// that highlight code render in any renderer, one after another.

type View = Awaited<ReturnType<typeof testRender>>;
const views: View[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.renderer.destroy();
});

async function draw(node: React.ReactNode): Promise<{ view: View; text: string }> {
  const view = await testRender(node, { width: 80, height: 20 });
  views.push(view);
  for (let i = 0; i < 3; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
  return { view, text: view.captureCharFrame() };
}

test("markdown code blocks, highlighted results and diffs render in two renderers in turn", async () => {
  for (let round = 0; round < 2; round++) {
    expect((await draw(<Markdown text={"Sum:\n\n```ts\nconst total = 1 + 2;\n```\n"} />)).text).toContain("const total = 1 + 2;");
    expect((await draw(<HighlightedCode content={"def area(r):\n    return r * r\n"} lang="python" />)).text).toContain("def area(r):");
    expect((await draw(<DiffView filePath="src/sum.ts" oldString={"return a - b;\n"} newString={"return a + b;\n"} success />)).text).toContain("src/sum.ts");
  }
});

test("a renderer keeps one style, and each renderer has its own", async () => {
  const a = (await draw(<box />)).view.renderer.nativeScene;
  const b = (await draw(<box />)).view.renderer.nativeScene;
  expect(getSyntaxStyle(a)).toBe(getSyntaxStyle(a));
  expect(getSyntaxStyle(a)).not.toBe(getSyntaxStyle(b));
});
