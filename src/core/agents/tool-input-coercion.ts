/**
 * Tool inputs whose array, object, number or boolean fields arrived as JSON text (#2141).
 *
 * Some models serialise a long array or an object argument as a string: `"evidenceIds": "[\"e1\"]"`
 * where the tool's schema asks for an array. The strict validator refuses the call and the model
 * pays a whole round to send the same value again. A string field whose schema does not accept a
 * string, and whose text parses as JSON of a type the schema does accept, is decoded here, before
 * the validator runs again. A string that does not parse, or parses to another type, is left as
 * it is, so the validator still refuses it with the same error.
 *
 * It runs at the tool-input layer every provider shares (the AI SDK's `repairToolCall`), never in
 * one adapter: whichever adapter or model sends a stringified field, the same decoding applies.
 */
import type { JSONSchema7, JSONSchema7Definition, LanguageModelV4ToolCall } from "@ai-sdk/provider";

type JsonType = "array" | "object" | "number" | "integer" | "boolean";

/**
 * Every schema type a stringified value is decoded to, with the check its decoded value must
 * pass. AGENTS.md: a tool schema field of a type outside this table and other than string or null
 * fails tests/tool-input-coercion.test.ts until the type gets an entry here.
 */
export const COERCIBLE_TYPES: Readonly<Record<JsonType, (value: unknown) => boolean>> = {
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => typeof value === "number" && Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
};

/** Schema types a field can have that are never decoded to: a string stays a string. */
export const KEPT_TYPES: ReadonlySet<string> = new Set(["string", "null"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asSchema = (definition: JSONSchema7Definition | undefined): JSONSchema7 | undefined =>
  typeof definition === "object" ? definition : undefined;

/** The member schemas of a schema's `anyOf`/`oneOf`/`allOf`, and the schema itself. */
function variants(schema: JSONSchema7): JSONSchema7[] {
  const members = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]
    .map(asSchema)
    .filter((member): member is JSONSchema7 => member !== undefined);
  return [schema, ...members.flatMap(variants)];
}

/**
 * The JSON types a schema accepts, from `type` and its union members; `null` when it also accepts
 * a string (a string is then a valid value, never decoded) or names no type at all.
 */
export function acceptedTypes(schema: JSONSchema7): Set<string> | null {
  const types = new Set<string>();
  for (const variant of variants(schema)) {
    const type = variant.type;
    for (const name of Array.isArray(type) ? type : type ? [type] : []) types.add(name);
    if (variant.const !== undefined) types.add(jsonTypeOf(variant.const));
    for (const value of variant.enum ?? []) types.add(jsonTypeOf(value));
  }
  if (types.size === 0 || types.has("string")) return null;
  return types;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** `text` decoded when it is JSON of one of `types`, otherwise undefined. */
function decode(text: string, types: Set<string>): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const type of types)
    if (type in COERCIBLE_TYPES && COERCIBLE_TYPES[type as JsonType](value)) return value;
  return undefined;
}

/** The schema of an object's property `key`, from the schema or any of its union members. */
function propertySchema(schema: JSONSchema7, key: string): JSONSchema7 | undefined {
  for (const variant of variants(schema)) {
    const found = asSchema(variant.properties?.[key]);
    if (found) return found;
  }
  return undefined;
}

/** The schema of an array's items, from the schema or any of its union members. */
function itemSchema(schema: JSONSchema7): JSONSchema7 | undefined {
  for (const variant of variants(schema)) {
    const items = variant.items;
    if (items && !Array.isArray(items)) return asSchema(items);
  }
  return undefined;
}

/**
 * `value` with every stringified field the schema types otherwise decoded, nested ones included;
 * each decoded field's path is pushed to `coerced` (`tasks[0].requirementIds`).
 */
function coerceValue(
  value: unknown,
  schema: JSONSchema7,
  path: string,
  coerced: string[],
): unknown {
  if (typeof value === "string") {
    const types = acceptedTypes(schema);
    if (!types) return value;
    const decoded = decode(value, types);
    if (decoded === undefined) return value;
    coerced.push(path);
    // A decoded container can hold stringified fields of its own.
    return coerceValue(decoded, schema, path, coerced);
  }
  if (Array.isArray(value)) {
    const items = itemSchema(schema);
    if (!items) return value;
    return value.map((item, index) => coerceValue(item, items, `${path}[${index}]`, coerced));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const fieldSchema = propertySchema(schema, key);
      out[key] = fieldSchema
        ? coerceValue(field, fieldSchema, path ? `${path}.${key}` : key, coerced)
        : field;
    }
    return out;
  }
  return value;
}

/** A tool input with its stringified fields decoded, and the paths of the decoded fields. */
export function coerceStringifiedFields(
  input: Record<string, unknown>,
  schema: JSONSchema7,
): { input: Record<string, unknown>; coerced: string[] } {
  const coerced: string[] = [];
  const out = coerceValue(input, schema, "", coerced) as Record<string, unknown>;
  return { input: out, coerced };
}

/** What was decoded in one tool call. */
export interface ToolInputCoercion {
  toolName: string;
  toolCallId: string;
  fields: string[];
}

/**
 * A `repairToolCall` step: a call the validator refused with stringified fields of the schema's
 * other types comes back with them decoded, and `onCoerced` is told which; any other call gives
 * null, so the validator's error stands (or the next repair runs).
 */
export async function coerceStringifiedToolCall(
  {
    toolCall,
    inputSchema,
    error,
  }: {
    toolCall: LanguageModelV4ToolCall;
    inputSchema: (options: { toolName: string }) => PromiseLike<JSONSchema7>;
    error?: unknown;
  },
  onCoerced?: (coercion: ToolInputCoercion) => void,
): Promise<LanguageModelV4ToolCall | null> {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? (error as { name?: unknown }).name
      : undefined;
  if (name !== "AI_InvalidToolInputError") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.input);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  let schema: JSONSchema7;
  try {
    schema = await inputSchema({ toolName: toolCall.toolName });
  } catch {
    return null;
  }
  const { input, coerced } = coerceStringifiedFields(parsed, schema);
  if (!coerced.length) return null;
  onCoerced?.({ toolName: toolCall.toolName, toolCallId: toolCall.toolCallId, fields: coerced });
  return { ...toolCall, input: JSON.stringify(input) };
}
