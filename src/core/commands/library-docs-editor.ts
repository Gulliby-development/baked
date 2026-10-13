/**
 * The terminal's editor for the `libraryDocs` setting (#763): a few dialogs that build a library
 * docs source, the same value the desktop's Code quality page and `PATCH /v1/settings` save.
 */
import { openSelect, promptText } from "../../components/ui/dialogs/index.js";
import { LibraryDocsSchema, type LibraryDocsSource } from "../workflows/library-docs.js";

export function describeLibraryDocs(source: LibraryDocsSource | null | undefined): string {
  if (!source) return "not set";
  return "dir" in source
    ? `directory ${source.dir}`
    : `MCP ${source.mcp.server} / ${source.mcp.tool}`;
}

/** `key=value` pairs separated by `;`, as the terminal prompt takes MCP tool arguments. */
export function parseToolArgs(text: string): Record<string, string> | string {
  const args: Record<string, string> = {};
  for (const part of text.split(";")) {
    if (!part.trim()) continue;
    const at = part.indexOf("=");
    if (at <= 0) return `Write each argument as key=value: ${part.trim()}`;
    args[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return args;
}

const required = (value: string): string | null => (value.trim() ? null : "Required.");

/**
 * Asks for a source. Resolves with the new source, null to remove it, or undefined when a dialog
 * was cancelled and nothing should change.
 */
export async function editLibraryDocs(
  current: LibraryDocsSource | null | undefined,
  servers: readonly string[],
): Promise<LibraryDocsSource | null | undefined> {
  const kind = await openSelect<"none" | "dir" | "mcp">({
    title: "Library docs source",
    skipFilter: true,
    current: !current ? "none" : "dir" in current ? "dir" : "mcp",
    options: [
      { value: "none", label: "None", description: "Implementers get no library docs." },
      { value: "dir", label: "Directory", description: "<name>@<version>.md files." },
      { value: "mcp", label: "MCP tool", description: "A tool of a server in mcpServers." },
    ],
  });
  if (!kind) return undefined;
  if (kind.value === "none") return null;
  let source: unknown;
  if (kind.value === "dir") {
    const dir = await promptText({
      title: "Library docs directory",
      message: "Absolute, relative to the project, or starting with ~.",
      placeholder: "docs/libraries",
      initial: current && "dir" in current ? current.dir : "",
      validate: required,
    });
    if (dir === null) return undefined;
    source = { dir: dir.trim() };
  } else {
    const was = current && "mcp" in current ? current.mcp : undefined;
    let server: string | null;
    if (servers.length) {
      const picked = await openSelect<string>({
        title: "Library docs MCP server",
        options: servers.map((name) => ({ value: name, label: name })),
        ...(was ? { current: was.server } : {}),
      });
      server = picked?.value ?? null;
    } else {
      server = await promptText({
        title: "Library docs MCP server",
        message: "A server of mcpServers.",
        initial: was?.server ?? "",
        validate: required,
      });
    }
    if (server === null) return undefined;
    const tool = await promptText({
      title: "Library docs MCP tool",
      initial: was?.tool ?? "",
      validate: required,
    });
    if (tool === null) return undefined;
    const argsText = await promptText({
      title: "Library docs tool arguments",
      message: "key=value pairs separated by ;. {name}, {version} and {ecosystem} are replaced.",
      placeholder: "libraryName={name}; version={version}",
      initial: Object.entries(was?.args ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join("; "),
      validate: (text) => {
        const args = parseToolArgs(text);
        return typeof args === "string" ? args : null;
      },
    });
    if (argsText === null) return undefined;
    const args = parseToolArgs(argsText) as Record<string, string>;
    source = {
      mcp: {
        server: server.trim(),
        tool: tool.trim(),
        ...(Object.keys(args).length ? { args } : {}),
      },
    };
  }
  const maxChars = await promptText({
    title: "Max characters per library",
    message: "From 500 to 50000; empty keeps the default of 8000.",
    initial: current?.maxChars !== undefined ? String(current.maxChars) : "",
    validate: (text) => {
      if (!text.trim()) return null;
      const n = Number(text.trim());
      return Number.isInteger(n) && n >= 500 && n <= 50_000
        ? null
        : "A whole number from 500 to 50000.";
    },
  });
  if (maxChars === null) return undefined;
  const parsed = LibraryDocsSchema.parse({
    ...(source as object),
    ...(maxChars.trim() ? { maxChars: Number(maxChars.trim()) } : {}),
  });
  return parsed;
}
