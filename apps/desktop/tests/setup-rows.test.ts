import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { mcp } = await import("../src/renderer/client/mcp.ts");
const { lsp } = await import("../src/renderer/client/lsp.ts");
const { ServerRow: McpRow } = await import("../src/renderer/screens/setup/McpSection.tsx");
const { ServerRow: LspRow } = await import("../src/renderer/screens/setup/LspSection.tsx");
const { ROW_TEXT } = await import("../src/renderer/screens/setup/shared.tsx");
delete scope.window;

const noop = () => {};

/** The classes of the row's text cell: the server's name and command, stacked. */
const textCell = (html: string) => html.match(/<span class="([^"]*flex-col gap-0\.5[^"]*)"/)?.[1] ?? "";

describe("setup list rows at a narrow window (#2682)", () => {
  test("the text cell has a basis, so the actions wrap below before the command breaks", async () => {
    expect(ROW_TEXT).toContain("flex-[1_1_240px]");

    const server = (await mcp.list("baked")).servers[0];
    if (!server) throw new Error("the mock has no MCP server");
    const mcpHtml = renderToStaticMarkup(
      createElement(McpRow, { server, busy: false, onToggle: noop, onReconnect: noop, onOpen: noop }),
    );
    expect(textCell(mcpHtml)).toContain("flex-[1_1_240px]");

    const lspServer = (await lsp.status("baked")).servers[0];
    if (!lspServer) throw new Error("the mock has no language server");
    const lspHtml = renderToStaticMarkup(
      createElement(LspRow, {
        server: lspServer,
        busy: false,
        installing: false,
        onToggle: noop,
        onInstall: noop,
        onRestart: noop,
      }),
    );
    expect(textCell(lspHtml)).toContain("flex-[1_1_240px]");
  });
});
