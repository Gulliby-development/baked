import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** 32 random bytes, base64url encoded (43 characters). */
export function generateApiToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Writes the token to a file only the current user can read. An existing file is replaced, never
 * reused, so a stale file left by a crashed server cannot keep an old mode or owner.
 */
export function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) unlinkSync(path);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  // The umask can only remove bits from 0600; chmod states the intent on platforms that honor it.
  chmodSync(path, 0o600);
}

export function removeTokenFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already removed: nothing to clean up.
  }
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** Compares a presented bearer token with the expected one in constant time. */
export function bearerMatches(header: string | null, token: string): boolean {
  const presented = /^Bearer ([^\s]+)$/.exec(header ?? "")?.[1] ?? "";
  // Hashing first gives equal-length inputs, so the comparison also hides the presented length.
  return token.length > 0 && timingSafeEqual(digest(presented), digest(token));
}

/** DNS-rebinding protection: only the loopback names of this exact port are accepted. */
export function hostAllowed(host: string | null, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Validates an `--allow-origin` value: a concrete scheme://host[:port] origin, never a wildcard. */
export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid origin ${JSON.stringify(value)}`);
  }
  if (url.origin === "null" || url.origin !== value.replace(/\/$/, ""))
    throw new Error(`Invalid origin ${JSON.stringify(value)}: use scheme://host[:port]`);
  return url.origin;
}
