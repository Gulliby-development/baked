import type { ModelCatalog } from "../core/llm/model-choices.js";
import { formatContext, modelChoiceGroups } from "../core/llm/model-choices.js";
import { resolveTarget, routingClasses } from "../core/workflows/routing-edit.js";
import type { AppConfig } from "../types/index.js";

/** What `baked workflow models` prints: the class references, then the models of each provider. */
export interface WorkflowModels {
  runModel: string | null;
  classes: { ref: string; model: string | null; source: string | null }[];
  providers: ModelCatalog["providers"];
}

/** The class references a route may name, resolved against the run model, and the catalog. */
export function workflowModels(
  config: AppConfig,
  catalog: ModelCatalog,
  runModel: string | null,
): WorkflowModels {
  const routing = config.modelRouting;
  const legacy = {
    coding: config.taskRouter?.ember ?? config.taskRouter?.coding ?? undefined,
    review: config.taskRouter?.verify ?? undefined,
  };
  const classes = routingClasses(routing).map((name) => {
    const resolved = resolveTarget(
      { kind: "class", name },
      { routing, runModel, legacy, explanation: null },
    );
    return {
      ref: `$${name}`,
      model: resolved?.model ?? null,
      source: resolved?.source ?? null,
    };
  });
  return { runModel, classes, providers: catalog.providers };
}

export function formatWorkflowModels(view: WorkflowModels): string {
  const out: string[] = [];
  out.push("Model names (routes name them as $name)");
  const refW = Math.max(...view.classes.map((c) => c.ref.length), 0);
  for (const c of view.classes)
    out.push(
      `  ${c.ref.padEnd(refW)}  ${c.model ? `${c.model}  (${c.source})` : "needs a run model (--model ID)"}`,
    );
  for (const group of modelChoiceGroups({ providers: view.providers })) {
    const provider = view.providers.find((p) => p.id === group.id);
    out.push("");
    if (!group.available) {
      out.push(`${group.title} (${group.id}): ${group.note ?? ""}`);
      continue;
    }
    out.push(`${group.title} (${group.id})`);
    const idW = Math.max(...group.choices.map((c) => c.id.length), 0);
    for (const m of provider?.models ?? []) {
      const ctx = formatContext(m.contextWindow);
      out.push(`  ${m.id.padEnd(idW)}  ${m.name}${ctx ? `  ${ctx}` : ""}`.trimEnd());
    }
  }
  return `${out.join("\n")}\n`;
}
