/**
 * Stands in for `baked serve` in tests: same arguments, same ready line, token file and bearer
 * check. A folder whose name contains "crash" fails at start; "slow" never reports ready.
 */
import { writeFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const value = (flag: string): string => args[args.indexOf(flag) + 1] ?? "";
const folder = value("--cwd");
const tokenFile = value("--token-file");
if (args[0] !== "serve") process.exit(2);
if (basename(folder).includes("crash")) {
  process.stderr.write("fake serve: database is locked\n");
  process.exit(1);
}
if (basename(folder).includes("slow")) setInterval(() => {}, 1000);
else {
  const token = `t-${process.pid}`;
  writeFileSync(tokenFile, `${token}\n`);
  let seq = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`)
        return Response.json({ error: { code: "UNAUTHORIZED", message: "no" } }, { status: 401 });
      const url = new URL(req.url);
      if (url.pathname === "/v1/health")
        return Response.json({ apiVersion: 1, version: "9.9.9", workspace: folder });
      if (url.pathname === "/v1/echo" && req.method === "POST")
        return req.json().then((body) => Response.json({ body }));
      if (url.pathname === "/v1/events") {
        const after = Number(req.headers.get("last-event-id") ?? 0);
        // Two events per connection, then the server ends the stream to force a reconnect.
        const body = `id: ${after + 1}\ndata: ${after + 1}\n\nid: ${after + 2}\ndata: ${after + 2}\n\n`;
        seq += 2;
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname === "/v1/exit") {
        setTimeout(() => process.exit(3), 10);
        return Response.json({ seq });
      }
      return Response.json({ error: { code: "NOT_FOUND", message: url.pathname } }, { status: 404 });
    },
  });
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.port}`, port: server.port, tokenFile })}\n`);
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
}
