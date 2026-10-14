import { z } from "zod";

/**
 * Revision by patch (#1058). When analysis sends a few findings back to the spec or the plan, the
 * author answers with edit operations on the current artifact instead of writing it again: in
 * statevet a93faa86 four full re-authors of a 30 KB spec and a 24 KB plan cost $5.31 to change one
 * `dependsOn` field, and each one could change anything else (the spec gained FR-014 and AC-019).
 * The host applies the operations and validates the result as it would a submission; a patch that
 * does not apply or does not validate falls back to the full re-author.
 */

/** Blocking findings a patch answers; more go to the full re-author. */
export const MAX_PATCH_FINDINGS = 5;

const Path = z.string().min(1).max(512);
const RevisionOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: Path, value: z.unknown() }).strict(),
  z.object({ op: z.literal("add"), path: Path, value: z.unknown() }).strict(),
  z.object({ op: z.literal("remove"), path: Path }).strict(),
  z
    .object({
      op: z.literal("replaceText"),
      path: Path,
      find: z.string().min(1).max(20_000),
      replace: z.string().max(20_000),
    })
    .strict(),
]);
export type RevisionOperation = z.infer<typeof RevisionOperationSchema>;

export const RevisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    operations: z.array(RevisionOperationSchema).min(1).max(40),
  })
  .strict();
export type Revision = z.infer<typeof RevisionSchema>;

export type RevisionTarget = "spec" | "plan";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The element of `list` a path segment names: an index, or the element whose `id` it is. */
function elementIndex(list: unknown[], segment: string): number {
  const byId = list.findIndex((item) => isRecord(item) && item.id === segment);
  if (byId >= 0) return byId;
  return /^\d+$/.test(segment) && Number(segment) < list.length ? Number(segment) : -1;
}

/** Applies one operation to `root` in place; the reason when it does not apply. */
function applyOperation(root: unknown, operation: RevisionOperation): string | null {
  const segments = operation.path.split("/").filter(Boolean);
  if (!segments.length) return "the path names no field";
  let parent: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const at = elementIndex(parent, segment);
      if (at < 0) return `no element ${segment}`;
      parent = parent[at];
    } else if (isRecord(parent) && segment in parent) parent = parent[segment];
    else return `no field ${segment}`;
  }
  const last = segments.at(-1) ?? "";
  const at = Array.isArray(parent) ? elementIndex(parent, last) : -1;
  const target = Array.isArray(parent) ? parent[at] : isRecord(parent) ? parent[last] : undefined;
  const put = (next: unknown) => {
    if (Array.isArray(parent)) parent[at] = next;
    else if (isRecord(parent)) parent[last] = next;
  };
  switch (operation.op) {
    case "set":
      if (Array.isArray(parent) && at < 0) return `no element ${last}; use add to append one`;
      if (!Array.isArray(parent) && !isRecord(parent))
        return "the parent is not an object or a list";
      put(operation.value);
      return null;
    case "add":
      if (!Array.isArray(target)) return "add appends to a list; the path names none";
      target.push(operation.value);
      return null;
    case "remove":
      if (Array.isArray(parent) && at >= 0) parent.splice(at, 1);
      else if (isRecord(parent) && last in parent) delete parent[last];
      else return `no element or field ${last}`;
      return null;
    case "replaceText": {
      if (typeof target !== "string") return "replaceText needs a text field";
      const count = target.split(operation.find).length - 1;
      if (count !== 1)
        return `the text to find occurs ${String(count)} times; it must occur exactly once`;
      put(target.replace(operation.find, () => operation.replace));
      return null;
    }
  }
}

/** Applies `operations` to a copy of `document`; the errors name each operation that failed. */
export function applyRevision(
  document: unknown,
  operations: readonly RevisionOperation[],
): { value: unknown; errors: string[] } {
  const value = structuredClone(document);
  const errors: string[] = [];
  for (const [index, operation] of operations.entries()) {
    const reason = applyOperation(value, operation);
    if (reason)
      errors.push(`Operation ${String(index + 1)} (${operation.op} ${operation.path}): ${reason}`);
  }
  return { value, errors };
}

/** What the author reads instead of its usual instruction to write the whole artifact. */
export function revisionNote(target: RevisionTarget): string {
  const paths =
    target === "spec"
      ? 'Paths start at the spec: "criteria/AC-016/given", "requirements/FR-003/text", "outOfScope".'
      : 'Paths start at the plan result: "taskGraph/tasks/T012/dependsOn", "taskGraph/tasks/T004/writes", "markdown" (use replaceText on it). The graph in the context also shows the edges and split tasks the host adds after planning; operations edit your own tasks, before the host adds them.';
  return [
    `This is a revision of the current ${target}, not a new one. Do not submit the whole ${target}.`,
    "Submit only edit operations that fix every listed finding and change nothing else:",
    '{"schemaVersion": 1, "operations": [...]}, each operation one of',
    '{"op": "set", "path", "value"} (replace a field or an element),',
    '{"op": "add", "path", "value"} (append to the list the path names),',
    '{"op": "remove", "path"} (delete a field or an element),',
    '{"op": "replaceText", "path", "find", "replace"} (replace text that occurs exactly once in a text field).',
    `${paths} A segment after a list is the id of an element (or its index).`,
    `The host applies the operations and checks the result like a full ${target}; when they do not apply, the errors come back to you.`,
  ].join(" ");
}
