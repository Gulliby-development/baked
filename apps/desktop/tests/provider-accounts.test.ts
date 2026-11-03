import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { setup } = await import("../src/renderer/client/setup.ts");
const { accountIdFrom, accountState, activeLabel, projectName } = await import(
  "../src/renderer/screens/setup/accounts-model.ts"
);
delete scope.window;

describe("provider accounts (#2303)", () => {
  test("the mock backend adds, chooses, signs in and removes an account", async () => {
    expect(await setup.canUseAccounts("baked")).toBe(true);
    const start = await setup.accounts("baked", "codex");
    expect(start).toMatchObject({ provider: "codex", active: null, accounts: [] });
    expect(activeLabel(start)).toBe("the CLI's own sign-in");

    const added = await setup.addAccount("baked", "codex", { id: "work", label: "Employer" });
    expect(added.accounts[0]).toMatchObject({ id: "work", allowed: false, active: false });

    const used = await setup.chooseAccount("baked", "codex", "work");
    expect(used.active).toBe("work");
    expect(used.accounts[0]).toMatchObject({ allowed: true, active: true });
    expect(activeLabel(used)).toBe("Employer");

    const started = await setup.startLogin("baked", "codex", "work");
    expect(started.login.state).toBe("running");
    let login = started.login;
    for (let i = 0; i < 5 && login.state === "running"; i++)
      login = (await setup.login("baked", "codex", "work")).login ?? login;
    expect(login.state).toBe("succeeded");
    const signed = await setup.accounts("baked", "codex");
    expect(signed.accounts[0] && accountState(signed.accounts[0]).text).toBe("signed in");
    // The CLI's own sign-in is untouched by the account's.
    const own = (await setup.providers("baked")).providers.find((p) => p.id === "codex");
    expect(own?.signIn?.loggedIn).toBe(false);

    const back = await setup.chooseAccount("baked", "codex", null);
    expect(back.active).toBeNull();
    expect((await setup.removeAccount("baked", "codex", "work")).accounts).toEqual([]);
  });

  test("IDs from labels and project names", () => {
    expect(accountIdFrom("Client seat (LSEC)")).toBe("client-seat-lsec");
    expect(accountIdFrom("  ")).toBe("");
    expect(projectName("/Users/me/code/client-portal")).toBe("client-portal");
    expect(projectName("C:\\code\\baked\\")).toBe("baked");
  });
});
