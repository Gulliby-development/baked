/** What planning cost so far next to what the planned tasks should cost (`plan-cost.ts` in the core). */
export interface PlanCost {
  planning: {
    usd: number;
    complete: boolean;
    models: { model: string; usd: number; stages: string[] }[];
  };
  implementation: { model: string; usd: { low: number; high: number } } | null;
}

const usd = (n: number): string => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);

/** The approval's planning-cost line (`planCostText` in the core). */
export function planCostText(cost: PlanCost): string {
  const models = cost.planning.models.map((m) => `${m.model} ${usd(m.usd)}`).join(", ");
  const planning = `Planning so far about ${usd(cost.planning.usd)}${cost.planning.complete ? "" : " (partial: a model has no price)"}${models ? ` (${models})` : ""}`;
  const tasks = cost.implementation
    ? `; the planned tasks about ${usd(cost.implementation.usd.low)}–${usd(cost.implementation.usd.high)} on ${cost.implementation.model}`
    : "";
  return `${planning}${tasks}`;
}
