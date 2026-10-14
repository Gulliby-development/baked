/**
 * Gates from chat: any chat, the coordinator included, can list the project's gates with what
 * BAKED detects, and save gates after the user approves them on a card. The coordinator's
 * `start_run` uses the same parts to set missing gates up with the run's own card.
 */
import { tool } from "ai";
import { z } from "zod";
import type { AppConfig } from "../../types/index.js";
import {
  type GateRequest,
  gateLine,
  renderGateSetup,
  resolveGateRequests,
  saveGateChanges,
} from "../workflows/gate-setup.js";
import type { Check } from "../workflows/types.js";
import { projectDefinitions } from "../workflows/v2/propose.js";

export const GATE_TOOLS = ["list_gates", "save_gates"] as const;

export const GateRequestSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(96)
    .describe("Gate ID; a detected gate's ID alone takes its command and settings"),
  command: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .optional()
    .describe("The command line to run, such as `bun run build`; left out for a detected gate"),
  required: z.boolean().optional().describe("A run passes only when it passes; default true"),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
  scope: z
    .enum(["feature", "task"])
    .optional()
    .describe("feature: once per run (default); task: after each task"),
});

/** Where gate tools read and save, and how they ask the user. */
export interface GateToolContext {
  workspace: string;
  config: AppConfig;
  confirm(description: string): Promise<boolean>;
  /** Tells a live workflow worker about the saved list; the file is already written. */
  saved?: ((checks: Check[]) => Promise<void>) | undefined;
}

/** Saves resolved gates and tells the worker; the user approved them already. */
export async function applyGates(
  ctx: GateToolContext,
  checks: Check[],
  remove: string[] = [],
): Promise<Check[]> {
  const next = saveGateChanges(ctx.workspace, ctx.config, checks, remove);
  await ctx.saved?.(next);
  return next;
}

export const resolveGates = (ctx: GateToolContext, requests: GateRequest[]) =>
  resolveGateRequests(ctx.workspace, ctx.config, requests);

export function gateTools(ctx: GateToolContext) {
  const failed = (error: string) => ({ success: false, output: "", error });
  return {
    list_gates: tool({
      description:
        "List the project's gates (the checks every workflow run must pass, such as build, tests and lint), the ones BAKED detects in the project that are not set up yet, and the workflows that cannot start until a feature gate exists. Read it before proposing a run and before save_gates.",
      inputSchema: z.strictObject({}),
      execute: async () => {
        try {
          const ids = projectDefinitions(ctx.workspace, ctx.config).map((d) => d.id);
          return { success: true, output: renderGateSetup(ctx.workspace, ctx.config, ids) };
        } catch (err) {
          return failed(err instanceof Error ? err.message : String(err));
        }
      },
    }),
    save_gates: tool({
      description:
        "Add, change or remove the project's gates. The user sees a card with the commands and nothing is saved unless they approve it. Prefer detected gates (list_gates) by ID; for a command nothing detected, ask the user first. A gate with an existing ID replaces it.",
      inputSchema: z.strictObject({
        gates: z.array(GateRequestSchema).max(20).default([]),
        remove: z.array(z.string().trim().min(1).max(96)).max(20).default([]),
        why: z.string().trim().min(1).max(300).describe("One line on why, shown on the card"),
      }),
      execute: async ({ gates = [], remove = [], why }) => {
        if (!gates.length && !remove.length) return failed("Name gates to save or remove");
        const resolved = resolveGates(ctx, gates);
        if (!resolved.ok) return failed(resolved.error);
        const lines = [
          ...resolved.checks.map((c) => `+ ${gateLine(c)}`),
          ...remove.map((id) => `- ${id}`),
        ];
        if (!(await ctx.confirm(`Save project gates: ${why}\n${lines.join("\n")}`)))
          return failed("The user did not approve these gates. Ask what to change.");
        try {
          const next = await applyGates(ctx, resolved.checks, remove);
          return {
            success: true,
            output: `Saved. The project's gates now:\n${next.map((c) => `- ${gateLine(c)}`).join("\n") || "None."}\nNew runs use them; started runs keep theirs.`,
          };
        } catch (err) {
          return failed(err instanceof Error ? err.message : String(err));
        }
      },
    }),
  };
}
