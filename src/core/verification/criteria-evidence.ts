import { testConventions } from "../intelligence/test-frameworks.js";
import { maskNonCode, stripComments } from "../workflows/quality/code-mask.js";

/** A call: a callee with its receiver, or a fluent method after a call (`.as(`, `.Be(`). */
const CALL = /(\.\s*)?\b([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*!?)\s*(?:<[^<>()\n]*>\s*)?\(/g;

/**
 * Remove diagnostic arguments, keeping input and expected-value arguments in place (#1629). Which
 * arguments are messages comes from the assertion table of the file's frameworks (#1650).
 * Comments are removed too (#1846): R57 modeplan answered a refusal with
 * `// Expected rows include (6,d,1777,0777,"/tmp")`, which held the row it did not test.
 */
export function caseEvidence(path: string, text: string): string {
  // Host-written acceptance data is evidence, even when a value resembles assertion code.
  if (path.endsWith(".json")) return text;
  const { calls, messageArgument } = testConventions(path);
  const code = maskNonCode(path, text);
  const out = stripComments(path, text).split("");
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (out[i] !== "\n") out[i] = " ";
  };
  for (const call of code.matchAll(CALL)) {
    const callee = (call[1] ? "." : "") + (call[2] ?? "").replace(/\s+/g, "");
    const rule = calls.find((c) => c.callee.test(callee));
    if (!rule) continue;
    const start = call.index + call[0].length;
    const stack: string[] = [];
    const args: [number, number][] = [];
    let from = start;
    for (let i = start; i < code.length; i++) {
      const c = code[i] ?? "";
      if ("([{".includes(c)) stack.push(c);
      else if (")]}".includes(c)) {
        if (!stack.length) {
          if (code.slice(from, i).trim()) args.push([from, i]);
          break;
        }
        stack.pop();
      } else if (c === "," && !stack.length) {
        args.push([from, i]);
        from = i + 1;
      }
    }
    const texts = args.map(([begin, end]) => code.slice(begin, end));
    const head = code.slice(0, call.index);
    const chain = head.slice(
      Math.max(head.lastIndexOf(";"), head.lastIndexOf("{"), head.lastIndexOf("}")) + 1,
    );
    const messages = new Set(rule.messages(texts, { code, chain }));
    for (const [i, arg] of texts.entries()) if (messageArgument?.test(arg)) messages.add(i);
    for (const i of messages) {
      const span = args[i];
      if (span) blank(span[0], span[1]);
    }
  }
  // Python's assert condition, message has no enclosing call; the statement may span lines.
  if (path.endsWith(".py")) {
    for (const statement of code.matchAll(/^[ \t]*assert\b/gm)) {
      let depth = 0;
      let message = -1;
      let i = statement.index + statement[0].length;
      for (; i < code.length; i++) {
        const c = code[i] ?? "";
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
        else if (c === "," && !depth && message < 0) message = i;
        else if ((c === "\n" && !depth && code[i - 1] !== "\\") || (c === ";" && !depth)) break;
      }
      if (message >= 0) blank(message, i);
    }
  }
  return out.join("");
}
