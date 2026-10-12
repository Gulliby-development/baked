import { tool } from "ai";
import { z } from "zod";
import { docPages, readDoc, searchDocs } from "../help/docs.js";
import { CURRENT_VERSION } from "../version.js";

const nullToUndef = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

function listPages(): string {
  return [
    `BAKED ${CURRENT_VERSION} documentation (bundled with this build):`,
    ...docPages().map((p) => `- ${p.path} — ${p.title}`),
  ].join("\n");
}

function search(query: string): string {
  const hits = searchDocs(query);
  if (hits.length === 0) {
    return `No documentation matches "${query}". Try other words, or list the pages:\n${listPages()}`;
  }
  return [
    `Top matches for "${query}" — read one with action=read, page=<path>, section=<anchor>:`,
    ...hits.map((h) => `- ${h.path}#${h.anchor} — ${h.heading} (${h.pageTitle})\n  ${h.snippet}`),
  ].join("\n");
}

/** Read-only access to BAKED's own documentation, so the agent answers questions about BAKED from it. */
export function createBakedHelpTool() {
  return tool({
    description:
      "BAKED's own documentation, bundled with this build: commands, settings and config.json, providers and models, " +
      "workflows (runs, gates, checks, run memory), projects, skills, hooks, the desktop app and the local API. " +
      "Use it for any question about BAKED itself instead of guessing; quote the commands and settings it shows.\n" +
      "Actions: search (query) → matching sections as page#section; read (page, optional section) → text; list → all pages.",
    inputSchema: z.object({
      action: z.enum(["search", "read", "list"]),
      query: z.string().nullable().optional().transform(nullToUndef).describe("For search"),
      page: z
        .string()
        .nullable()
        .optional()
        .transform(nullToUndef)
        .describe("For read: page path from search or list, e.g. workflows/quick.md"),
      section: z
        .string()
        .nullable()
        .optional()
        .transform(nullToUndef)
        .describe("For read: section anchor or heading; omit for the whole page"),
    }),
    execute: async (args) => {
      if (args.action === "list") return { success: true, output: listPages() };
      if (args.action === "search") {
        if (!args.query?.trim()) {
          return { success: false, output: "search needs a query.", error: "Missing query." };
        }
        return { success: true, output: search(args.query) };
      }
      if (!args.page?.trim()) {
        return { success: false, output: "read needs a page.", error: "Missing page." };
      }
      const result = readDoc(args.page, args.section);
      return result.ok
        ? { success: true, output: result.text }
        : { success: false, output: result.error, error: result.error };
    },
  });
}
