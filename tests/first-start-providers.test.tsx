import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { SetupStep } from "../src/components/modals/wizard/steps/SetupStep";
import { getProvider } from "../src/core/llm/providers/index";
import type { ProviderDefinition } from "../src/core/llm/providers/types";
import { soleReadyModel } from "../src/core/llm/ready-model";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** Replaces methods of a registered provider for one test. */
function stub(id: string, methods: Partial<ProviderDefinition>) {
  const provider = getProvider(id) as ProviderDefinition;
  const saved = { ...provider };
  Object.assign(provider, methods);
  restores.push(() => Object.assign(provider, saved));
}

function cli(id: string, ready: boolean): ProviderDefinition {
  return {
    id,
    name: id,
    envVar: "",
    icon: "*",
    fallbackModels: [{ id: "default-model", name: "Default" }],
    contextWindows: [],
    createModel: () => {
      throw new Error("unused");
    },
    fetchModels: async () => null,
    checkAvailability: async () => ready,
  } as unknown as ProviderDefinition;
}

describe("first start", () => {
  test("the only ready provider gives the model to start with", async () => {
    expect(await soleReadyModel([cli("codex", true), cli("claude-code", false)])).toBe(
      "codex/default-model",
    );
    expect(await soleReadyModel([cli("codex", true), cli("claude-code", true)])).toBeNull();
    expect(await soleReadyModel([cli("codex", false)])).toBeNull();
  });

  test("the provider step lists signed-in CLI providers first and opens their models", async () => {
    stub("codex", {
      checkAvailability: async () => true,
      fetchModels: async () => [{ id: "gpt-test", name: "GPT Test" }],
    });
    stub("claude-code", { checkAvailability: async () => false });
    let selected: string | undefined;
    const view = await testRender(
      <SetupStep
        iw={90}
        hasModel={false}
        activeModel="none"
        onSelectModel={(id) => {
          selected = id;
        }}
        onForward={() => {}}
        active={false}
        setActive={() => {}}
      />,
      { width: 100, height: 30 },
    );
    const settle = async () => {
      for (let i = 0; i < 4; i++)
        await act(async () => {
          await Bun.sleep(5);
          await view.flush();
          await view.renderOnce();
        });
    };
    try {
      await settle();
      const frame = view.captureCharFrame();
      const lines = frame.split("\n");
      const codexRow = lines.findIndex((line) => line.includes("Codex —"));
      const claudeRow = lines.findIndex((line) => line.includes("Claude —"));
      expect(codexRow).toBeGreaterThan(-1);
      expect(codexRow).toBeLessThan(claudeRow);
      expect(lines[codexRow]).toContain("✓ signed in");
      expect(frame).toContain("/claude-code login");

      // Codex is first and selected: Enter lists its models, Enter picks one.
      await act(async () => {
        view.mockInput.pressEnter();
      });
      await settle();
      expect(view.captureCharFrame()).toContain("GPT Test");
      await act(async () => {
        view.mockInput.pressEnter();
      });
      await settle();
      expect(selected).toBe("codex/gpt-test");
    } finally {
      await act(async () => {
        view.renderer.destroy();
      });
    }
  });
});
