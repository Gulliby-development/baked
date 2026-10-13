import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployArtifact, planDeploy } from "../src/core/artifacts/deploy.js";
import { findSecrets } from "../src/core/artifacts/scan.js";
import { ArtifactStore, titleOf } from "../src/core/artifacts/store.js";
import { deployToVercel, VercelError } from "../src/core/artifacts/vercel.js";
import { startApiServer } from "../src/core/api/server.js";
import { deployRequest } from "../src/core/commands/artifacts.js";
import { createArtifactTool } from "../src/core/tools/artifact.js";
import { runArtifactsCli } from "../src/headless/artifacts.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function store(): ArtifactStore {
  const root = mkdtempSync(join(tmpdir(), "baked-artifacts-"));
  dirs.push(root);
  return new ArtifactStore(join(root, "artifacts"));
}

const page = (title: string, body = "<p>Hello</p>") =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

/** A fake Vercel API: records the deployment it is sent and reports it ready on the first poll. */
function fakeVercel(options: { status?: number } = {}) {
  const seen: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json() : null;
      seen.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), body });
      if (options.status) return Response.json({ error: { message: "nope" } }, { status: options.status });
      if (req.method === "POST") return Response.json({ id: "dpl_1", readyState: "BUILDING", url: "baked-x-abc.vercel.app" });
      return Response.json({ id: "dpl_1", readyState: "READY", url: "baked-x-abc.vercel.app", alias: ["baked-x.vercel.app"] });
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen };
}

describe("artifact store", () => {
  test("saves versions under an ID from the title and lists the newest first", () => {
    const s = store();
    const first = s.save({ html: page("Sales Chart") });
    expect(first.id).toBe("sales-chart");
    expect(first.title).toBe("Sales Chart");
    expect(first.version).toBe(1);
    const second = s.save({ id: first.id, html: page("Sales Chart", "<p>v2</p>") });
    expect(second.version).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(s.read(first.id)).toContain("v2");
    expect(s.read(first.id, 1)).toContain("Hello");
    const other = s.save({ html: page("Sales Chart") });
    expect(other.id).toBe("sales-chart-2");
    expect(s.list().map((a) => a.id)).toEqual(["sales-chart-2", "sales-chart"]);
    s.remove("sales-chart-2");
    expect(s.list().map((a) => a.id)).toEqual(["sales-chart"]);
  });

  test("refuses empty, oversized and badly named pages", () => {
    const s = store();
    expect(() => s.save({ html: "  " })).toThrow("The page is empty");
    expect(() => s.save({ html: "x".repeat(5 * 1024 * 1024 + 1) })).toThrow("at most");
    expect(() => s.save({ id: "../up", html: page("x") })).toThrow("Invalid artifact ID");
    expect(() => s.read("missing")).toThrow("No artifact missing");
    expect(titleOf("<title> A \n page </title>")).toBe("A page");
  });
});

describe("secret scan", () => {
  test("finds key formats and credential assignments by line, never their values", () => {
    const findings = findSecrets(
      ["<p>fine</p>", "const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'", 'api_key: "abc123"'].join("\n"),
    );
    expect(findings).toEqual([
      { line: 2, kind: "Anthropic key" },
      { line: 3, kind: "credential or secret environment value" },
    ]);
    expect(findSecrets(page("Clean"))).toEqual([]);
  });
});

describe("deploy", () => {
  const on = { artifactDeploy: true };

  test("a plan is refused while deploys are off, without a token, or with a secret in the page", () => {
    const s = store();
    s.save({ id: "demo", html: page("Demo") });
    expect(planDeploy(s, {}, "demo", "preview", "t").refusal).toMatch(/^Deploying artifacts is off/);
    expect(planDeploy(s, on, "demo", "preview", null).refusal).toMatch(/^No Vercel token/);
    const ok = planDeploy(s, { ...on, vercelTeamId: "team_1" }, "demo", "production", "t");
    expect(ok).toMatchObject({ refusal: null, project: "baked-demo", teamId: "team_1", target: "production" });
    s.save({ id: "demo", html: page("Demo", "token = ghp_abcdefghijklmnopqrstuvwxyz0123") });
    expect(planDeploy(s, on, "demo", "preview", "t").refusal).toContain("line 1: GitHub token");
  });

  test("sends the page as a preview deployment and records it on the artifact", async () => {
    const s = store();
    s.save({ id: "demo", html: page("Demo") });
    const vercel = fakeVercel();
    const { deployment, artifact } = await deployArtifact(s, on, "demo", "preview", {
      token: "tok",
      baseUrl: vercel.baseUrl,
      pollMs: 1,
    });
    expect(deployment).toEqual({ id: "dpl_1", url: "https://baked-x-abc.vercel.app", target: "preview" });
    expect(artifact.deploys).toMatchObject([{ id: "dpl_1", version: 1, target: "preview" }]);
    const [create, poll] = vercel.seen;
    expect(create?.auth).toBe("Bearer tok");
    expect(create?.body).toMatchObject({ name: "baked-demo", projectSettings: { framework: null } });
    expect((create?.body as { target?: string }).target).toBeUndefined();
    const file = (create?.body as { files: { file: string; data: string }[] }).files[0];
    expect(file?.file).toBe("index.html");
    expect(Buffer.from(file?.data ?? "", "base64").toString()).toBe(page("Demo"));
    expect(poll?.path).toBe("/v13/deployments/dpl_1");
  });

  test("production goes to the alias and names the team", async () => {
    const vercel = fakeVercel();
    const result = await deployToVercel("baked-demo", page("x"), "production", {
      token: "tok",
      teamId: "team_1",
      baseUrl: vercel.baseUrl,
      pollMs: 1,
    });
    expect(result.url).toBe("https://baked-x.vercel.app");
    expect(vercel.seen[0]?.path).toBe("/v13/deployments?teamId=team_1");
    expect(vercel.seen[0]?.body).toMatchObject({ target: "production" });
  });

  test("a refused token says so", async () => {
    const vercel = fakeVercel({ status: 403 });
    const deploy = deployToVercel("p", page("x"), "preview", { token: "bad", baseUrl: vercel.baseUrl });
    await expect(deploy).rejects.toBeInstanceOf(VercelError);
    await expect(deploy).rejects.toThrow("Vercel refused the token (403)");
  });
});

describe("baked artifacts", () => {
  test("saves, lists, shows and refuses an unconfirmed deploy", async () => {
    const s = store();
    const file = join(s.root, "..", "page.html");
    writeFileSync(file, page("From CLI"));
    let output = "";
    const out = (text: string) => {
      output += text;
    };
    expect(await runArtifactsCli(["save", file, "--json"], s, out)).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ id: "from-cli", version: 1 });
    output = "";
    expect(await runArtifactsCli(["list"], s, out)).toBe(0);
    expect(output).toContain("from-cli  v1");
    output = "";
    expect(await runArtifactsCli(["show", "from-cli", "--html"], s, out)).toBe(0);
    expect(output).toBe(page("From CLI"));
    output = "";
    expect(await runArtifactsCli(["deploy", "from-cli"], s, out, () => ({}))).toBe(1);
    expect(output).toContain('Deploy "From CLI" (from-cli v1');
    expect(output).toContain("Refused: Deploying artifacts is off");
    expect(await runArtifactsCli(["show", "missing"], s, out)).toBe(2);
    expect(await runArtifactsCli(["bogus"], s, out)).toBe(2);
  });
});

describe("artifact tool", () => {
  const run = (t: ReturnType<typeof createArtifactTool>, args: Record<string, unknown>) =>
    (t.execute as (a: unknown, o: unknown) => Promise<string>)(args, { toolCallId: "t", messages: [] });

  test("saves from a project file, lists, and asks before every deploy", async () => {
    const s = store();
    const project = join(s.root, "..", "project");
    mkdirSync(project);
    writeFileSync(join(project, "chart.html"), page("Chart"));
    const asked: string[] = [];
    const vercel = fakeVercel();
    let answer = false;
    const t = createArtifactTool({
      cwd: project,
      store: s,
      config: () => ({ artifactDeploy: true }),
      onApproveDeploy: async (question) => {
        asked.push(question);
        return answer;
      },
    });
    expect(await run(t, { action: "save", path: "chart.html" })).toContain("Saved artifact chart v1");
    expect(await run(t, { action: "save", path: "../outside.html" })).toContain("outside the project");
    expect(await run(t, { action: "list" })).toContain('- chart v1 "Chart"');
    const saved = process.env.VERCEL_TOKEN;
    process.env.VERCEL_TOKEN = "tok";
    try {
      expect(await run(t, { action: "deploy", id: "chart" })).toBe("Not deployed: the user declined.");
      expect(asked[0]).toContain('Deploy artifact "Chart" (chart v1');
      expect(vercel.seen).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.VERCEL_TOKEN;
      else process.env.VERCEL_TOKEN = saved;
    }
    answer = true;
    const noAsk = createArtifactTool({ cwd: project, store: s, config: () => ({ artifactDeploy: true }) });
    expect(await run(noAsk, { action: "deploy", id: "chart" })).toMatch(/^Not deployed/);
  });

  test("/artifacts deploy asks the agent to use the tool", () => {
    expect(deployRequest("chart", true)).toContain("action deploy, id chart, target production");
  });
});

describe("artifacts API", () => {
  test("lists, saves, previews, opens, plans and deploys only with confirm", async () => {
    const s = store();
    const fixture = workflowFixture();
    fixture.service.config.artifactDeploy = true;
    const vercel = fakeVercel();
    const opened: string[] = [];
    const server = await startApiServer({
      service: fixture.service,
      artifacts: s,
      vercel: { baseUrl: vercel.baseUrl, token: "tok", pollMs: 1 },
      openArtifact: (path) => {
        opened.push(path);
        return true;
      },
    });
    try {
      const call = (path: string, init: RequestInit = {}) =>
        fetch(`${server.url}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        });
      const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
      expect(health.capabilities).toContain("artifacts");
      const saved = await call("/v1/artifacts", { method: "POST", body: JSON.stringify({ html: page("Api Page") }) });
      expect(saved.status).toBe(201);
      expect(((await (await call("/v1/artifacts")).json()) as { items: { id: string }[] }).items.map((a) => a.id)).toEqual(["api-page"]);
      expect(await (await call("/v1/artifacts/api-page/page")).json()).toEqual({ id: "api-page", version: 1, html: page("Api Page") });
      expect((await (await call("/v1/artifacts/api-page/open", { method: "POST" })).json()) as { opened: boolean }).toMatchObject({ opened: true });
      expect(opened).toEqual([s.pagePath("api-page")]);
      const plan = (await (await call("/v1/artifacts/api-page/deploy?target=production")).json()) as { refusal: string | null; target: string };
      expect(plan).toMatchObject({ refusal: null, target: "production" });
      expect((await call("/v1/artifacts/api-page/deploy", { method: "POST", body: "{}" })).status).toBe(400);
      expect(vercel.seen).toEqual([]);
      const deployed = await call("/v1/artifacts/api-page/deploy", { method: "POST", body: JSON.stringify({ confirm: true }) });
      expect(deployed.status).toBe(200);
      expect(((await deployed.json()) as { deployment: { url: string } }).deployment.url).toBe("https://baked-x-abc.vercel.app");
      expect((await call("/v1/artifacts/missing")).status).toBe(404);
      expect((await call("/v1/artifacts/api-page", { method: "DELETE" })).status).toBe(200);
      expect(s.list()).toEqual([]);
    } finally {
      await server.stop();
      await fixture.dispose();
    }
  });
});
