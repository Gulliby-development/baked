import type { ProviderAccount, ProviderAccounts } from "../../client/setup.js";

/** Account IDs the backend takes: lowercase letters, digits and hyphens, up to 40. */
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** An account ID from a label: "Client seat" → "client-seat". */
export function accountIdFrom(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** What an account's row says of its sign-in. */
export function accountState(a: ProviderAccount): { tone: "ok" | "warn" | ""; text: string } {
  if (a.login?.state === "running") return { tone: "warn", text: "signing in" };
  if (!a.signIn.installed) return { tone: "", text: "CLI not installed" };
  return a.signIn.loggedIn ? { tone: "ok", text: "signed in" } : { tone: "", text: "signed out" };
}

/** What the project uses, in words: the chosen account's label or the CLI's own sign-in. */
export function activeLabel(view: ProviderAccounts): string {
  const active = view.accounts.find((a) => a.id === view.active);
  return active ? active.label : "the CLI's own sign-in";
}

/** The last folder name of a project path, for a compact chip. */
export function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
