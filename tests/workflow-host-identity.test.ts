import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountIdentityMessage,
  findAccountIdentity,
  foreignAccountIdentities,
  providerAccountIdentities,
} from "../src/core/workflows/host-identity";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "host-identity-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

describe("provider account identity", () => {
  test("reads the Claude Code and Codex account e-mails with distinctive local parts", () => {
    const home = temp();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "Jane.Roe42@example.com" } }),
    );
    mkdirSync(join(home, ".codex"));
    writeFileSync(
      join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { id_token: jwt({ email: "dev@example.org" }) } }),
    );
    expect(providerAccountIdentities(home, {}).sort()).toEqual([
      "dev@example.org",
      "jane.roe42",
      "jane.roe42@example.com",
    ]);
  });

  test("no login means no identities", () => {
    expect(providerAccountIdentities(temp(), {})).toEqual([]);
  });

  test("finds an identity only as a whole word", () => {
    const ids = ["jane.roe42@example.com", "jane.roe42"];
    expect(findAccountIdentity("Copyright (c) 2026 Jane.Roe42", ids)).toBe("jane.roe42");
    expect(findAccountIdentity("contact: jane.roe42@example.com", ids)).toBe(
      "jane.roe42@example.com",
    );
    expect(findAccountIdentity("Copyright (c) 2026 envguard contributors", ids)).toBeNull();
    expect(findAccountIdentity("const xjane.roe42y = 1", ids)).toBeNull();
  });

  test("an identity the project already names as its owner is allowed", () => {
    const root = temp();
    writeFileSync(join(root, "package.json"), JSON.stringify({ author: "jane.roe42" }));
    expect(foreignAccountIdentities(root, ["jane.roe42@example.com", "jane.roe42"])).toEqual([
      "jane.roe42@example.com",
    ]);
    expect(foreignAccountIdentities(temp(), ["jane.roe42"])).toEqual(["jane.roe42"]);
  });

  test("the refusal tells the agent where to take the owner from", () => {
    expect(accountIdentityMessage("The edit to LICENSE")).toContain("package.json author");
  });
});
