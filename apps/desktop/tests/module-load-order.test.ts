import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// The desktop tests share one module registry, so the file that runs first decides which client
// module loads first. A module that only worked when loaded in one order failed every later test
// that imported it, as soon as the run picked another order.
const client = join(import.meta.dir, "..", "src", "renderer", "client");

/** Runs `script` in a fresh Bun with no `window`, and returns what it printed. */
async function fresh(script: string): Promise<string> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: client,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(err || `exit ${String(code)}`);
  return out.trim();
}

describe("client module load order", () => {
  test("every mock route module can load before the route list", async () => {
    const modules = readdirSync(client).filter(
      (name) => name.startsWith("mock-") && name.endsWith(".ts") && name !== "mock-routes.ts",
    );
    expect(modules.length).toBeGreaterThan(10);
    const missing = await Promise.all(
      modules.map((name) =>
        fresh(
          `await import("./${name}");
           const { MOCK_ROUTES, MOCK_STREAMS } = await import("./mock-routes.ts");
           console.log([...MOCK_ROUTES, ...MOCK_STREAMS].filter((r) => typeof r !== "function").length);`,
        ).then((out) => [name, out]),
      ),
    );
    expect(missing.filter(([, out]) => out !== "0")).toEqual([]);
  });

  test("the bridge loads without a window and falls back to the mock", async () => {
    expect(await fresh(`const { isMock } = await import("./bridge.ts"); console.log(isMock);`)).toBe(
      "true",
    );
  });
});
