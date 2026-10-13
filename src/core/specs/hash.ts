import { createHash } from "node:crypto";

/**
 * Canonical JSON: sorted keys, no whitespace. An object key whose value is `undefined` is left
 * out, as `JSON.stringify` does (#929); any other non-JSON value throws with its key path.
 */
export function canonical(value: unknown): string {
  return canonicalAt(value, "$");
}
function canonicalAt(value: unknown, path: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item, index) => canonicalAt(item, `${path}[${index}]`)).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalAt(record[key], `${path}.${key}`)}`)
      .join(",")}}`;
  }
  throw new Error(`Cannot hash a non-JSON value at ${path}: ${describe(value)}`);
}
function describe(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "object") return value?.constructor?.name ?? "object";
  return typeof value;
}
export function hashBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function hashJson(value: unknown): string {
  return hashBytes(canonical(value));
}
