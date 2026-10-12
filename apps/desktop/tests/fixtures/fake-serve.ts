/**
 * Stands in for `baked` in tests: `serve` takes the same arguments and writes the same ready line
 * and token file, with the same bearer check. A folder whose name contains "crash", or that holds
 * a `.fake-serve-crash` file, fails at start; "slow" never reports ready.
 *
 * With FAKE_BAKED_PROJECTS set to a JSON file of known projects, `projects list --json` and
 * `projects add FOLDER` read and write that file, so the desktop app can run against this fake.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const value = (flag: string): string => args[args.indexOf(flag) + 1] ?? "";

interface FakeProject {
  path: string;
  name: string;
}

const projectsFile = process.env.FAKE_BAKED_PROJECTS;
function knownProjects(): FakeProject[] {
  if (!projectsFile || !existsSync(projectsFile)) return [];
  return JSON.parse(readFileSync(projectsFile, "utf8")) as FakeProject[];
}

if (args[0] === "projects" && projectsFile) {
  const projects = knownProjects();
  if (args[1] === "list") {
    const now = Date.now();
    const listed = projects.map((p) => ({
      path: p.path,
      name: p.name,
      projectId: null,
      pinned: false,
      addedAt: now - 86_400_000,
      lastOpenedAt: now - 3_600_000,
      exists: existsSync(p.path),
      overview: { sessions: 0, lastSessionAt: null, activeRuns: 0, attention: 0 },
    }));
    process.stdout.write(`${JSON.stringify({ projects: listed })}\n`);
    process.exit(0);
  }
  if (args[1] === "add" && args[2]) {
    const path = resolve(args[2]);
    if (!projects.some((p) => p.path === path)) projects.push({ path, name: basename(path) });
    writeFileSync(projectsFile, JSON.stringify(projects));
    process.exit(0);
  }
  process.exit(2);
}

const folder = value("--cwd");
const tokenFile = value("--token-file");
if (args[0] !== "serve") process.exit(2);
const name = basename(folder);
if (name.includes("crash") || existsSync(join(folder, ".fake-serve-crash"))) {
  process.stderr.write("fake serve: database is locked\n");
  process.exit(1);
}

/** One waiting run per project, so Needs you can merge two projects' lists. */
const attentionItem = (featureId: string, minutesAgo: number) => ({
  source: "run",
  runId: `run-${featureId}`,
  featureId,
  sessionId: null,
  title: null,
  status: "waiting",
  requestId: `req-${featureId}`,
  kind: "approval",
  blocking: true,
  createdAt: Date.now() - minutesAgo * 60_000,
});

/**
 * `/v1/attention`: the first connection gets the project's first item and ends, as a dropped
 * stream does; only a reconnect that sends `Last-Event-ID: 1` gets the second item.
 */
function attention(req: Request): Response {
  const encoder = new TextEncoder();
  const first = attentionItem(`${name}-first`, 10);
  const event = (id: number, items: unknown[]) =>
    encoder.encode(`id: ${id}\nevent: attention\ndata: ${JSON.stringify({ items })}\n\n`);
  const resumed = req.headers.get("last-event-id") === "1";
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!resumed) {
        controller.enqueue(event(1, [first]));
        controller.close();
        return;
      }
      controller.enqueue(event(2, [first, attentionItem(`${name}-second`, 2)]));
      // Stays open with heartbeats until the client goes away.
      const timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(timer);
        }
      }, 5_000);
      req.signal.addEventListener("abort", () => clearInterval(timer));
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

if (name.includes("slow")) setInterval(() => {}, 1000);
else {
  const token = `t-${process.pid}`;
  writeFileSync(tokenFile, `${token}\n`);
  let seq = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`)
        return Response.json({ error: { code: "UNAUTHORIZED", message: "no" } }, { status: 401 });
      const url = new URL(req.url);
      if (url.pathname === "/v1/health")
        return Response.json({ apiVersion: 1, version: "9.9.9", workspace: folder });
      if (url.pathname === "/v1/attention") return attention(req);
      if (url.pathname === "/v1/download")
        return new Response(`# ${url.searchParams.get("title") ?? "Chat"}\n`, {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": 'attachment; filename="chat-1.md"',
          },
        });
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
      // What an older `baked serve` answers for a route it does not have.
      return Response.json(
        { error: { code: "NOT_FOUND", message: `No endpoint ${req.method} ${url.pathname}` } },
        { status: 404 },
      );
    },
  });
  process.stdout.write(
    `${JSON.stringify({ url: `http://127.0.0.1:${server.port}`, port: server.port, tokenFile })}\n`,
  );
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
}
