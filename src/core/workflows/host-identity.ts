/**
 * The signed-in account of a CLI-backed provider (Claude Code, Codex) can reach the model through
 * the CLI's own context, and a model asked for a license holder has written it into deliverables.
 * These helpers read that identity from the providers' local files so writes and submitted
 * artifacts that carry it can be refused.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Instruction for agents that may write a license, copyright line or author field. */
export const OWNER_IDENTITY_RULE =
  "Take a license holder, copyright owner or author from the project manifest (for example package.json author) or the request; when neither names one, write '<project name> contributors'. Never use a name or e-mail address from your environment or account.";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Shorter local parts (`dev`, `john`) are ordinary words in code and docs. */
const MIN_LOCAL_PART = 5;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function jwtEmail(token: unknown): string | undefined {
  if (typeof token !== "string") return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    const email = field(claims, "email");
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Account e-mail addresses of the Claude Code and Codex logins under `home`, each with its local
 * part when that is long enough to be distinctive. Lower-cased; empty when no login is found.
 */
export function providerAccountIdentities(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  const claude = readJson(claudeDir ? join(claudeDir, ".claude.json") : join(home, ".claude.json"));
  const codex = readJson(join(env.CODEX_HOME ?? join(home, ".codex"), "auth.json"));
  const emails = [
    field(claude, "oauthAccount", "emailAddress"),
    jwtEmail(field(codex, "tokens", "id_token")),
  ].filter((e): e is string => typeof e === "string" && EMAIL.test(e.trim()));
  const identities = new Set<string>();
  for (const email of emails) {
    const normalized = email.trim().toLowerCase();
    identities.add(normalized);
    const local = normalized.split("@")[0] ?? "";
    if (local.length >= MIN_LOCAL_PART) identities.add(local);
  }
  return [...identities];
}

/** Root files that name a project's owner; an identity they already carry is the project's own. */
const OWNER_FILES = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "composer.json",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "AUTHORS",
];

/**
 * The provider account identities that `root` does not already name in its manifest or license,
 * so a project whose owner is the signed-in user can keep copying its own author field.
 */
export function foreignAccountIdentities(
  root: string,
  identities: string[] = hostAccountIdentities(),
): string[] {
  if (!identities.length) return identities;
  const owners = OWNER_FILES.map((file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return "";
    }
  }).join("\n");
  return identities.filter((identity) => !findAccountIdentity(owners, [identity]));
}

let cached: string[] | undefined;
/** {@link providerAccountIdentities} of the current user, read once per process. */
export function hostAccountIdentities(): string[] {
  cached ??= providerAccountIdentities();
  return cached;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The first identity that appears in `text` as a whole word (case-insensitive), if any. */
export function findAccountIdentity(text: string, identities: string[]): string | null {
  const lower = text.toLowerCase();
  for (const identity of identities) {
    if (!lower.includes(identity)) continue;
    if (new RegExp(`(?<![\\w.@-])${escapeRegExp(identity)}(?![\\w@-])`, "i").test(text))
      return identity;
  }
  return null;
}

/** The refusal text for content that carries the provider account identity. */
export function accountIdentityMessage(where: string): string {
  return `${where} contains the e-mail address or user name of the provider account BAKED runs under. ${OWNER_IDENTITY_RULE}`;
}
