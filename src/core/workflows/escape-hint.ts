/**
 * The escape hint of a failed check (#1516). A model that writes a regex or string literal with
 * doubled backslashes (`/\\[(\\d+)\\]/` where the file needs `/\[(\d+)\]/`) gets a syntax error
 * and often loops on reads without seeing why: the edit tools write their text exactly as sent.
 * The hint names that once; it rewrites nothing.
 */

export const ESCAPE_HINT =
  "the text you pass to edit_file and multi_edit is written exactly as sent; one backslash in the file is one backslash in new_string";

/** Two backslashes before an escape character of a regex or string literal: `\\d`, `\\[`, `\\n`. */
const DOUBLED_ESCAPE = /\\\\[[\]()dDsSwWbB.*+?{}|^$/nrt'"`-]/g;

/** A syntax error as compilers and interpreters report it, in TypeScript, JavaScript, Python and others. */
const SYNTAX_ERROR =
  /\bTS1\d{3}\b|SyntaxError|syntax error|[Uu]nterminated|Invalid regular expression|Unexpected token|unexpected character|invalid escape/;

function count(text: string): number {
  return text.match(DOUBLED_ESCAPE)?.length ?? 0;
}

/**
 * Whether an edit tool call adds doubled backslash escapes its replaced text did not have: the new
 * text of an `edit_file` or of a `multi_edit` entry, or the content of a whole-file write.
 */
export function addsDoubledEscapes(args: Record<string, unknown>): boolean {
  const pairs: [unknown, unknown][] = [[args.oldString, args.newString]];
  if (typeof args.content === "string") pairs.push(["", args.content]);
  if (Array.isArray(args.edits))
    for (const edit of args.edits)
      if (edit && typeof edit === "object")
        pairs.push([
          (edit as Record<string, unknown>).oldString,
          (edit as Record<string, unknown>).newString,
        ]);
  return pairs.some(
    ([before, after]) =>
      typeof after === "string" && count(after) > (typeof before === "string" ? count(before) : 0),
  );
}

/** The hint for a failed check's output, when it is a syntax error after edits that added doubled escapes. */
export function escapeHintFor(output: string, addedDoubledEscapes: boolean): string | null {
  return addedDoubledEscapes && SYNTAX_ERROR.test(output) ? ESCAPE_HINT : null;
}
