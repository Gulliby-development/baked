import { createHash } from "node:crypto";

export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Cannot hash a non-JSON value");
}
export function hashBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function hashJson(value: unknown): string {
  return hashBytes(canonical(value));
}
