/**
 * Registry facts about a package for the dependency check (#640): whether it exists, when it was
 * first published, and its weekly downloads where the registry reports them. Lookups read public
 * metadata only and time out quickly; a failed lookup is `unknown`, never a verdict.
 */
import type { Ecosystem } from "./manifests.js";

export interface PackageFacts {
  status: "exists" | "missing" | "unknown";
  /** First publication, ISO 8601, when the registry says. */
  created?: string;
  /** Downloads in the last week (npm) or overall (crates.io), when the registry says. */
  downloads?: number;
  /** Why the lookup failed, for `unknown`. */
  reason?: string;
}

/** A fetch without credentials; tests pass their own. */
export type RegistryFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const TIMEOUT_MS = 8000;
const HEADERS = {
  "user-agent": "baked-dependency-check (https://github.com/Gulliby-development/baked)",
  accept: "application/json",
};

async function getJson(
  fetcher: RegistryFetch,
  url: string,
): Promise<{ status: number; body: unknown }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetcher(url, { signal, headers: HEADERS });
  if (response.status !== 200) return { status: response.status, body: null };
  return { status: 200, body: await response.json() };
}

/** Go module paths escape upper-case letters as `!` plus the lower-case letter. */
const goEscape = (module: string) => module.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

async function lookup(
  fetcher: RegistryFetch,
  ecosystem: Ecosystem,
  name: string,
): Promise<PackageFacts> {
  const missing = (status: number) =>
    status === 404 || status === 410 ? { status: "missing" as const } : null;
  switch (ecosystem) {
    case "rubygems": {
      const meta = await getJson(
        fetcher,
        `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`,
      );
      const gone = missing(meta.status);
      if (gone) return gone;
      if (meta.status !== 200)
        return { status: "unknown", reason: `registry answered ${meta.status}` };
      return { status: "exists" };
    }
    case "packagist": {
      // Packagist's metadata mirror answers 404 for a package that does not exist.
      const meta = await getJson(fetcher, `https://repo.packagist.org/p2/${name}.json`);
      const gone = missing(meta.status);
      if (gone) return gone;
      if (meta.status !== 200)
        return { status: "unknown", reason: `registry answered ${meta.status}` };
      return { status: "exists" };
    }
    case "npm": {
      const meta = await getJson(fetcher, `https://registry.npmjs.org/${name.replace("/", "%2F")}`);
      const gone = missing(meta.status);
      if (gone) return gone;
      if (meta.status !== 200)
        return { status: "unknown", reason: `registry answered ${meta.status}` };
      const created = (meta.body as { time?: { created?: string } }).time?.created;
      const downloads = await getJson(
        fetcher,
        `https://api.npmjs.org/downloads/point/last-week/${name}`,
      ).then(
        (r) => (r.status === 200 ? (r.body as { downloads?: number }).downloads : undefined),
        () => undefined,
      );
      return {
        status: "exists",
        ...(created ? { created } : {}),
        ...(downloads !== undefined ? { downloads } : {}),
      };
    }
    case "pypi": {
      const meta = await getJson(fetcher, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
      const gone = missing(meta.status);
      if (gone) return gone;
      if (meta.status !== 200)
        return { status: "unknown", reason: `registry answered ${meta.status}` };
      const releases =
        (meta.body as { releases?: Record<string, { upload_time_iso_8601?: string }[]> })
          .releases ?? {};
      const times = Object.values(releases)
        .flat()
        .map((file) => file.upload_time_iso_8601)
        .filter((t): t is string => Boolean(t))
        .sort();
      return { status: "exists", ...(times[0] ? { created: times[0] } : {}) };
    }
    case "crates": {
      const meta = await getJson(
        fetcher,
        `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
      );
      const gone = missing(meta.status);
      if (gone) return gone;
      if (meta.status !== 200)
        return { status: "unknown", reason: `registry answered ${meta.status}` };
      const crate =
        (meta.body as { crate?: { created_at?: string; downloads?: number } }).crate ?? {};
      return {
        status: "exists",
        ...(crate.created_at ? { created: crate.created_at } : {}),
        ...(crate.downloads !== undefined ? { downloads: crate.downloads } : {}),
      };
    }
    case "go": {
      const meta = await getJson(fetcher, `https://proxy.golang.org/${goEscape(name)}/@latest`);
      const gone = missing(meta.status);
      if (gone) return gone;
      if (meta.status !== 200)
        return { status: "unknown", reason: `module proxy answered ${meta.status}` };
      return { status: "exists" };
    }
    case "nuget": {
      const meta = await getJson(
        fetcher,
        `https://api.nuget.org/v3-flatcontainer/${name.toLowerCase()}/index.json`,
      );
      const gone = missing(meta.status);
      if (gone) return gone;
      if (meta.status !== 200)
        return { status: "unknown", reason: `registry answered ${meta.status}` };
      return { status: "exists" };
    }
    case "maven": {
      const [group, artifact] = name.split(":");
      const meta = await getJson(
        fetcher,
        `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(`g:"${group}" AND a:"${artifact}"`)}&rows=1&wt=json`,
      );
      if (meta.status !== 200)
        return { status: "unknown", reason: `search answered ${meta.status}` };
      const found = (meta.body as { response?: { numFound?: number } }).response?.numFound ?? 0;
      return found > 0 ? { status: "exists" } : { status: "missing" };
    }
  }
}

/** Looks a package up, turning network errors and timeouts into `unknown`. */
export async function packageFacts(
  fetcher: RegistryFetch,
  ecosystem: Ecosystem,
  name: string,
): Promise<PackageFacts> {
  try {
    return await lookup(fetcher, ecosystem, name);
  } catch (error) {
    return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- Typosquats --------------------------------------------------------------------------------

/** Widely used packages per ecosystem: a new name one or two edits away from one is suspicious. */
const POPULAR: Record<Ecosystem, readonly string[]> = {
  npm: [
    "react",
    "react-dom",
    "lodash",
    "express",
    "axios",
    "chalk",
    "commander",
    "debug",
    "moment",
    "dayjs",
    "uuid",
    "zod",
    "yargs",
    "typescript",
    "webpack",
    "vite",
    "eslint",
    "prettier",
    "jest",
    "vitest",
    "mocha",
    "chai",
    "dotenv",
    "cors",
    "body-parser",
    "jsonwebtoken",
    "bcrypt",
    "mongoose",
    "redis",
    "pg",
    "mysql2",
    "sqlite3",
    "prisma",
    "next",
    "vue",
    "svelte",
    "rxjs",
    "tslib",
    "core-js",
    "classnames",
    "node-fetch",
    "cross-env",
    "rimraf",
    "glob",
    "minimist",
    "semver",
    "ws",
    "socket.io",
    "inquirer",
    "ora",
    "colors",
    "underscore",
    "jquery",
    "bluebird",
    "async",
    "request",
    "fs-extra",
    "nodemon",
    "ts-node",
    "tsx",
    "esbuild",
    "rollup",
    "babel-core",
    "@babel/core",
    "date-fns",
    "immer",
    "redux",
    "zustand",
    "graphql",
    "openai",
    "@anthropic-ai/sdk",
    "ai",
    "hono",
    "fastify",
    "koa",
    "nanoid",
    "sharp",
    "puppeteer",
    "playwright",
    "cheerio",
    "marked",
    "yaml",
    "js-yaml",
  ],
  pypi: [
    "requests",
    "numpy",
    "pandas",
    "scipy",
    "matplotlib",
    "django",
    "flask",
    "fastapi",
    "pydantic",
    "sqlalchemy",
    "pytest",
    "click",
    "typer",
    "rich",
    "httpx",
    "aiohttp",
    "urllib3",
    "boto3",
    "botocore",
    "setuptools",
    "wheel",
    "pip",
    "six",
    "python-dateutil",
    "pytz",
    "pyyaml",
    "jinja2",
    "markupsafe",
    "certifi",
    "idna",
    "charset-normalizer",
    "cryptography",
    "pillow",
    "scikit-learn",
    "tensorflow",
    "torch",
    "transformers",
    "openai",
    "anthropic",
    "beautifulsoup4",
    "lxml",
    "selenium",
    "celery",
    "redis",
    "psycopg2",
    "pymongo",
    "uvicorn",
    "gunicorn",
    "black",
    "ruff",
    "mypy",
    "colorama",
    "tqdm",
    "attrs",
    "toml",
    "tomli",
    "packaging",
    "pyparsing",
    "hypothesis",
  ],
  crates: [
    "serde",
    "serde_json",
    "tokio",
    "clap",
    "anyhow",
    "thiserror",
    "rand",
    "regex",
    "log",
    "env_logger",
    "tracing",
    "reqwest",
    "hyper",
    "axum",
    "actix-web",
    "chrono",
    "time",
    "uuid",
    "itertools",
    "rayon",
    "once_cell",
    "lazy_static",
    "futures",
    "async-trait",
    "bytes",
    "url",
    "base64",
    "sha2",
    "toml",
    "serde_yaml",
    "sqlx",
    "diesel",
    "proptest",
    "criterion",
    "tempfile",
    "walkdir",
    "glob",
  ],
  go: [],
  nuget: [
    "Newtonsoft.Json",
    "Serilog",
    "AutoMapper",
    "Dapper",
    "Moq",
    "xunit",
    "NUnit",
    "FluentAssertions",
    "Polly",
  ],
  maven: [],
  rubygems: [],
  packagist: [
    "laravel/framework",
    "symfony/console",
    "guzzlehttp/guzzle",
    "monolog/monolog",
    "phpunit/phpunit",
    "phpstan/phpstan",
    "nesbot/carbon",
    "doctrine/orm",
    "league/flysystem",
    "vlucas/phpdotenv",
  ],
};

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return row[b.length] ?? 0;
}

/** The popular package a name is one or two edits away from, or null. */
export function typosquatOf(ecosystem: Ecosystem, name: string): string | null {
  const lower = name.toLowerCase();
  const popular = POPULAR[ecosystem];
  if (popular.some((p) => p.toLowerCase() === lower)) return null;
  for (const candidate of popular) {
    const target = candidate.toLowerCase();
    const limit = Math.min(target.length, lower.length) <= 5 ? 1 : 2;
    if (lower.length >= 4 && distance(lower, target) <= limit) return candidate;
    // Separators swapped or dropped: python-dateutil vs pythondateutil.
    if (lower.replace(/[-_.]/g, "") === target.replace(/[-_.]/g, "")) return candidate;
  }
  return null;
}
