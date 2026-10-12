import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployArtifact, planDeploy } from "../src/core/artifacts/deploy.js";
import { findSecrets } from "../src/core/artifacts/scan.js";
import { ArtifactStore, titleOf } from "../src/core/artifacts/store.js";
import { deployToVercel, VercelError } from "../src/core/artifacts/vercel.js";
import { runArtifactsCli } from "../src/headless/artifacts.js";
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
