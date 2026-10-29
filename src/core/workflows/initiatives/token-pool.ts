import { tokenText } from "../estimate.js";
import {
  EXTEND_WITHIN_DOLLARS_MODES,
  STAGE_RESERVE_MODES,
  TIME_POOL_GROWTH_MODES,
} from "../schemas.js";
import { centsUp } from "../stage-reserve.js";
import type { StopMode } from "../stop-reasons.js";
import {
  calibrationRatio,
  MIN_CALIBRATION_FEATURES,
  ownPlanNeed,
  type PlannedRun,
} from "./estimate.js";
import { TIME_STEP_MS } from "./time-pool.js";

// The initiative's shared token pool beside the person's dollar cap (#2042). Part of the
// cap-growth hot module (.github/hot-modules.json). Bench round 66 (nodepluck) parked select at
// 27.7M of a 30M pool with three features unstarted while the $30 cap had $5.98 left: nothing
// warned while the pool still had room, and the block named no amount.

/** Suggested pool sizes are rounded up to this step, so the answer is a short number. */
export const POOL_STEP = 100_000;
const roundUp = (n: number): number => Math.ceil(n / POOL_STEP) * POOL_STEP;
const roundDown = (n: number): number => Math.floor(n / POOL_STEP) * POOL_STEP;
const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Whether the host grows the token pool on its own inside the person's dollar cap
 * (`workflows.extendWithinDollars`). `shadow`, the default, records the decision as a
 * `decision.would_extend` initiative event and changes nothing; `on` (opt-in, #2060) applies the
 * same decision as a `budget.extended` event `by: "host"` and the parked feature starts; `off`
 * records nothing. Making `on` the default is its own pull request.
 */
export { EXTEND_WITHIN_DOLLARS_MODES };
export type ExtendWithinDollars = (typeof EXTEND_WITHIN_DOLLARS_MODES)[number];
export const DEFAULT_EXTEND_WITHIN_DOLLARS: ExtendWithinDollars = "shadow";

/**
 * Whether a feature run that finished its tasks grows its dollar bound by the reserve of its
 * remaining review and convergence before its cost ceiling stops it (`workflows.stageReserve`,
 * #2241, `stageReserveDecision` in `growth.ts`). `shadow`, the default, records a
 * `decision.would_extend` initiative event and the run still stops; `on` (opt-in) grows the bound;
 * `off` records nothing. Making `on` the default is its own pull request.
 */
export { STAGE_RESERVE_MODES };
export type StageReserveMode = (typeof STAGE_RESERVE_MODES)[number];
export const DEFAULT_STAGE_RESERVE: StageReserveMode = "shadow";

/**
 * Whether the host would grow the initiative's shared active time on its own while the token pool
 * and the dollar cap have room (`workflows.timePoolGrowth`, #2346, `timePoolExtensionDecision`).
 * `shadow`, the default, records a `decision.would_extend` initiative event and changes nothing;
 * `off` records nothing. Growing the time for real is its own pull request.
 */
export { TIME_POOL_GROWTH_MODES };
export type TimePoolGrowthMode = (typeof TIME_POOL_GROWTH_MODES)[number];
export const DEFAULT_TIME_POOL_GROWTH: TimePoolGrowthMode = "shadow";

/**
 * Every limit a person set that the host grows, or would grow, on its own, with the other cap the
 * person set that bounds it. A new growth registers here, ships in shadow and adds its case to
 * `tests/workflow-scenario-initiative-token-pool.test.ts`, which fails on a `decision.would_extend`
 * event whose reason is missing here.
 */
export const HOST_POOL_GROWTHS = {
  "extend-within-dollars": {
    label: "The initiative's token pool parks a feature while its dollar cap has room",
    grows: "the shared token pool (--budget-tokens)",
    boundBy: "the dollar cap (--budget-usd) with its tolerance",
    modes: EXTEND_WITHIN_DOLLARS_MODES,
    defaultMode: DEFAULT_EXTEND_WITHIN_DOLLARS,
  },
  "stage-reserve": {
    label:
      "A feature run that finished its tasks would stop on its cost ceiling before its review and convergence",
    grows: "the feature run's dollar growth bound (sizing.maxRunCostUsd)",
    boundBy: "the initiative's dollar cap (--budget-usd) with its tolerance",
    modes: STAGE_RESERVE_MODES,
    defaultMode: DEFAULT_STAGE_RESERVE,
  },
  "time-pool": {
    label:
      "The initiative's time forecast passes its shared active time while its tokens have room",
    grows: "the shared active time (--time-ms)",
    boundBy:
      "the token pool (--budget-tokens) at the measured pace, and the dollar cap (--budget-usd) with its tolerance when set",
    modes: TIME_POOL_GROWTH_MODES,
    defaultMode: DEFAULT_TIME_POOL_GROWTH,
  },
} as const;
export type PoolGrowthReason = keyof typeof HOST_POOL_GROWTHS;

/** A feature still waiting for a run, with its estimated tokens (calibrated once measured). */
export interface PoolFeature {
  id: string;
  low: number;
  high: number;
}

/** A feature of the split as the pool's measured forecast reads it. */
export interface ForecastFeature {
  id: string;
  accepted: boolean;
  /** A feature with host-written skeleton files never calibrates the others. */
  skeleton: boolean;
  /** Tokens its runs used so far. */
  spent: number;
  /**
   * The low estimate the share gate gave it at its start (`feature.share_gate` pass), or for a
   * feature without a run its current one; null when neither is known.
   */
  low: number | null;
  /** The estimate's point forecast of the feature, for one without a low. */
  expected: number;
}

/**
 * The ratio a budget decision scales the features still to run by (a block, a park, a growth):
 * the measured actual-to-low ratio blended like the dollar re-forecast (`calibrationRatio`: a third
 * at three accepted non-skeleton features, full weight at five), so three features do not decide
 * alone. Null before three.
 */
export const decisionRatio = (measured: number, low: number, count: number): number | null =>
  calibrationRatio(measured, low, count);

/**
 * The ratio advice scales them by (the forecast notice, #2062): the measured actual-to-low ratio
 * itself from three accepted features, capped like the blend. A notice changes nothing, so it
 * need not wait for the blend: in R66 nodepluck three features had used 2.2 times their lows at
 * 14:27, the blend said 1.4x and a forecast under the pool, and the notice came 13 minutes later,
 * 41 seconds before select parked. Null before three.
 */
export const adviceRatio = (measured: number, low: number, count: number): number | null =>
  count < MIN_CALIBRATION_FEATURES
    ? null
    : calibrationRatio(measured, low, Number.MAX_SAFE_INTEGER);

/** A pool forecast at one ratio. */
export interface RatioForecast {
  forecastTokens: number;
  ratio: number;
}

/**
 * The pool's measured forecast (#2042): what was used plus each unfinished feature's low estimate
 * scaled by how far the accepted features landed above theirs (actual over the low the gate gave
 * them at their start), never below what a running feature used. `forecastTokens` and `ratio` are
 * at the `decisionRatio`, which budget decisions read; `advice` is at the `adviceRatio`, which
 * only the notice reads. Null before three accepted non-skeleton features. In R66 nodepluck the
 * accepted features had used 2.33, 1.47, 0.93 and 4.07 times their low ends while the estimate's
 * point forecast stayed under the pool.
 */
export function poolForecast(
  usedTokens: number,
  features: readonly ForecastFeature[],
): (RatioForecast & { advice: RatioForecast }) | null {
  const measured = features.filter((f) => f.accepted && !f.skeleton && f.low !== null && f.low > 0);
  const spent = measured.reduce((sum, f) => sum + f.spent, 0);
  const lows = measured.reduce((sum, f) => sum + (f.low ?? 0), 0);
  const blended = decisionRatio(spent, lows, measured.length);
  const raw = adviceRatio(spent, lows, measured.length);
  if (blended === null || raw === null) return null;
  const at = (ratio: number): RatioForecast => ({
    forecastTokens: Math.round(
      usedTokens +
        features
          .filter((f) => !f.accepted)
          .reduce(
            (sum, f) => sum + Math.max(0, (f.low === null ? f.expected : f.low * ratio) - f.spent),
            0,
          ),
    ),
    ratio: Math.round(ratio * 100) / 100,
  });
  return { ...at(blended), advice: at(raw) };
}

/** An open feature run with a sized plan, as the plan charge reads it (#2100, #2056). */
export interface PlanChargeRun {
  featureId: string;
  runId: string;
  usedTokens: number;
  /** The run's token limit: what the pool holds for it without the plan charge. */
  limitTokens: number;
  /** What the run's latest plan sizing expects the whole run to use (`plannedRunTokens`). */
  plan: PlannedRun;
  /** What the plan charge holds for it (`planChargeTokens`). */
  chargeTokens: number;
  /** The dollars the run spent plus what its attempts in flight reserved (#2124). */
  usedUsd?: number;
  /** What the dollar budget holds for it without the plan charge: max(usedUsd, its maxCostUsd). */
  limitUsd?: number;
  /**
   * What the plan charge holds for it in dollars (`planChargeUsd`); null while the initiative's
   * task-call rate is unmeasured or the run has no dollar limit, and it holds `limitUsd` then.
   */
  chargeUsd?: number | null;
}

/**
 * The plan charge in dollars (#2124): the plan charge's tokens at the initiative's task-call rate
 * (`taskCallRate`, #2124), never below what the run spent and reserved. Null without a measured
 * rate: there is no plan-to-actual dollar ratio, and a run then holds its dollar limit, as before.
 */
export function planChargeUsd(
  chargeTokens: number,
  usedUsd: number,
  rate: number | null,
): number | null {
  return rate === null ? null : Math.max(usedUsd, chargeTokens * rate);
}

/**
 * What the pool holds for an open feature run once its plan is sized (#2100, #2056): the high end
 * of the plan's need at the measured plan-to-actual ratio (`ownPlanNeed`, #2043), never below what
 * the run used. One rule both ways: it frees what a start share holds above the plan (R67 ampwhy
 * held 30.5M at cli's gate while its runs had used 0.05M to 6.6M each) and adds what a plan prices
 * above the run's limit (#2056).
 *
 * One exception (#2253): while the ratio is unmeasured, a plan whose whole range sits above the
 * run's limit (its low end above it) contradicts the size class that set the limit, and nothing
 * yet says which one is right. The run is held at its plan's expected need then, still above its
 * limit, not at the high end. R60 wheeltags' names was sized at 10.3M-14.1M against its 8.0M
 * limit and used 4.57M; at its high end the charge parked dead. Of the corpus's 24 plans priced
 * above their limits while unmeasured, names is the only one whose low end was above it; the high
 * end stays where a plan straddles the limit (R71 xmlvet's scanner, 4.26M-11.75M against 8.0M,
 * used 12.10M). The dollar charge (`planChargeUsd`) prices these tokens, so it follows.
 */
export function planChargeTokens(
  usedTokens: number,
  plan: PlannedRun,
  ratio: number | null,
  limitTokens: number,
): number {
  const need = ownPlanNeed(plan, ratio);
  const contradicts = ratio === null && plan.low > limitTokens;
  return Math.max(usedTokens, contradicts ? need.low : need.high);
}

/**
 * The plan charge of an initiative's open feature runs (the `initiative-plan-charge` stop
 * reason). In `enforce` the pool's `committedTokens` counts each run with a sized plan at its
 * charge; otherwise at its limit, as before, and a `decision.would_release` event records what
 * the charge would free (or add) and whether a parked feature would have started.
 */
export interface PlanChargeView {
  mode: StopMode;
  /** The measured plan-to-actual ratio the charges use; null while unmeasured (times 1). */
  ratio: number | null;
  runs: PlanChargeRun[];
  /** What all runs hold with each open run at max(used, limit): the rule before #2100. */
  limitCommittedTokens: number;
  /** The same with each run of `runs` at its charge. */
  planCommittedTokens: number;
  /** limitCommittedTokens - planCommittedTokens: positive frees tokens, negative adds them. */
  releasedTokens: number;
  /**
   * The dollar side (#2124), null without a dollar budget: the task-call rate the charges use,
   * what all runs hold with each open run at max(used, cap) (`committedUsd`), the same with each
   * priced run at its `chargeUsd`, and the difference (positive frees dollars).
   */
  usd: {
    taskRate: number | null;
    limitCommittedUsd: number;
    planCommittedUsd: number;
    releasedUsd: number;
  } | null;
}

/**
 * The plan charge over the open runs with a sized plan, or null when none has one.
 * `limitCommitted` is what the pool holds with every open run at max(used, limit).
 */
export function planCharge(
  mode: StopMode,
  ratio: number | null,
  limitCommitted: number,
  runs: readonly Omit<PlanChargeRun, "chargeTokens" | "chargeUsd">[],
  dollars?: { taskRate: number | null; limitCommittedUsd: number },
): PlanChargeView | null {
  if (!runs.length) return null;
  const charged = runs.map((run) => {
    const chargeTokens = planChargeTokens(run.usedTokens, run.plan, ratio, run.limitTokens);
    return {
      ...run,
      chargeTokens,
      ...(dollars
        ? {
            chargeUsd:
              run.usedUsd === undefined || run.limitUsd === undefined
                ? null
                : planChargeUsd(chargeTokens, run.usedUsd, dollars.taskRate),
          }
        : {}),
    };
  });
  const released = charged.reduce(
    (sum, run) => sum + Math.max(run.usedTokens, run.limitTokens) - run.chargeTokens,
    0,
  );
  const releasedUsd = charged.reduce(
    (sum, run) =>
      run.chargeUsd === null || run.chargeUsd === undefined
        ? sum
        : sum + (run.limitUsd ?? 0) - run.chargeUsd,
    0,
  );
  return {
    mode,
    ratio,
    runs: charged,
    limitCommittedTokens: limitCommitted,
    planCommittedTokens: limitCommitted - released,
    releasedTokens: released,
    usd: dollars
      ? {
          taskRate: dollars.taskRate,
          limitCommittedUsd: dollars.limitCommittedUsd,
          planCommittedUsd: dollars.limitCommittedUsd - releasedUsd,
          releasedUsd,
        }
      : null,
  };
}

/** The dollar side the token pool is compared with: the initiative's `budget.cost`. */
export interface PoolCost {
  capUsd: number | null;
  ceilingUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  forecastUsd: number | null;
}

export interface PoolInputs {
  initiativeId: string;
  limitTokens: number;
  usedTokens: number;
  /** Used tokens plus what open runs may still use under their limits. */
  committedTokens: number;
  /**
   * The forecast of the whole initiative: `poolForecast` once three features are measured, else
   * the estimate's point forecast (`InitiativeEstimate.expectedTokens`: what was used plus each
   * unfinished feature's expected tokens). Null without an estimate (or in an old record).
   */
  forecastTokens: number | null;
  /** The measured actual-to-low ratio that scales the features still to run; null before it. */
  ratio: number | null;
  /**
   * The forecast at the raw measured ratio (`poolForecast`'s `advice`), which only the notice
   * reads (#2062); absent or null in a block, a park, a growth and records before it.
   */
  advice?: RatioForecast | null;
  /** Features of the split. */
  features: number;
  waiting: PoolFeature[];
  cost: PoolCost;
}

/** The token pool as `initiative show`, the TUI and the desktop budget view read it. */
export interface TokenPoolView {
  limitTokens: number;
  usedTokens: number;
  committedTokens: number;
  /** The forecast at the decision ratio (`ratio`), which budget decisions read. */
  forecastTokens: number | null;
  /**
   * The forecast at the raw measured ratio, which the notice and its suggestion read (#2062); null
   * before three features are measured, or where no notice is computed (a block, a park).
   */
  advice: RatioForecast | null;
  ratio: number | null;
  /**
   * The pool that starts every waiting feature at its high estimate beside what open runs hold,
   * rounded up: what a block on the pool suggests.
   */
  coverTokens: number;
  /**
   * What the notice suggests extending the pool to; null while the forecast fits the pool. With a
   * dollar cap that pays for more tokens than the pool at the measured rate, the tokens it pays for
   * (`dollarTokens`, #2244); else the forecast, and no less than what starts every waiting
   * feature at its low estimate, rounded up.
   */
  suggestedTokens: number | null;
  /** Dollars per million tokens the initiative paid so far; null before it spent both. */
  usdPerMillion: number | null;
  /** The tokens the dollar cap pays for at that rate; null without a cap or a rate. */
  capTokens: number | null;
  /** Set when the forecast is above the pool, while the pool still has room. */
  notice: string | null;
}

/** The token pool, its forecast and what to extend it to (#2042). */
export function tokenPool(inputs: PoolInputs): TokenPoolView {
  const { limitTokens, usedTokens, committedTokens, forecastTokens, cost } = inputs;
  const advice = inputs.advice ?? null;
  const coverTokens = roundUp(committedTokens + inputs.waiting.reduce((sum, f) => sum + f.high, 0));
  const lows = committedTokens + inputs.waiting.reduce((sum, f) => sum + f.low, 0);
  // The notice warns on the higher of the two forecasts: advice may run ahead of the blend.
  const noticed =
    forecastTokens === null ? null : Math.max(forecastTokens, advice?.forecastTokens ?? 0);
  const usdPerMillion =
    usedTokens > 0 && cost.spentUsd > 0 ? (cost.spentUsd / usedTokens) * 1_000_000 : null;
  const capTokens = cost.capUsd === null ? null : tokensForUsd(cost.capUsd, usdPerMillion);
  // Advice only (#2244): the ratio forecast swings with the heavy features (R71 xmlvet advised
  // 31.6M at 1.7x and 50.9M at 3.1x for a round that used 35.8M), while what the cap pays for at
  // the measured rate is the pool the person's own dollar limit already sets.
  const byDollars = dollarTokens(capTokens, limitTokens);
  const suggestedTokens =
    noticed !== null && noticed > limitTokens
      ? (byDollars ?? roundUp(Math.max(noticed, lows)))
      : null;
  const pool: TokenPoolView = {
    limitTokens,
    usedTokens,
    committedTokens,
    forecastTokens,
    advice,
    ratio: inputs.ratio,
    coverTokens,
    suggestedTokens,
    usdPerMillion: usdPerMillion === null ? null : Math.round(usdPerMillion * 100) / 100,
    capTokens,
    notice: null,
  };
  if (forecastTokens !== null && suggestedTokens !== null) {
    const ratio = advice?.ratio ?? inputs.ratio;
    const basis =
      ratio !== null
        ? `At the measured ${ratio.toFixed(1)}x of the estimates`
        : "At the estimates so far";
    // Both forecasts, when the blend that budget decisions use says another figure (#2062).
    const blended =
      advice &&
      inputs.ratio !== null &&
      tokenText(advice.forecastTokens) !== tokenText(forecastTokens)
        ? `${tokenText(forecastTokens)} at the blended ${inputs.ratio.toFixed(1)}x that budget decisions use; `
        : "";
    const command = `baked workflow initiative extend ${inputs.initiativeId} --tokens ${suggestedTokens}`;
    const extend =
      byDollars !== null && cost.capUsd !== null && usdPerMillion !== null
        ? `Extend to ${tokenText(suggestedTokens)}, what the ${usd(cost.capUsd)} cap pays for at ${usd(usdPerMillion)} per million, so the pool stops no feature before the dollar cap does (${command}).`
        : `Extend to ${tokenText(suggestedTokens)} (${command})${dollarRoom(pool, cost)}.`;
    pool.notice = `${basis} the ${inputs.features} features need about ${tokenText(advice?.forecastTokens ?? forecastTokens)} tokens (${blended}${tokenText(usedTokens)} used); the shared pool is ${tokenText(limitTokens)}. ${extend}`;
  }
  return pool;
}

/**
 * The pool a dollar cap implies (#2244): the tokens the cap pays for at a measured or history
 * price, rounded down to `POOL_STEP` so it stays inside the dollars, when that is above the pool;
 * null without a cap, a price, or when the pool already holds that many. Advice reads it (the
 * forecast notice, the split approval); no decision does.
 */
export function dollarTokens(capTokens: number | null, limitTokens: number): number | null {
  if (capTokens === null) return null;
  const tokens = roundDown(capTokens);
  return tokens > limitTokens ? tokens : null;
}

/**
 * The pool a token block suggests (#2367): the waiting features' high-estimate cover, held to
 * what the dollar cap pays for (rounded down) as the notice and the split approval hold it
 * (#2244), and as the host's extension does. When the cap pays for too few tokens to start every
 * waiting feature at its low estimate, the cover stays and `usd` names the cap that pays for it
 * at the measured rate, so the remedy raises both. Null when the pool already covers the highs.
 */
export function affordableTokens(
  pool: TokenPoolView,
  inputs: Pick<PoolInputs, "limitTokens" | "committedTokens" | "waiting" | "cost">,
): { tokens: number; usd: number | null } | null {
  const cover = pool.coverTokens;
  if (cover <= inputs.limitTokens) return null;
  const { cost } = inputs;
  if (pool.capTokens === null || cost.capUsd === null) return { tokens: cover, usd: null };
  const tokens = Math.min(cover, roundDown(pool.capTokens));
  const lows = inputs.waiting.reduce((sum, f) => sum + f.low, 0);
  if (tokens > inputs.limitTokens && tokens - inputs.committedTokens >= lows)
    return { tokens, usd: null };
  const perToken = cost.spentUsd / pool.usedTokens;
  return { tokens: cover, usd: Math.max(cost.capUsd, centsUp(cover * perToken)) };
}

/** What the cap's tokens mean for the remedy, after a sentence that names them (#2367). */
export function affordableClause(
  pool: TokenPoolView,
  remedy: { tokens: number; usd: number | null } | null,
): string {
  if (!remedy) return "";
  if (remedy.usd !== null)
    return `, too few to start the waiting features: a pool of ${tokenText(remedy.tokens)} also needs a dollar cap of ${usd(remedy.usd)}`;
  if (remedy.tokens < pool.coverTokens)
    return `, so extend to ${tokenText(remedy.tokens)} (${remedy.tokens} tokens)`;
  return "";
}

/** The tokens `capUsd` pays for at `usdPerMillion`; null without a price that gives a count. */
export function tokensForUsd(capUsd: number, usdPerMillion: number | null): number | null {
  if (usdPerMillion === null || usdPerMillion <= 0) return null;
  const tokens = Math.floor((capUsd / usdPerMillion) * 1_000_000);
  return Number.isSafeInteger(tokens) ? tokens : null;
}

/** What the dollar cap says beside the pool, for a notice or a block message. */
function dollarRoom(pool: TokenPoolView, cost: PoolCost): string {
  if (cost.capUsd === null) return "";
  if (pool.capTokens !== null && pool.usdPerMillion !== null)
    return `; the ${usd(cost.capUsd)} cap would pay for about ${tokenText(pool.capTokens)} at ${usd(pool.usdPerMillion)} per million`;
  return `; the ${usd(cost.capUsd)} cap has ${usd(cost.remainingUsd ?? 0)} left`;
}

/**
 * The amounts a token block names: how many more tokens start the parked feature, the pool that
 * covers every waiting feature's high estimate, and the dollar room (#2042).
 */
export function poolShortText(
  pool: TokenPoolView,
  parked: PoolFeature,
  available: number,
  waiting: PoolFeature[],
  cost: PoolCost,
  remedy: { tokens: number; usd: number | null } | null = null,
): string {
  const start = Math.max(0, parked.low - available);
  const names = waiting.map((f) => f.id).join(", ");
  const cover = pool.coverTokens;
  const dollars =
    cost.capUsd === null
      ? ""
      : ` The dollar cap has ${usd(cost.remainingUsd ?? 0)} left (${usd(cost.spentUsd)} of ${usd(cost.capUsd)} spent${cost.forecastUsd !== null ? `, forecast ${usd(cost.forecastUsd)}` : ""})${pool.capTokens !== null && pool.usdPerMillion !== null ? ` and would pay for about ${tokenText(pool.capTokens)} tokens at ${usd(pool.usdPerMillion)} per million${affordableClause(pool, remedy)}` : ""}.`;
  return `${parked.id} needs ${start} more tokens to start; a pool of ${tokenText(cover)} (${cover} tokens, ${Math.max(0, cover - pool.limitTokens)} more than ${tokenText(pool.limitTokens)}) covers the high estimates of ${names}.${dollars}`;
}

/** The host's decision on a parked feature: whether it would extend the pool inside the dollar cap. */
export interface PoolExtension {
  reason: PoolGrowthReason;
  wouldExtend: boolean;
  /** The pool after the extension; null when it would not extend. */
  toTokens: number | null;
  byTokens: number | null;
  /** Why it would or would not, in words. */
  why: string;
}

/**
 * Whether the host would extend the token pool to start a feature parked on it (#2042): only with
 * a dollar cap the person set, a measured dollar forecast within its ceiling, and an extension the
 * cap pays for at the measured rate that still starts every waiting feature at its low estimate.
 * It never raises a dollar, call or time limit. The extension is the pool a block suggests (what
 * covers the waiting features' high estimates), held to the tokens the cap pays for.
 */
export function poolExtensionDecision(inputs: PoolInputs, pool = tokenPool(inputs)): PoolExtension {
  const reason = "extend-within-dollars" as const;
  const no = (why: string): PoolExtension => ({
    reason,
    wouldExtend: false,
    toTokens: null,
    byTokens: null,
    why,
  });
  const { cost } = inputs;
  if (cost.capUsd === null || cost.ceilingUsd === null)
    return no("No dollar cap: a pool the person set alone is never grown.");
  if (pool.coverTokens <= inputs.limitTokens)
    return no("The pool already covers the waiting features.");
  if (cost.forecastUsd === null) return no("No measured dollar forecast yet.");
  if (cost.forecastUsd > cost.ceilingUsd)
    return no(
      `The dollar forecast ${usd(cost.forecastUsd)} is above the ${usd(cost.ceilingUsd)} ceiling.`,
    );
  const toTokens =
    pool.capTokens === null
      ? pool.coverTokens
      : Math.min(pool.coverTokens, roundDown(pool.capTokens));
  const lows = inputs.waiting.reduce((sum, f) => sum + f.low, 0);
  if (toTokens <= inputs.limitTokens || toTokens - inputs.committedTokens < lows)
    return no(
      `The ${usd(cost.capUsd)} cap pays for about ${tokenText(pool.capTokens ?? 0)} tokens, too few to start the waiting features.`,
    );
  return {
    reason,
    wouldExtend: true,
    toTokens,
    byTokens: toTokens - inputs.limitTokens,
    why: `The dollar forecast ${usd(cost.forecastUsd)} is within the ${usd(cost.ceilingUsd)} ceiling${pool.capTokens !== null ? ` and the ${usd(cost.capUsd)} cap pays for about ${tokenText(pool.capTokens)} tokens` : ""}: the pool would grow from ${tokenText(inputs.limitTokens)} to ${tokenText(toTokens)}.`,
  };
}

/** What the time-pool growth reads (#2346): the shared time's forecast, the token pool, the dollars. */
export interface TimePoolGrowthInputs {
  initiativeId: string;
  limitMs: number;
  usedMs: number;
  /** The time forecast at the measured pace (`budget.time`); null without a pace or a forecast. */
  forecastMs: number | null;
  /** What the time notice suggests; null while the forecast fits. */
  suggestedMs: number | null;
  /** The measured pace the forecast is at; null without one. */
  tokensPerMinute: number | null;
  limitTokens: number;
  usedTokens: number;
  cost: { capUsd: number | null; ceilingUsd: number | null; forecastUsd: number | null };
}

/** The host's decision on the shared time: whether it would extend it, and to what. */
export interface TimePoolExtension {
  reason: "time-pool";
  wouldExtend: boolean;
  /** The time the token pool still runs at the pace, beside the time used; null without a pace. */
  capMs: number | null;
  /** The time after the extension; null when it would not extend. */
  toMs: number | null;
  byMs: number | null;
  why: string;
}

/**
 * Whether the host would extend the initiative's shared active time (#2346): only while the time
 * forecast at the measured pace passes the limit, the dollar forecast is within its ceiling (with
 * a dollar cap set; measured, not before), and the token pool still has the tokens to run longer
 * at that pace. The extension is the time notice's suggestion, held to the time used plus what the
 * token pool's remaining tokens take at the pace (rounded down to `TIME_STEP_MS`). It never raises
 * a token, call or dollar limit.
 */
export function timePoolExtensionDecision(inputs: TimePoolGrowthInputs): TimePoolExtension {
  const reason = "time-pool" as const;
  const pace = inputs.tokensPerMinute;
  const capMs =
    pace && pace > 0
      ? inputs.usedMs +
        Math.round((Math.max(0, inputs.limitTokens - inputs.usedTokens) / pace) * 60_000)
      : null;
  const no = (why: string): TimePoolExtension => ({
    reason,
    wouldExtend: false,
    capMs,
    toMs: null,
    byMs: null,
    why,
  });
  if (capMs === null || inputs.forecastMs === null) return no("No measured pace or forecast yet.");
  if (inputs.suggestedMs === null || inputs.forecastMs <= inputs.limitMs)
    return no("The time forecast fits the shared time.");
  const { cost } = inputs;
  if (cost.capUsd !== null) {
    if (cost.forecastUsd === null) return no("No measured dollar forecast yet.");
    if (cost.ceilingUsd !== null && cost.forecastUsd > cost.ceilingUsd)
      return no(
        `The dollar forecast ${usd(cost.forecastUsd)} is above the ${usd(cost.ceilingUsd)} ceiling.`,
      );
  }
  const toMs = Math.min(inputs.suggestedMs, Math.floor(capMs / TIME_STEP_MS) * TIME_STEP_MS);
  const min = (ms: number): number => Math.round(ms / 60_000);
  if (toMs <= inputs.limitMs)
    return no(
      `The ${tokenText(inputs.limitTokens)} token pool runs out at about ${min(capMs)} min of active time at the pace, before more time would help.`,
    );
  return {
    reason,
    wouldExtend: true,
    capMs,
    toMs,
    byMs: toMs - inputs.limitMs,
    why: `The time forecast ${min(inputs.forecastMs)} min passes the shared ${min(inputs.limitMs)} min while the ${tokenText(inputs.limitTokens)} token pool runs about ${min(capMs)} min at the pace${cost.capUsd !== null && cost.forecastUsd !== null ? ` and the dollar forecast ${usd(cost.forecastUsd)} is within the ${usd(cost.ceilingUsd ?? cost.capUsd)} ceiling` : ""}: the shared time would grow from ${min(inputs.limitMs)} to ${min(toMs)} min.`,
  };
}
