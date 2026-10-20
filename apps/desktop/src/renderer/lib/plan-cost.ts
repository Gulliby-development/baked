/** What planning cost so far next to what the planned tasks should cost (`plan-cost.ts` in the core). */
export interface PlanCost {
  planning: {
    usd: number;
    complete: boolean;
    models: { model: string; usd: number; stages: string[] }[];
  };
  /**
   * `rate`: what priced a token (absent on older backends, which used the default mix).
   * `otherModels`: the token range came from other models' tasks.
   */
  implementation: {
    model: string;
    usd: { low: number; high: number };
    rate?: "run" | "mix" | "default";
    otherModels?: boolean;
  } | null;
}

const RATE_TEXT = {
  run: " at this run's dollars per token so far",
  mix: " at this run's mix of cached and uncached tokens",
  default: "",
} as const;

const OTHER_MODELS_TEXT =
  " (token range from other models' tasks: this model has too few of its own, so it may be far off)";

const usd = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

/** The approval's planning-cost line (`planCostText` in the core). */
export function planCostText(cost: PlanCost): string {
  const models = cost.planning.models.map((m) => `${m.model} ${usd(m.usd)}`).join(", ");
  const planning = `Planning so far about ${usd(cost.planning.usd)}${cost.planning.complete ? "" : " (partial: a model has no price)"}${models ? ` (${models})` : ""}`;
  const tasks = cost.implementation
    ? `; the planned tasks about ${usd(cost.implementation.usd.low)}–${usd(cost.implementation.usd.high)} on ${cost.implementation.model}${RATE_TEXT[cost.implementation.rate ?? "default"]}${cost.implementation.otherModels ? OTHER_MODELS_TEXT : ""}`
    : "";
  return `${planning}${tasks}`;
}
