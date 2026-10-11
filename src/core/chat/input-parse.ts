/**
 * The syntax of `@path`, `@Symbol` and `!command` in a chat message, without the code that acts on
 * it, so front ends and the chat API can test a message cheaply.
 */

/** One `@` mention in a message. `lines` is the `#10-40` suffix of a file mention. */
export interface InputMention {
  target: string;
  lines?: { start: number; end: number };
  /** Offsets of the whole mention, `@` included, in the prompt text. */
  start: number;
  end: number;
}

export interface ParsedChatInput {
  /** The command of a message that starts with `!`, without the `!`. */
  command: string | null;
  /** The text sent to the model: the whole message, or the lines after the `!` command. */
  prompt: string;
  mentions: InputMention[];
}

const MENTION_RE = /(^|[\s([{,;])@(?:"([^"\n]+)"|([^\s"'`()<>[\]{},;]+))/g;
const LINES_RE = /#L?(\d+)(?:-L?(\d+))?$/;
/** A mention that can name a symbol: `name` or `Container.member`. */
export const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Offsets covered by fenced code blocks and inline code, where `@` is literal. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

export function parseMentions(text: string): InputMention[] {
  const code = codeRanges(text);
  const mentions: InputMention[] = [];
  for (let m = MENTION_RE.exec(text); m !== null; m = MENTION_RE.exec(text)) {
    const start = m.index + (m[1]?.length ?? 0);
    if (code.some(([a, b]) => start >= a && start < b)) continue;
    const quoted = m[2] !== undefined;
    let target = quoted ? (m[2] ?? "") : (m[3] ?? "").replace(/[.,:;!?]+$/, "");
    if (!target) continue;
    const end = quoted ? m.index + m[0].length : start + 1 + target.length;
    let lines: InputMention["lines"];
    const range = LINES_RE.exec(target);
    if (range) {
      const first = Number(range[1]);
      const last = range[2] ? Number(range[2]) : first;
      if (first >= 1 && last >= first) lines = { start: first, end: last };
      target = target.slice(0, range.index);
    }
    if (!target) continue;
    mentions.push({ target, ...(lines ? { lines } : {}), start, end });
  }
  return mentions;
}

export function parseChatInput(input: string): ParsedChatInput {
  const trimmed = input.trimStart();
  const commandMatch = /^!([^\n]*)/.exec(trimmed);
  const command = commandMatch?.[1]?.trim() || null;
  const prompt = command ? trimmed.slice(commandMatch?.[0].length ?? 0).trim() : input;
  return { command, prompt, mentions: parseMentions(prompt) };
}

/** True when the input has anything `expandChatInput` would act on. */
export function hasInputReferences(input: string): boolean {
  const parsed = parseChatInput(input);
  return parsed.command !== null || parsed.mentions.length > 0;
}
