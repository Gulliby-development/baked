import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { loadConfig } from "../../config/index.js";
import { deployArtifact, planDeploy } from "../artifacts/deploy.js";
import { ArtifactError, type ArtifactMeta, ArtifactStore } from "../artifacts/store.js";
import { VercelError } from "../artifacts/vercel.js";
import { isInside, realPath } from "../projects/paths.js";

const nullToUndef = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

const summary = (a: ArtifactMeta): string => {
  const last = a.deploys.at(-1);
  return `- ${a.id} v${a.version} "${a.title}" (${a.bytes} bytes, updated ${a.updatedAt.slice(0, 16)})${last ? ` deployed ${last.target}: ${last.url}` : ""}`;
};

/** An HTML file of the project; paths outside it are refused, symbolic links included. */
function readProjectFile(cwd: string, path: string): string {
  const file = realPath(resolve(cwd, path));
  if (!isInside(realPath(cwd), file))
    throw new ArtifactError("INVALID", `${path} is outside the project`);
  return readFileSync(file, "utf8");
}

/** What the person approves before a deploy: the page, where it goes and who can open it. */
export function deployQuestion(plan: ReturnType<typeof planDeploy>): string {
  const a = plan.artifact;
  return `Deploy artifact "${a.title}" (${a.id} v${a.version}, ${a.bytes} bytes) to Vercel as a ${plan.target} deployment in ${plan.teamId ? `team ${plan.teamId}` : "your personal account"} (project ${plan.project})? ${plan.target === "production" ? "Anyone with the link can open it." : "Only your Vercel team can open it."}`;
}

/**
 * Artifacts from any chat: HTML pages shared by every project, deployable to the user's Vercel.
 * A deploy always asks the person, in every approval mode; without a way to ask it is refused.
 */
export function createArtifactTool(opts: {
  cwd: string;
  store?: ArtifactStore;
  onApproveDeploy?: (question: string) => Promise<boolean>;
  config?: () => Parameters<typeof planDeploy>[1];
}) {
  const store = opts.store ?? new ArtifactStore();
  const config = opts.config ?? loadConfig;
  return tool({
    description:
      "Artifacts: self-contained HTML pages (styles and scripts inline) kept for the user and shared by every project and chat. " +
      "Actions: list → saved artifacts; read (id, optional version) → the page; save (html or path to an .html file in the project, optional title, id to add a version) → its id; " +
      "deploy (id, target preview|production, default preview) → publishes the latest version to the user's own Vercel account after the user approves. " +
      "Deploy only when the user asks for it.",
    inputSchema: z.object({
      action: z.enum(["list", "read", "save", "deploy"]),
      id: z.string().nullable().optional().transform(nullToUndef),
      html: z.string().nullable().optional().transform(nullToUndef).describe("For save"),
      path: z
        .string()
        .nullable()
        .optional()
        .transform(nullToUndef)
        .describe("For save: an HTML file in the project instead of html"),
      title: z.string().nullable().optional().transform(nullToUndef),
      version: z.number().int().positive().nullable().optional().transform(nullToUndef),
      target: z
        .enum(["preview", "production"])
        .nullable()
        .optional()
        .transform(nullToUndef)
        .describe("For deploy"),
    }),
    execute: async (args, { abortSignal }) => {
      try {
        switch (args.action) {
          case "list": {
            const items = store.list();
            return items.length
              ? `${items.length} artifact${items.length === 1 ? "" : "s"}:\n${items.map(summary).join("\n")}`
              : "No artifacts yet. Save one with action=save.";
          }
          case "read":
            if (!args.id) return "Name the artifact: id.";
            return store.read(args.id, args.version);
          case "save": {
            const html = args.html ?? (args.path ? readProjectFile(opts.cwd, args.path) : null);
            if (!html) return "Give the page as html, or path to an HTML file in the project.";
            const meta = store.save({
              html,
              ...(args.id ? { id: args.id } : {}),
              ...(args.title ? { title: args.title } : {}),
              project: opts.cwd,
            });
            return `Saved artifact ${meta.id} v${meta.version} "${meta.title}". Every project and chat can open or deploy it.`;
          }
          case "deploy": {
            if (!args.id) return "Name the artifact to deploy: id.";
            const target = args.target ?? "preview";
            const settings = config();
            const plan = planDeploy(store, settings, args.id, target);
            if (plan.refusal) return `Not deployed: ${plan.refusal}`;
            if (!opts.onApproveDeploy)
              return "Not deployed: this chat cannot ask for approval. Deploy from a chat that asks before actions, or run `baked artifacts deploy` yourself.";
            if (!(await opts.onApproveDeploy(deployQuestion(plan))))
              return "Not deployed: the user declined.";
            const { deployment } = await deployArtifact(store, settings, args.id, target, {
              ...(abortSignal ? { signal: abortSignal } : {}),
            });
            return `Deployed ${args.id} v${plan.artifact.version} as a ${target} deployment: ${deployment.url}`;
          }
        }
      } catch (error) {
        if (error instanceof ArtifactError || error instanceof VercelError)
          return `Artifact ${args.action} failed: ${error.message}`;
        throw error;
      }
    },
  });
}
