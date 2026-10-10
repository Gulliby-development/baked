import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { gitCommit, gitInit, setCoAuthorEnabled } from "../src/core/git/status.js";

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "sf-git-test-"));
	execSync("git init", { cwd: dir, stdio: "ignore" });
	execSync("git config user.email test@test.com", { cwd: dir, stdio: "ignore" });
	execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
	writeFileSync(join(dir, "file.txt"), "");
	execSync("git add file.txt", { cwd: dir, stdio: "ignore" });
	return dir;
}

function getCommitMessage(cwd: string): string {
	return execSync("git log -1 --format=%B", { cwd, encoding: "utf-8" }).trimEnd();
}

describe("gitCommit message formatting", () => {
	let dir: string;

	beforeEach(() => {
		dir = initRepo();
		setCoAuthorEnabled(true);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("converts literal \\n to real newlines in message", async () => {
		const { ok } = await gitCommit(dir, "feat: add X\\n\\nBody line 1\\nBody line 2");
		expect(ok).toBe(true);
		const msg = getCommitMessage(dir);
		expect(msg).toContain("feat: add X\n\nBody line 1\nBody line 2");
		expect(msg).not.toContain("\\n");
	});

	it("preserves real newlines in message", async () => {
		const { ok } = await gitCommit(dir, "feat: add X\n\nBody text");
		expect(ok).toBe(true);
		const msg = getCommitMessage(dir);
		expect(msg).toContain("feat: add X\n\nBody text");
	});

	it("single-line message works", async () => {
		const { ok } = await gitCommit(dir, "fix: simple change");
		expect(ok).toBe(true);
		const msg = getCommitMessage(dir);
		expect(msg.split("\n")[0]).toBe("fix: simple change");
	});

	it("appends co-author trailer when enabled", async () => {
		setCoAuthorEnabled(true);
		const { ok } = await gitCommit(dir, "feat: test");
		expect(ok).toBe(true);
		const msg = getCommitMessage(dir);
		expect(msg).toContain("Co-Authored-By: BAKED <noreply@github.com>");
	});

	it("omits co-author trailer when disabled", async () => {
		setCoAuthorEnabled(false);
		const { ok } = await gitCommit(dir, "feat: test");
		expect(ok).toBe(true);
		const msg = getCommitMessage(dir);
		expect(msg).not.toContain("Co-Authored-By");
	});

	it("subject and body separated by blank line", async () => {
		const { ok } = await gitCommit(dir, "feat: X\\n\\nBody here");
		expect(ok).toBe(true);
		const msg = getCommitMessage(dir);
		const lines = msg.split("\n");
		expect(lines[0]).toBe("feat: X");
		expect(lines[1]).toBe("");
		expect(lines[2]).toBe("Body here");
	});

	it("handles mixed literal and real newlines", async () => {
		const { ok } = await gitCommit(dir, "feat: X\\n\\nLine 1\nLine 2\\nLine 3");
		expect(ok).toBe(true);
		const msg = getCommitMessage(dir);
		expect(msg).toContain("Line 1\nLine 2\nLine 3");
		expect(msg).not.toContain("\\n");
	});
});

describe("git tool body/footer assembly", () => {
	let dir: string;

	beforeEach(() => {
		dir = initRepo();
		setCoAuthorEnabled(false);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("body appended as separate paragraph", async () => {
		const msg = "feat: add X\n\nExtended description";
		const { ok } = await gitCommit(dir, msg);
		expect(ok).toBe(true);
		const result = getCommitMessage(dir);
		expect(result).toBe("feat: add X\n\nExtended description");
	});

	it("footer appended after body", async () => {
		const msg = "feat: add X\n\nBody text\n\nFixes #123";
		const { ok } = await gitCommit(dir, msg);
		expect(ok).toBe(true);
		const result = getCommitMessage(dir);
		expect(result).toBe("feat: add X\n\nBody text\n\nFixes #123");
	});

	it("footer without body", async () => {
		const msg = "feat: add X\n\nFixes #123";
		const { ok } = await gitCommit(dir, msg);
		expect(ok).toBe(true);
		const result = getCommitMessage(dir);
		expect(result).toBe("feat: add X\n\nFixes #123");
	});
});

