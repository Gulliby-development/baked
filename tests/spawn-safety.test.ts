import { describe, expect, it } from "bun:test";
import { SAFE_STDIO, buildSafeEnv } from "../src/core/spawn.js";

describe("buildSafeEnv", () => {
	it("sets GIT_TERMINAL_PROMPT=0 to prevent interactive git prompts", () => {
		const env = buildSafeEnv();
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("preserves PATH", () => {
		const env = buildSafeEnv();
		expect(env.PATH).toBeDefined();
	});

	it("preserves HOME", () => {
		const previous = process.env.HOME;
		process.env.HOME = process.env.USERPROFILE ?? "/home/test";
		const env = buildSafeEnv();
		try { expect(env.HOME).toBe(process.env.HOME); }
		finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
	});

	it("preserves SSH_AUTH_SOCK for key-based auth", () => {
		const original = process.env.SSH_AUTH_SOCK;
		process.env.SSH_AUTH_SOCK = "/tmp/ssh-test";
		const env = buildSafeEnv();
		expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-test");
		if (original) process.env.SSH_AUTH_SOCK = original;
		else delete process.env.SSH_AUTH_SOCK;
	});

	it("strips API keys", () => {
		process.env.SOME_API_KEY = "secret";
		const env = buildSafeEnv();
		expect(env.SOME_API_KEY).toBeUndefined();
		delete process.env.SOME_API_KEY;
	});

	it("strips tokens", () => {
		process.env.GITHUB_TOKEN = "ghp_secret";
		const env = buildSafeEnv();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		delete process.env.GITHUB_TOKEN;
	});

	it("strips passwords", () => {
		process.env.DB_PASSWORD = "hunter2";
		const env = buildSafeEnv();
		expect(env.DB_PASSWORD).toBeUndefined();
		delete process.env.DB_PASSWORD;
	});

	it("strips credentials", () => {
		process.env.AWS_CREDENTIAL = "secret";
		const env = buildSafeEnv();
		expect(env.AWS_CREDENTIAL).toBeUndefined();
		delete process.env.AWS_CREDENTIAL;
	});

	it("strips private keys", () => {
		process.env.MY_PRIVATE_KEY = "secret";
		const env = buildSafeEnv();
		expect(env.MY_PRIVATE_KEY).toBeUndefined();
		delete process.env.MY_PRIVATE_KEY;
	});

	it("preserves LC_ vars", () => {
		process.env.LC_ALL = "en_US.UTF-8";
		const env = buildSafeEnv();
		expect(env.LC_ALL).toBe("en_US.UTF-8");
		delete process.env.LC_ALL;
	});

	it("preserves XDG_ vars", () => {
		process.env.XDG_CONFIG_HOME = "/home/test/.config";
		const env = buildSafeEnv();
		expect(env.XDG_CONFIG_HOME).toBe("/home/test/.config");
		delete process.env.XDG_CONFIG_HOME;
	});

	it("preserves git author/committer env vars", () => {
		process.env.GIT_AUTHOR_NAME = "Test";
		process.env.GIT_COMMITTER_EMAIL = "test@test.com";
		const env = buildSafeEnv();
		expect(env.GIT_AUTHOR_NAME).toBe("Test");
		expect(env.GIT_COMMITTER_EMAIL).toBe("test@test.com");
		delete process.env.GIT_AUTHOR_NAME;
		delete process.env.GIT_COMMITTER_EMAIL;
	});

	it("allows non-secret env vars through", () => {
		process.env.MY_CUSTOM_FLAG = "1";
		const env = buildSafeEnv();
		expect(env.MY_CUSTOM_FLAG).toBe("1");
		delete process.env.MY_CUSTOM_FLAG;
	});
});

describe("SAFE_STDIO", () => {
	it("ignores stdin to prevent interactive prompts", () => {
		expect(SAFE_STDIO).toEqual(["ignore", "pipe", "pipe"]);
	});

	it("pipes stdout for capture", () => {
		expect(SAFE_STDIO?.[1]).toBe("pipe");
	});

	it("pipes stderr for capture", () => {
		expect(SAFE_STDIO?.[2]).toBe("pipe");
	});
});

describe("subprocess stdin isolation", () => {
	it("command that reads stdin gets EOF immediately with SAFE_STDIO", async () => {
		const { spawn, spawnSync } = await import("node:child_process");
		// The child reads fd 0 itself, as git, ssh and a shell do, and prints how many bytes it got:
		// with stdin ignored the read returns end of file at once. The answer comes from the child's
		// stdout reaching end of file, not from its exit event. On macOS, after about 75 other files
		// in one `bun test` process, neither "close" (#3032) nor "exit" with a 10 s spawn timeout
		// (#3036) arrived before the 30 s limit, while isolated reruns passed: the child's exit was
		// not delivered to the test process. A pipe's end of file is a separate event, and if it does
		// not come either, the failure says whether the child is still running or already exited.
		const proc = spawn(
			process.execPath,
			["-e", 'process.stdout.write(`read ${require("node:fs").readFileSync(0).length}`)'],
			{ stdio: SAFE_STDIO, env: buildSafeEnv() },
		);
		const deadlineMs = 20_000;
		let out = "";
		proc.stdout?.on("data", (chunk) => {
			out += chunk;
		});
		const ended = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), deadlineMs);
			proc.stdout?.on("end", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		if (!ended) {
			const state =
				process.platform === "win32"
					? "unknown"
					: spawnSync("ps", ["-o", "stat=", "-p", String(proc.pid)], { encoding: "utf8" }).stdout.trim() || "gone";
			proc.kill("SIGKILL");
			throw new Error(`child ${proc.pid} stdout still open after ${deadlineMs / 1000} s; ps state ${state}, exitCode ${proc.exitCode}`);
		}
		expect(out).toBe("read 0");
	});

	it("git command fails cleanly instead of prompting when auth is missing", async () => {
		const { spawn } = await import("node:child_process");
		// A local server that demands credentials keeps the test off the network, where a slow
		// runner could hit the spawn timeout and report a kill instead of git's own failure.
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="test"' } }),
		});
		try {
			const env = buildSafeEnv();
			env.GIT_ASKPASS = "/bin/false";
			// Only the prompt paths the safe env controls may answer the 401. The runner's own git
			// config adds a credential helper (Git Credential Manager on windows-latest) that can
			// stall past the timeout, and its child keeps the pipes open after git is killed (#2872).
			env.GIT_CONFIG_NOSYSTEM = "1";
			env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
			const proc = spawn("git", ["-c", "credential.helper=", "ls-remote", `http://127.0.0.1:${server.port}/missing.git`], {
				stdio: SAFE_STDIO,
				env,
				timeout: 30_000,
			});
			const stderr: string[] = [];
			proc.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
			const code = await new Promise<number | null>((resolve) => {
				proc.on("close", resolve);
			});
			expect(code).not.toBe(null);
			expect(code).not.toBe(0);
		} finally {
			server.stop(true);
		}
	});

	it("interactive command gets EOF instead of hanging", async () => {
		const { spawn } = await import("node:child_process");
		const proc = spawn(process.execPath, ["-e", "const input = await Bun.stdin.text(); if (input) console.log(input); else process.exit(1)"], {
			stdio: SAFE_STDIO,
			env: buildSafeEnv(),
			timeout: 5_000,
		});
		const stdout: string[] = [];
		proc.stdout?.on("data", (d: Buffer) => stdout.push(d.toString()));
		const code = await new Promise<number | null>((resolve) => {
			proc.on("close", resolve);
		});
		expect(stdout.join("").trim()).toBe("");
		expect(code).toBe(1);
	});
});
