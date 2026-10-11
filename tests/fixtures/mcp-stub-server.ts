// A local stdio MCP server for tests: `echo` returns its text, `stamp` returns a fixed value.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "stub", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo the text back", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool("stamp", { description: "Return a stamp", inputSchema: {} }, async () => ({
  content: [{ type: "text", text: "stamped" }],
}));
await server.connect(new StdioServerTransport());
