import { getIntelligenceClient, getIntelligenceRouter } from "./instance.js";
import type { SymbolInfo } from "./types.js";

export async function getSymbolContainers(cwd: string, file: string): Promise<Map<string, string>> {
  const client = getIntelligenceClient();
  let symbols: SymbolInfo[] | null;
  if (client) {
    symbols = (await client.routerFindSymbols(file))?.value ?? null;
  } else {
    const router = getIntelligenceRouter(cwd);
    symbols = await router.executeWithFallback(
      router.detectLanguage(file),
      "findSymbols",
      (backend) => backend.findSymbols?.(file) ?? Promise.resolve(null),
    );
  }
  const containers = new Map<string, string>();
  for (const symbol of symbols ?? []) {
    if (symbol.containerName)
      containers.set(`${symbol.name}:${symbol.location.line}`, symbol.containerName);
  }
  return containers;
}
