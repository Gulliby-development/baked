import { maskNonCode } from "../workflows/quality/code-mask.js";

/** Remove diagnostic arguments, keeping input and expected-value arguments in place (#1629). */
export function caseEvidence(path: string, text: string): string {
  // Host-written acceptance data is evidence, even when a value resembles assertion code.
  if (path.endsWith(".json")) return text;
  const code = maskNonCode(path, text);
  const out = text.split("");
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (out[i] !== "\n") out[i] = " ";
  };
  for (const call of code.matchAll(
    /\b(assert(?:_eq|_ne)?!|assert|assertEquals|assertNotEquals|assertTrue|assertFalse|Assert\.(?:True|False|AreEqual|AreNotEqual)|expect|[A-Za-z_]\w*\.(?:Fatalf?|Errorf?))\s*\(/g,
  )) {
    const name = call[1] ?? "";
    const start = call.index + call[0].length;
    const stack: string[] = [];
    const args: [number, number][] = [];
    let from = start;
    for (let i = start; i < code.length; i++) {
      const c = code[i] ?? "";
      if ("([{".includes(c)) stack.push(c);
      else if (")]}".includes(c)) {
        if (!stack.length) {
          args.push([from, i]);
          break;
        }
        stack.pop();
      } else if (c === "," && !stack.length) {
        args.push([from, i]);
        from = i + 1;
      }
    }
    const message = /\.(?:Fatalf?|Errorf?)$/.test(name)
      ? 0
      : /(?:_eq|_ne)!$|(?:AreEqual|AreNotEqual)$/.test(name)
        ? 2
        : /^(?:assertEquals|assertNotEquals)$/.test(name)
          ? 2
          : 1;
    for (const [begin, end] of args.slice(message)) blank(begin, end);
  }
  // Python's assert condition, message has no enclosing call.
  if (path.endsWith(".py")) {
    let offset = 0;
    for (const line of code.split("\n")) {
      if (/^\s*assert\b/.test(line)) {
        let depth = 0;
        for (let i = 0; i < line.length; i++) {
          if ("([{".includes(line[i] ?? "")) depth++;
          else if (")]}".includes(line[i] ?? "")) depth--;
          else if (line[i] === "," && !depth) {
            blank(offset + i, offset + line.length);
            break;
          }
        }
      }
      offset += line.length + 1;
    }
  }
  return out.join("");
}
