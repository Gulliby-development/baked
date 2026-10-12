import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("provider secret registration", () => {
	test("loading the provider registry maps each key to its environment variable", () => {
		// A fresh process: `baked serve` loads providers without boot registering their secrets.
		const home = mkdtempSync(join(tmpdir(), "baked-secret-env-"));
		try {
			const script = `
				await import(${JSON.stringify(resolve("src/core/llm/providers/index.ts"))});
				const { hasSecret } = await import(${JSON.stringify(resolve("src/core/secrets.ts"))});
				console.log(JSON.stringify(hasSecret("openai-api-key")));
			`;
			const proc = Bun.spawnSync([process.execPath, "-e", script], {
				env: {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					OPENAI_API_KEY: "sk-test-env",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = proc.stdout.toString().trim().split("\n").pop() ?? "";
			expect(JSON.parse(out)).toEqual({ set: true, source: "env" });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
