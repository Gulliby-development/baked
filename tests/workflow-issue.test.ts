import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartBody } from "../src/core/api/schemas.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import {
  closingReference,
  fetchIssue,
  issueFeatureId,
  issuePrompt,
  issueStart,
  parseIssueReference,
} from "../src/core/workflows/issue-source.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import type { AppConfig } from "../src/types/index.js";

const config = { workflows: { enabled: true } } as unknown as AppConfig;
const issueJson = {
  number: 12,
  html_url: "https://github.com/acme/widget/issues/12",
  title: "Add a --json flag",
  body: "<!-- template hint -->\nPrint the status as JSON.",
  state: "open",
};
function fakeFetch(status: number, body: unknown, calls: { url: string; headers: Record<string, string> }[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}
function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

describe("issue references", () => {
  test("accept an issue URL, owner/name#N and #N for the origin repository", () => {
    expect(parseIssueReference("https://github.com/acme/widget/issues/12", "github.com", null)).toEqual({ repository: "acme/widget", number: 12 });
    expect(parseIssueReference("https://github.com/acme/widget/issues/12#issuecomment-1", "github.com", null)).toEqual({ repository: "acme/widget", number: 12 });
    expect(parseIssueReference("acme/widget#3", "github.com", null)).toEqual({ repository: "acme/widget", number: 3 });
    expect(parseIssueReference("#4", "github.com", "acme/widget")).toEqual({ repository: "acme/widget", number: 4 });
    expect(parseIssueReference("5", "github.com", "acme/widget")).toEqual({ repository: "acme/widget", number: 5 });
  });

  test("refuse another host, a pull request URL and #N without a GitHub origin", () => {
    expect(() => parseIssueReference("https://gitlab.com/acme/widget/issues/1", "github.com", null)).toThrow(/not on github.com/);
    expect(() => parseIssueReference("https://github.com/acme/widget/pull/1", "github.com", null)).toThrow(WorkflowFault);
    expect(() => parseIssueReference("#1", "github.com", null)).toThrow(/needs a repository/);
  });
});

describe("reading an issue", () => {
  test("sends the configured token and builds the prompt, feature ID and closing line", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const started = await issueStart(
      tmpdir(),
      config,
      { reference: "acme/widget#12", prompt: "Keep the text output." },
      { fetch: fakeFetch(200, issueJson, calls), env: { GITHUB_TOKEN: "t0ken" } },
    );
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/widget/issues/12");
    expect(calls[0]?.headers.authorization).toBe("Bearer t0ken");
    expect(started.featureId).toBe("issue-12-add-a-json-flag");
    expect(started.issue).toEqual({ repository: "acme/widget", number: 12, url: issueJson.html_url, title: issueJson.title });
    expect(started.prompt).toContain("Add a --json flag (GitHub issue acme/widget#12)");
    expect(started.prompt).toContain("Print the status as JSON.");
    expect(started.prompt).not.toContain("template hint");
    expect(started.prompt).toContain("Additional instructions:\nKeep the text output.");
    expect(started.prompt).toContain(`Source: ${issueJson.html_url}`);
    expect(closingReference(started.issue, "acme/widget")).toBe("Closes #12");
    expect(closingReference(started.issue, "acme/app")).toBe("Closes acme/widget#12");
  });

  test("a given feature ID wins and a public issue is read without a token", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const started = await issueStart(tmpdir(), config, { reference: "acme/widget#12", featureId: "json-status" }, { fetch: fakeFetch(200, issueJson, calls), env: {} });
    expect(started.featureId).toBe("json-status");
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  test("#N reads the repository of the origin remote", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-issue-"));
    try {
      git(root, "init", "-q");
      git(root, "remote", "add", "origin", "git@github.com:acme/widget.git");
      const calls: { url: string; headers: Record<string, string> }[] = [];
      await fetchIssue(root, config, "#12", { fetch: fakeFetch(200, issueJson, calls), env: {} });
      expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/widget/issues/12");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pull request and a missing issue are refused with a reason", async () => {
    await expect(fetchIssue(tmpdir(), config, "acme/widget#12", { fetch: fakeFetch(200, { ...issueJson, pull_request: {} }), env: {} })).rejects.toThrow(/is a pull request/);
    await expect(fetchIssue(tmpdir(), config, "acme/widget#12", { fetch: fakeFetch(404, { message: "Not Found" }), env: {} })).rejects.toThrow(/Set GITHUB_TOKEN/);
  });

  test("a long body is clipped with a link and the feature ID stays a valid ID", () => {
    const issue = { ...issueJson, repository: "acme/widget", url: issueJson.html_url, body: "x".repeat(30000) };
    expect(issuePrompt(issue)).toContain(`[The issue continues at ${issueJson.html_url}]`);
    expect(issueFeatureId({ number: 9, title: "A very long title that goes on and on about many separate things" })).toMatch(/^issue-9-[a-z0-9-]+[a-z0-9]$/);
  });
});

describe("starting from an issue", () => {
  test("the CLI takes --issue in place of --prompt and --feature", () => {
    expect(parseWorkflowArgs(["run", "--issue", "#12"]).flags.issue).toBe("#12");
    expect(parseWorkflowArgs(["run", "--issue", "#12", "--prompt", "Also docs"]).flags.prompt).toBe("Also docs");
    expect(() => parseWorkflowArgs(["run", "--feature", "x"])).toThrow(/--prompt, --prompt-file or --issue/);
    expect(() => parseWorkflowArgs(["run", "--issue", "#1", "--prompt", "a", "--prompt-file", "b"])).toThrow(/at most one/);
  });

  test("the API needs feature and prompt only without an issue", () => {
    expect(StartBody.safeParse({ commandId: "c1", issue: "#12" }).success).toBe(true);
    expect(StartBody.safeParse({ commandId: "c1", prompt: "x" }).success).toBe(false);
    expect(StartBody.safeParse({ commandId: "c1", feature: "f", prompt: "x" }).success).toBe(true);
  });
});
