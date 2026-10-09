import type { ToolResult } from "../../types/index.js";
import { getSecret } from "../secrets.js";

interface WebSearchArgs {
  query: string;
  count?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

let lastBraveError: string | null = null;

const searchCache = new Map<string, { results: SearchResult[]; ts: number; _backend: string }>();
const CACHE_TTL = 5 * 60_000;
const MAX_CACHE_SIZE = 100;

let lastSweep = 0;
function getCached(key: string): { results: SearchResult[]; backend: string } | null {
  const now = Date.now();
  if (now - lastSweep > CACHE_TTL) {
    lastSweep = now;
    for (const [k, v] of searchCache) {
      if (now - v.ts > CACHE_TTL) searchCache.delete(k);
    }
  }
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (now - entry.ts > CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  return { results: entry.results, backend: entry._backend };
}

async function braveSearch(query: string, count: number): Promise<SearchResult[]> {
  const apiKey = getSecret("brave-api-key");
  if (!apiKey) return [];

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(count, 20)),
    text_decorations: "false",
    search_lang: "en",
  });

  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    lastBraveError =
      res.status === 401 || res.status === 403
        ? `Brave API key invalid (HTTP ${String(res.status)}) — falling back to DuckDuckGo`
        : `Brave API error (HTTP ${String(res.status)}) — falling back to DuckDuckGo`;
    return [];
  }
  lastBraveError = null;

  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };

  return (data.web?.results ?? [])
    .filter((r) => r.title && r.url)
    .slice(0, count)
    .map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
}

async function duckduckgoSearch(query: string, count: number): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query);
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
    headers: { "User-Agent": "baked/1.0" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return [];

  const html = await res.text();
  const results: SearchResult[] = [];

  const resultRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match = resultRegex.exec(html);
  while (match && results.length < count) {
    const title = (match[2] ?? "").trim();
    const snippet = (match[3] ?? "")
      .replace(/<\/?b>/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .trim();
    const href = decodeURIComponent((match[1] ?? "").replace(/.*uddg=/, "").replace(/&.*/, ""));
    if (title && snippet) {
      results.push({ title, url: href, snippet });
    }
    match = resultRegex.exec(html);
  }

  if (results.length === 0) {
    const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let sMatch = snippetRegex.exec(html);
    while (sMatch && results.length < count) {
      const text = (sMatch[1] ?? "")
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .trim();
      if (text) results.push({ title: "", url: "", snippet: text });
      sMatch = snippetRegex.exec(html);
    }
  }

  return results;
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results found for: ${query}`;

  const formatted = results.map((r) => {
    if (!r.title && !r.url) return r.snippet;
    return `**${r.title}**\n${r.url}\n${r.snippet}`;
  });

  return `Search results for "${query}":\n\n${formatted.join("\n\n---\n\n")}`;
}

export const webSearchScraper = {
  name: "web_search",
  description:
    "Search the web for current information. Use this when you need up-to-date data, documentation, or answers that may not be in the codebase. Returns search result snippets.",
  execute: async (args: WebSearchArgs): Promise<ToolResult> => {
    const { query } = args;
    const count = args.count ?? 5;

    for (const be of ["brave", "ddg"]) {
      const cached = getCached(`${query}::${String(count)}::${be}`);
      if (cached) {
        return {
          success: true,
          output: formatResults(query, cached.results),
          backend: cached.backend,
        };
      }
    }

    try {
      let results = await braveSearch(query, count);
      let backend = "brave";
      const warning = lastBraveError;

      if (results.length === 0) {
        results = await duckduckgoSearch(query, count);
        backend = "ddg";
      }

      const cacheKey = `${query}::${String(count)}::${backend}`;
      if (searchCache.size >= MAX_CACHE_SIZE) {
        const oldest = searchCache.keys().next().value;
        if (oldest) searchCache.delete(oldest);
      }
      searchCache.set(cacheKey, { results, ts: Date.now(), _backend: backend });
      const output = formatResults(query, results);
      return {
        success: true,
        output: warning ? `⚠ ${warning}\n\n${output}` : output,
        backend,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Search failed: ${msg}. If you know a specific URL, use fetch_page on it directly instead of searching.`,
        error: msg,
      };
    }
  },
};
