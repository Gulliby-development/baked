import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { LlmSelector } from "../src/components/modals/LlmSelector";
import { PROVIDER_CONFIGS } from "../src/core/llm/models";
import { getProvider } from "../src/core/llm/providers/index";
import type { ProviderDefinition } from "../src/core/llm/providers/types";

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

function stub(id: string, methods: Partial<ProviderDefinition>) {
	const provider = getProvider(id) as ProviderDefinition;
	const saved = { ...provider };
	Object.assign(provider, methods);
	restores.push(() => Object.assign(provider, saved));
}

describe("model picker", () => {
	test("counts only usable providers as ready and keeps the model count beside a badge", async () => {
		const ready = new Set(["codex", "claude-code"]);
		for (const cfg of PROVIDER_CONFIGS) {
			const on = ready.has(cfg.id);
			stub(cfg.id, {
				checkAvailability: async () => on,
				fetchModels: async () => (on ? [{ id: `${cfg.id}-model`, name: `${cfg.id} model` }] : null),
			});
		}
		const view = await testRender(
			<LlmSelector visible activeModel="none" onSelect={() => {}} onClose={() => {}} />,
			{ width: 120, height: 40 },
		);
		const settle = async () => {
			for (let i = 0; i < 6; i++)
				await act(async () => {
					await Bun.sleep(5);
					await view.flush();
					await view.renderOnce();
				});
		};
		try {
			await settle();
			const frame = view.captureCharFrame();
			const header = frame.split("\n").find((line) => line.includes("providers ready")) ?? "";
			expect(header).toMatch(/ 2\/\d+ providers ready/);
			const claudeCode = frame.split("\n").find((line) => line.includes("Claude Code")) ?? "";
			expect(claudeCode).toContain("1 · non-streaming");
		} finally {
			await act(async () => {
				view.renderer.destroy();
			});
		}
	});
});
