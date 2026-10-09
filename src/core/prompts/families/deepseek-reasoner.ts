/**
 * DeepSeek-Reasoner family — minimal prompt for deepseek-reasoner (R1 / V3.1-Think).
 *
 * deepseek-reasoner does NOT support:
 * - Function calling / tool use
 * - temperature, top_p, presence_penalty, frequency_penalty (ignored)
 * - FIM completion
 *
 * Sending full tool guidance is wasted tokens. This family ships identity +
 * answer voice only. Callers must strip `reasoning_content` from history
 * before re-sending (model returns 400 otherwise).
 */
import { SHARED_IDENTITY } from "./shared-rules.js";

export const DEEPSEEK_REASONER_PROMPT = `${SHARED_IDENTITY}

<reasoning_mode>
You are a reasoning model — Chain-of-Thought runs in reasoning_content, the final answer goes to content. Tool use is not available in this mode. Answer the user from your own reasoning and any context provided. Keep the final answer terse per <answer_voice>.
</reasoning_mode>`;
