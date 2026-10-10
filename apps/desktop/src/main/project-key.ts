import { createHash } from "node:crypto";

/** A short, stable key for a project folder, safe to use in routes and file names. */
export function projectKey(path: string): string {
  const normalized = process.platform === "win32" ? path.toLowerCase() : path;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}
