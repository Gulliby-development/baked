import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MISSING_PLAYWRIGHT, playwrightLauncher, resolvePlaywright } from "../src/core/workflows/v2/browser-driver.js";
import { FilterProxy, type FilterProxyOptions, refusalReason } from "../src/core/workflows/v2/filter-proxy.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A local fixture server that echoes the method, path and body it received. */
function fixtureServer() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => new Response(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`.trim()),
  });
  cleanups.push(() => server.stop(true));
  return server;
}

async function startProxy(options: Partial<FilterProxyOptions> & { fixturePort: number }) {
  const proxy = new FilterProxy({
    outboundHosts: options.outboundHosts ?? ["app.example.test"],
    loopbackPorts: options.loopbackPorts ?? [],
    // Fake names map to the fixture instead of real DNS; everything else stays as requested.
    resolve: (host, port) => (host.endsWith(".example.test") ? { host: "127.0.0.1", port: options.fixturePort } : { host, port }),
  });
  await proxy.start();
  cleanups.push(() => proxy.stop());
  return proxy;
}

/** Sends raw bytes to the proxy and collects the answer until the connection closes. */
function exchange(port: number, request: string, afterTunnel?: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    let tunnelled = false;
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (afterTunnel && !tunnelled && received.includes("\r\n\r\n")) {
        tunnelled = true;
        if (received.startsWith("HTTP/1.1 200")) socket.write(afterTunnel);
      }
    });
    const done = () => resolve(received);
    socket.on("close", done);
    socket.on("error", done);
    socket.write(request);
    setTimeout(() => socket.destroy(), 5000);
  });
}

describe("acceptance filtering proxy", () => {
  test("V2-17 a host outside outboundHosts is refused and logged; a listed host is reached", async () => {
    const fixture = fixtureServer();
    const proxy = await startProxy({ fixturePort: fixture.port });
    expect(proxy.port).toBeGreaterThan(0);

    const allowed = await exchange(proxy.port, "GET http://app.example.test/hello?x=1 HTTP/1.1\r\nHost: app.example.test\r\nProxy-Connection: keep-alive\r\n\r\n");
    expect(allowed).toStartWith("HTTP/1.1 200");
    expect(allowed).toContain("GET /hello");

    const refused = await exchange(proxy.port, "GET http://tracker.example.test/pixel HTTP/1.1\r\nHost: tracker.example.test\r\n\r\n");
    expect(refused).toStartWith("HTTP/1.1 403");
    expect(refused).toContain("tracker.example.test is not in outboundHosts");

    expect(proxy.decisions.map((d) => [d.method, d.host, d.port, d.allowed])).toEqual([
      ["GET", "app.example.test", 80, true],
      ["GET", "tracker.example.test", 80, false],
    ]);
    expect(proxy.refusals).toHaveLength(1);
    expect(proxy.refusals[0]?.reason).toBe("tracker.example.test is not in outboundHosts");
  });

  test("CONNECT tunnels are filtered by host and port the same way", async () => {
    const fixture = fixtureServer();
    const proxy = await startProxy({ fixturePort: fixture.port });
    const tunnel = await exchange(
      proxy.port,
      "CONNECT app.example.test:443 HTTP/1.1\r\nHost: app.example.test:443\r\n\r\n",
      "GET /through-tunnel HTTP/1.1\r\nHost: app.example.test\r\nConnection: close\r\n\r\n",
    );
    expect(tunnel).toStartWith("HTTP/1.1 200 Connection Established");
    expect(tunnel).toContain("GET /through-tunnel");

    const refused = await exchange(proxy.port, "CONNECT evil.example.test:443 HTTP/1.1\r\nHost: evil.example.test:443\r\n\r\n", "GET / HTTP/1.1\r\n\r\n");
    expect(refused).toStartWith("HTTP/1.1 403");
    expect(refused).not.toContain("GET /");
    expect(proxy.refusals.map((d) => `${d.method} ${d.host}:${d.port}`)).toEqual(["CONNECT evil.example.test:443"]);
  });

  test("loopback is reachable only on the granted ports, and request bodies are forwarded", async () => {
    const fixture = fixtureServer();
    const proxy = await startProxy({ fixturePort: fixture.port, outboundHosts: [], loopbackPorts: [fixture.port] });
    const body = "name=value";
    const posted = await exchange(
      proxy.port,
      `POST http://127.0.0.1:${fixture.port}/form HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    expect(posted).toStartWith("HTTP/1.1 200");
    expect(posted).toContain("POST /form name=value");
    expect(await exchange(proxy.port, `GET http://localhost:${fixture.port}/named HTTP/1.1\r\nHost: localhost\r\n\r\n`)).toContain("GET /named");

    const other = fixture.port === 65535 ? 65534 : fixture.port + 1;
    const refused = await exchange(proxy.port, `GET http://localhost:${other}/ HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    expect(refused).toStartWith("HTTP/1.1 403");
    expect(refused).toContain(`loopback port ${other} is not a granted listen port`);
    // Without an outbound grant every named host is refused; non-proxy requests are malformed.
    expect(await exchange(proxy.port, "GET http://app.example.test/ HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 403");
    expect(await exchange(proxy.port, "GET /relative HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 400");
    expect(await exchange(proxy.port, "GET ftp://app.example.test/ HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 400");
  });

  test("host rules: exact names, case and trailing dots normalized, no wildcards", () => {
    const grant = { outboundHosts: ["App.Example.test"], loopbackPorts: [3000] };
    expect(refusalReason("app.example.test.", 443, grant)).toBeNull();
    expect(refusalReason("api.app.example.test", 443, grant)).toBe("api.app.example.test is not in outboundHosts");
    expect(refusalReason("[::1]", 3000, grant)).toBeNull();
    expect(refusalReason("127.0.0.2", 3000, grant)).toBeNull();
    expect(refusalReason("127.0.0.1", 3001, grant)).toBe("loopback port 3001 is not a granted listen port");
    expect(refusalReason("10.0.0.1", 80, grant)).toBe("10.0.0.1 is not in outboundHosts");
  });
});

// The real-browser test runs only where Playwright and a Chromium build are installed; CI has neither.
const repo = join(import.meta.dir, "..");
const realBrowser = resolvePlaywright(repo) !== null && (await playwrightLauncher.missing(repo)) === null;

describe("acceptance browser driver", () => {
  test("a workspace without Playwright reports the missing dependency instead of downloading it", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "baked-browser-missing-"));
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
    expect(resolvePlaywright(workspace, false)).toBeNull();
    // BAKED itself does not depend on Playwright; where a developer installed it, the check passes.
    if (resolvePlaywright(workspace) === null) expect(await playwrightLauncher.missing(workspace)).toBe(MISSING_PLAYWRIGHT);
  });

  test.skipIf(!realBrowser)("a real browser reaches only granted hosts through the proxy", async () => {
    const fixture = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("<html><head><title>Fixture</title></head><body><h1>Hello</h1><img src=\"http://tracker.example.test/p.gif\"></body></html>", { headers: { "content-type": "text/html" } }),
    });
    cleanups.push(() => fixture.stop(true));
    const proxy = await startProxy({ fixturePort: fixture.port });
    const page = await playwrightLauncher.launch(repo, { proxyServer: proxy.url });
    cleanups.push(() => page.close());
    expect((await page.goto("http://app.example.test/", 20000)).status).toBe(200);
    expect(await page.title()).toBe("Fixture");
    expect(await page.snapshot()).toContain("Hello");
    expect(proxy.refusals.map((d) => d.host)).toContain("tracker.example.test");
    expect((await page.goto("http://evil.example.test/", 20000)).status).toBe(403);
  }, 60000);
});
