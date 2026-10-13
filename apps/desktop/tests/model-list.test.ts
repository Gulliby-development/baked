import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { cacheId, invalidateProject, readQuery, resetQueryCache } = await import(
  "../src/renderer/client/cache.ts"
);
const { chat } = await import("../src/renderer/client/chat.ts");
const { MODELS_STALE_MS, modelsKey, prefetchModels } = await import(
  "../src/renderer/lib/models.ts"
);
const { EffortMenu, ModelMenu } = await import("../src/renderer/screens/chat/Composer.tsx");
delete scope.window;

type Providers = Awaited<ReturnType<typeof chat.models>>;
const catalog: Providers = {
  providers: [
    {
      id: "codex",
      name: "Codex",
      configured: true,
      models: [{ id: "codex/gpt-6-astra", name: "gpt-6-astra", efforts: ["low", "high"] }],
    },
  ],
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let clock = 0;

beforeEach(() => {
  clock = 1_000;
  resetQueryCache(() => clock);
});

// gulliby 2026-10-13: every click on the model or effort chip showed "Loading models…" and
// asked the backend again.
describe("the composer's model list", () => {
  test("is fetched once in the background and served from the cache after that", async () => {
    const models = spyOn(chat, "models").mockResolvedValue(catalog);
    prefetchModels("p1");
    await flush();
    expect(models).toHaveBeenCalledTimes(1);
    expect(readQuery<Providers>(cacheId(modelsKey("p1"))).data).toEqual(catalog);

    clock += MODELS_STALE_MS - 1;
    prefetchModels("p1");
    expect(models).toHaveBeenCalledTimes(1);

    // A sign-in or a new key is a write, which makes the list stale.
    invalidateProject("p1");
    prefetchModels("p1");
    await flush();
    expect(models).toHaveBeenCalledTimes(2);
    models.mockRestore();
  });

  test("opens the model and effort menus on the cached list without a loading line", () => {
    const list = { providers: catalog.providers, error: null };
    const close = () => {};
    const modelMenu = renderToStaticMarkup(
      createElement(ModelMenu, { model: null, models: list, onModel: () => {}, close }),
    );
    expect(modelMenu).toContain("gpt-6-astra");
    expect(modelMenu).not.toContain("Loading");
    const effortMenu = renderToStaticMarkup(
      createElement(EffortMenu, {
        model: "codex/gpt-6-astra",
        effort: "default",
        models: list,
        onEffort: () => {},
        close,
      }),
    );
    expect(effortMenu).toContain("High");
    expect(effortMenu).not.toContain("Loading");
    const first = renderToStaticMarkup(
      createElement(ModelMenu, {
        model: null,
        models: { providers: null, error: null },
        onModel: () => {},
        close,
      }),
    );
    expect(first).toContain("Loading models");
  });
});
