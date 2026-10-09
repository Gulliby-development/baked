import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "baked-lsp-scan-"));
const config = join(root, process.platform === "win32" ? "baked" : ".baked");
mkdirSync(config);
const packages = Array.from({ length: 600 }, (_, i) => ({
  name: `test-server-${i}`, description: "Test server", homepage: "", licenses: [],
  languages: ["TypeScript"], categories: ["LSP"],
  source: { id: `pkg:npm/test-server-${i}@1.0.0` },
  bin: { [`missing-baked-test-${i}`]: "server.js" },
}));
packages[0]!.bin = { node: "server.js" };
packages[1]!.bin = { "baked-test-shim": "server.js" };
const shim = join(root, process.platform === "win32" ? "baked-test-shim.cmd" : "baked-test-shim");
writeFileSync(shim, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
if (process.platform !== "win32") chmodSync(shim, 0o755);
writeFileSync(join(config, "mason-registry.json"), JSON.stringify(packages));
writeFileSync(join(root, "tsconfig.json"), "{}");
const installer = resolve("src/core/intelligence/backends/lsp/installer.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(code: string) {
  const child = Bun.spawn([process.execPath, "--eval", `
    const api = await import(${JSON.stringify(installer)});
    ${code}
  `], {
    env: { ...process.env, LOCALAPPDATA: root, HOME: root, PATH: root + delimiter + process.env.PATH },
    stdout: "pipe", stderr: "pipe",
  });
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(error).toBe("");
  expect(exit).toBe(0);
  return JSON.parse(output);
}

test("registry scanning yields to input and keeps package results", async () => {
  const result = await run(`
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const statuses = await api.getAllPackageStatusAsync();
    clearInterval(timer);
    console.log(JSON.stringify({ ticks, count: statuses.length, node: statuses[0].source,
      shim: statuses[1].source, missing: statuses[2].installed,
      recommended: api.getRecommendedPackages(${JSON.stringify(root)}, statuses).length }));
  `);
  expect(result.count).toBe(600);
  expect(result.ticks).toBeGreaterThan(1);
  expect(result.node).toBe("PATH");
  expect(result.shim).toBe("PATH");
  expect(result.missing).toBe(false);
  expect(result.recommended).toBe(600);
}, 60_000);

test("closing the popup cancels an in-progress registry scan", async () => {
  const result = await run(`
    const controller = new AbortController();
    const pending = api.getAllPackageStatusAsync(controller.signal);
    setTimeout(() => controller.abort(), 0);
    try { await pending; console.log(JSON.stringify({ aborted: false })); }
    catch (error) { console.log(JSON.stringify({ aborted: error.name === "AbortError" })); }
  `);
  expect(result.aborted).toBe(true);
}, 10_000);

test("an aborted registry download exits without waiting for the network", async () => {
  const result = await run(`
    const controller = new AbortController();
    controller.abort();
    try { await api.downloadRegistry(controller.signal); console.log(JSON.stringify({ aborted: false })); }
    catch { console.log(JSON.stringify({ aborted: true })); }
  `);
  expect(result.aborted).toBe(true);
});

test("LSP popup renders and Escape closes it during loading", async () => {
  const popup = resolve("src/components/settings/LspInstallSearch.tsx");
  const result = await run(`
    const { testRender } = await import("@opentui/react/test-utils");
    const { act, createElement, useState } = await import("react");
    const { LspInstallSearch } = await import(${JSON.stringify(popup)});
    let closed = false;
    const messages = [];
    const onSystemMessage = message => messages.push(message);
    function Harness() {
      const [visible, setVisible] = useState(true);
      return createElement(LspInstallSearch, {
        visible, cwd: ${JSON.stringify(root)}, disabledServers: [],
        onClose: () => { closed = true; setVisible(false); },
        onSystemMessage, saveToScope: () => {}, detectScope: () => "global",
      });
    }
    const view = await testRender(createElement(Harness), { width: 100, height: 30 });
    try {
      await act(async () => { await view.flush(); await view.renderOnce(); });
      const opened = view.captureCharFrame().includes("LSP Servers");
      await act(async () => { await view.mockInput.pressEscape(); });
      for (let i = 0; i < 3; i++) {
        await act(async () => { await view.flush(); await view.renderOnce(); });
      }
      console.log(JSON.stringify({ opened, closed, hidden: !view.captureCharFrame().includes("LSP Servers"), messages }));
    } finally { await act(async () => view.renderer.destroy()); }
  `);
  expect(result.opened).toBe(true);
  expect(result.closed).toBe(true);
  expect(result.hidden).toBe(true);
  expect(result.messages).toEqual([]);
}, 15_000);
