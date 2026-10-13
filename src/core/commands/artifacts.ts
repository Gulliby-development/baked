import { ArtifactError, type ArtifactMeta, ArtifactStore } from "../artifacts/store.js";
import { openPath } from "../utils/open-path.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

/**
 * `/artifacts`: the HTML artifacts shared by every project (docs/artifacts.md). The list opens a
 * page in the browser; `/artifacts deploy ID [prod]` asks the agent to deploy it, so the deploy
 * goes through the artifact tool and its approval like a deploy asked in words.
 */

const usage = "Usage: /artifacts | /artifacts open ID | /artifacts deploy ID [prod]";

export function artifactLine(a: ArtifactMeta): string {
  const last = a.deploys.at(-1);
  return `${a.id} v${a.version}${last ? ` · ${last.target} ${last.url}` : ""}`;
}

/** The chat message `/artifacts deploy` sends: the agent deploys with the artifact tool. */
export function deployRequest(id: string, production: boolean): string {
  return `Deploy the artifact ${id} to Vercel as a ${production ? "production" : "preview"} deployment with the artifact tool (action deploy, id ${id}, target ${production ? "production" : "preview"}).`;
}

function open(ctx: CommandContext, store: ArtifactStore, id: string): void {
  const file = store.pagePath(id);
  if (!openPath(file)) sysMsg(ctx, `Could not open a browser. The page is ${file}`);
  else sysMsg(ctx, `Opened ${id} in the browser.`);
}

export function handleArtifacts(
  input: string,
  ctx: CommandContext,
  store = new ArtifactStore(),
): void {
  const [, sub = "", id, extra] = input.trim().split(/\s+/);
  try {
    if (sub === "") {
      const items = store.list();
      if (!items.length) {
        sysMsg(
          ctx,
          "No artifacts yet. Ask the agent to save an HTML page as an artifact, or run `baked artifacts save FILE`.",
        );
        return;
      }
      ctx.openCommandPicker({
        title: "Artifacts",
        searchable: true,
        options: items.map((a) => ({ value: a.id, label: a.title, description: artifactLine(a) })),
        onSelect: (value) => open(ctx, store, value),
      });
      return;
    }
    if (sub === "open" && id) {
      open(ctx, store, id);
      return;
    }
    if (sub === "deploy" && id && (extra === undefined || extra === "prod")) {
      store.get(id);
      void ctx.chat.handleSubmit(deployRequest(id, extra === "prod"));
      return;
    }
    sysMsg(ctx, usage);
  } catch (error) {
    if (error instanceof ArtifactError) sysMsg(ctx, error.message);
    else throw error;
  }
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/artifacts", (input, ctx) => handleArtifacts(input, ctx));
}
