//
// Uses Mason's registry.json (576+ packages) as the package source.
// Reads local cache if available, otherwise downloads from GitHub.
// Installs to ~/.baked/lsp-servers/ via bun (npm), curl+tar (github), pip, go, cargo,
// and plain downloads (generic) unpacked into lsp-servers/packages/<name>/.

import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractArchive, tarCommand } from "../../../platform/archive.js";
import {
  CMD_EXT,
  commandExists,
  configDir,
  dataDir,
  EXE,
  IS_WIN,
} from "../../../platform/index.js";

const BAKED_LSP_DIR = join(dataDir(), "lsp-servers");
const VERSIONS_FILE = join(configDir(), "lsp-versions.json");

const MASON_REGISTRY_RELEASE_URL =
  "https://api.github.com/repos/mason-org/mason-registry/releases/latest";
const REGISTRY_CACHE = join(configDir(), "mason-registry.json");
const MASON_BIN_DIR = join(dataDir(), "mason", "bin");

type InstallMethod = "npm" | "pypi" | "cargo" | "golang" | "github" | "generic" | "unknown";
export type PackageCategory = "LSP" | "Formatter" | "Linter" | "DAP" | "Runtime" | "Compiler";

export interface MasonPackage {
  name: string;
  description: string;
  homepage: string;
  licenses: string[];
  languages: string[];
  categories: PackageCategory[];
  source: {
    id: string; // purl: pkg:npm/name@version, pkg:github/owner/repo@tag, etc.
    extra_packages?: string[];
    /** One asset per target, or one asset for every platform (`{ file }`, #2125). */
    asset?: MasonAsset[] | Omit<MasonAsset, "target">;
    /** pkg:generic packages: files to download per target, keyed by local file name. */
    download?: MasonDownload[];
  };
  bin?: Record<string, string>;
  deprecation?: { since: string; message: string };
}

export interface MasonAsset {
  target: string;
  file: string;
  bin?: string;
}

/** A Mason download entry; `target` is one target name or a list of them. */
export interface MasonDownload {
  target: string | string[];
  files: Record<string, string>;
  config?: string;
  bin?: string;
}

export interface PackageStatus {
  pkg: MasonPackage;
  installMethod: InstallMethod;
  installed: boolean;
  source: "PATH" | "baked" | "mason" | null;
  requiresToolchain: string | null; // "cargo", "go", "pip3", null
  toolchainAvailable: boolean;
  binaries: string[];
  installedVersion: string | null;
  registryVersion: string | null;
  hasUpdate: boolean;
}

interface ParsedPurl {
  type: string; // npm, pypi, github, cargo, golang, etc.
  namespace: string; // e.g. "@angular" for scoped npm, "owner" for github
  name: string;
  version: string;
}

function parsePurl(id: string): ParsedPurl | null {
  // pkg:npm/name@version, pkg:npm/%40scope/name@version, pkg:github/owner/repo@tag
  const match = id.match(/^pkg:(\w+)\/(.+?)@(.+)$/);
  if (!match) return null;
  const type = match[1] ?? "";
  const path = match[2] ?? "";
  const version = match[3] ?? "";
  const decoded = decodeURIComponent(path);
  const lastSlash = decoded.lastIndexOf("/");
  if (lastSlash === -1) {
    return { type, namespace: "", name: decoded, version };
  }
  return {
    type,
    namespace: decoded.slice(0, lastSlash),
    name: decoded.slice(lastSlash + 1),
    version,
  };
}

/** Compare versions: returns true if `a` is newer than `b`. Strips leading 'v', compares numeric segments. */
function isNewerVersion(a: string, b: string): boolean {
  const normalize = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const pa = normalize(a);
  const pb = normalize(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false; // equal
}

function getInstallMethod(purl: ParsedPurl): InstallMethod {
  switch (purl.type) {
    case "npm":
      return "npm";
    case "pypi":
      return "pypi";
    case "cargo":
      return "cargo";
    case "golang":
      return "golang";
    case "github":
      return "github";
    case "generic":
      return "generic";
    default:
      return "unknown";
  }
}

const PYTHON_CMD = IS_WIN ? "python" : "python3";

function getToolchainRequirement(method: InstallMethod, pkg: MasonPackage): string | null {
  switch (method) {
    case "generic":
      return Object.values(pkg.bin ?? {}).some((b) => b.startsWith("python:")) ? PYTHON_CMD : null;
    case "cargo":
      return "cargo";
    case "golang":
      return "go";
    case "pypi":
      return "pip3";
    default:
      return null;
  }
}

let registryCache: MasonPackage[] | null = null;

export function loadRegistry(): MasonPackage[] {
  if (registryCache) return registryCache;

  // Use the cached package registry when available.
  if (existsSync(REGISTRY_CACHE)) {
    try {
      const raw = readFileSync(REGISTRY_CACHE, "utf-8");
      registryCache = JSON.parse(raw) as MasonPackage[];
      return registryCache;
    } catch {
      // Fall through
    }
  }

  // 3. No registry available — return empty (download happens async)
  return [];
}

export async function downloadRegistry(signal?: AbortSignal): Promise<MasonPackage[]> {
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  mkdirSync(configDir(), { recursive: true });
  try {
    const releaseResp = await fetch(MASON_REGISTRY_RELEASE_URL, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "baked" },
      signal: requestSignal,
    });
    if (!releaseResp.ok) throw new Error(`GitHub API HTTP ${String(releaseResp.status)}`);
    const release = (await releaseResp.json()) as {
      assets?: Array<{ name: string; browser_download_url: string }>;
    };
    const asset = release.assets?.find((a) => a.name === "registry.json.zip");
    if (!asset) throw new Error("registry.json.zip not found in latest release");

    const zipResp = await fetch(asset.browser_download_url, { signal: requestSignal });
    if (!zipResp.ok) throw new Error(`Download HTTP ${String(zipResp.status)}`);
    const zipBuf = await zipResp.arrayBuffer();

    const tmpZip = join(configDir(), "mason-registry.zip");
    writeFileSync(tmpZip, Buffer.from(zipBuf));

    await new Promise<void>((resolve, reject) => {
      execFile(
        IS_WIN ? tarCommand() : "unzip",
        IS_WIN ? ["-xf", tmpZip, "-C", configDir()] : ["-o", tmpZip, "-d", configDir()],
        { windowsHide: true, timeout: 30_000, signal: requestSignal },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    unlinkSync(tmpZip);

    const jsonPath = join(configDir(), "registry.json");
    const text = readFileSync(jsonPath, "utf-8");
    writeFileSync(REGISTRY_CACHE, text);
    unlinkSync(jsonPath);

    registryCache = JSON.parse(text) as MasonPackage[];
    return registryCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to download Mason registry: ${msg}`);
  }
}

/** Where `/lsp` keeps a package that ships a folder instead of binaries. */
export const bundleFolder = (name: string): string => join(BAKED_LSP_DIR, name);

function getBinaries(pkg: MasonPackage): string[] {
  if (!pkg.bin) return [];
  return Object.keys(pkg.bin);
}

// Cache native PATH lookups. Never spawn a process per registry entry.
const pathCache = new Map<string, boolean>();

function commandOnPath(cmd: string): boolean {
  const cached = pathCache.get(cmd);
  if (cached !== undefined) return cached;
  const ok = Bun.which(cmd) !== null;
  pathCache.set(cmd, ok);
  return ok;
}

function toolchainAvailable(toolchain: string | null): boolean {
  if (!toolchain) return true;
  return commandOnPath(toolchain);
}

/** Clear the PATH cache (call after install) */
export function clearPathCache(): void {
  pathCache.clear();
}

// ── Version tracking ──────────────────────────────────────────────────

type VersionMap = Record<string, { version: string; installedAt: string }>;

let versionCache: VersionMap | null = null;

function loadVersions(): VersionMap {
  if (versionCache) return versionCache;
  try {
    if (existsSync(VERSIONS_FILE)) {
      versionCache = JSON.parse(readFileSync(VERSIONS_FILE, "utf-8")) as VersionMap;
      return versionCache;
    }
  } catch {}
  return {};
}

function saveVersions(map: VersionMap): void {
  versionCache = map;
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(VERSIONS_FILE, JSON.stringify(map, null, 2), "utf-8");
  } catch {}
}

function recordInstalledVersion(pkg: MasonPackage): void {
  const purl = parsePurl(pkg.source.id);
  if (!purl) return;
  const map = loadVersions();
  map[pkg.name] = { version: purl.version, installedAt: new Date().toISOString() };
  saveVersions(map);
}

function removeInstalledVersion(pkg: MasonPackage): void {
  const map = loadVersions();
  delete map[pkg.name];
  saveVersions(map);
}

/** Get the version we recorded at install time (null if unknown) */
export function getInstalledVersion(pkgName: string): string | null {
  return loadVersions()[pkgName]?.version ?? null;
}

/** Get packages that have a newer version in the registry */
export function getUpdatablePackages(): PackageStatus[] {
  const all = getAllPackageStatus();
  return all.filter((s) => s.hasUpdate);
}

export function checkPackageStatus(pkg: MasonPackage): PackageStatus {
  const purl = parsePurl(pkg.source.id);
  const method = purl ? getInstallMethod(purl) : "unknown";
  const toolchain = getToolchainRequirement(method, pkg);
  const binaries = getBinaries(pkg);

  // Windows: a bin shim can be `<bin>.exe`, `<bin>.cmd`, or bare. Probe all.
  const winSuffixes = IS_WIN ? [EXE, CMD_EXT, ""] : [""];
  const probe = (dir: string, bin: string): boolean => {
    for (const sfx of winSuffixes) {
      if (existsSync(join(dir, bin + sfx))) return true;
    }
    return false;
  };

  // Check if any binary is installed
  let installed = false;
  let source: PackageStatus["source"] = null;

  for (const bin of binaries) {
    // PATH (where on win32 already follows PATHEXT)
    if (commandOnPath(bin)) {
      installed = true;
      source = "PATH";
      break;
    }
    // baked npm bin
    if (probe(join(BAKED_LSP_DIR, "node_modules", ".bin"), bin)) {
      installed = true;
      source = "baked";
      break;
    }
    // baked direct bin
    if (probe(join(BAKED_LSP_DIR, "bin"), bin)) {
      installed = true;
      source = "baked";
      break;
    }
    // Mason
    if (probe(MASON_BIN_DIR, bin)) {
      installed = true;
      source = "mason";
      break;
    }
  }

  // A package without binaries is installed when its folder is (lsp-servers or Mason's packages).
  if (binaries.length === 0)
    for (const [folder, from] of [
      [bundleFolder(pkg.name), "baked"],
      [join(MASON_BIN_DIR, "..", "packages", pkg.name), "mason"],
    ] as const)
      if (existsSync(folder) && readdirSync(folder).length > 0) {
        installed = true;
        source = from;
        break;
      }

  const registryVersion = purl?.version ?? null;
  const installedVersion = installed ? getInstalledVersion(pkg.name) : null;
  const hasUpdate =
    installed &&
    installedVersion !== null &&
    registryVersion !== null &&
    isNewerVersion(registryVersion, installedVersion);

  return {
    pkg,
    installMethod: method,
    installed,
    source,
    requiresToolchain: toolchain,
    toolchainAvailable: toolchainAvailable(toolchain),
    binaries,
    installedVersion,
    registryVersion,
    hasUpdate,
  };
}

/** Get status for all packages, optionally filtered by category */
export function getAllPackageStatus(category?: PackageCategory): PackageStatus[] {
  const registry = loadRegistry();
  const filtered = category ? registry.filter((p) => p.categories.includes(category)) : registry;
  return filtered
    .filter((p) => !p.deprecation) // skip deprecated
    .map(checkPackageStatus);
}

/** Yield between batches so the terminal can render and handle Escape. */
export async function getAllPackageStatusAsync(signal?: AbortSignal): Promise<PackageStatus[]> {
  const statuses: PackageStatus[] = [];
  const registry = loadRegistry().filter((pkg) => !pkg.deprecation);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  let batchStarted = performance.now();
  for (const pkg of registry) {
    signal?.throwIfAborted();
    statuses.push(checkPackageStatus(pkg));
    if (performance.now() - batchStarted >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      batchStarted = performance.now();
    }
  }
  signal?.throwIfAborted();
  return statuses;
}

/** File patterns that suggest which languages a project uses */
const PROJECT_INDICATORS: Record<string, string[]> = {
  TypeScript: ["tsconfig.json", "*.ts", "*.tsx"],
  JavaScript: ["package.json", "*.js", "*.jsx"],
  Python: ["pyproject.toml", "setup.py", "requirements.txt", "*.py"],
  Go: ["go.mod", "*.go"],
  Rust: ["Cargo.toml", "*.rs"],
  Lua: ["*.lua", "*.luau", ".luacheckrc"],
  C: ["*.c", "*.h", "CMakeLists.txt", "Makefile"],
  "C++": ["*.cpp", "*.hpp", "*.cc", "CMakeLists.txt"],
  Ruby: ["Gemfile", "*.rb"],
  PHP: ["composer.json", "*.php"],
  Zig: ["build.zig", "*.zig"],
  Bash: ["*.sh", "*.bash"],
  CSS: ["*.css", "*.scss", "*.less"],
  HTML: ["*.html", "*.htm"],
  JSON: ["*.json"],
  YAML: ["*.yaml", "*.yml"],
  Dockerfile: ["Dockerfile", "docker-compose.yml"],
  Java: ["pom.xml", "build.gradle", "*.java"],
  Kotlin: ["*.kt", "build.gradle.kts"],
  Swift: ["Package.swift", "*.swift"],
  Dart: ["pubspec.yaml", "*.dart"],
  SQL: ["*.sql", ".sqlfluff", "dbt_project.yml"],
  PowerShell: ["*.ps1", "*.psm1", "*.psd1"],
};

/** Detect which languages are used in the current project */
function detectProjectLanguages(cwd: string): string[] {
  const languages: string[] = [];
  const { readdirSync } = require("node:fs") as typeof import("node:fs");

  let files: string[];
  try {
    files = readdirSync(cwd);
  } catch {
    return [];
  }

  for (const [lang, patterns] of Object.entries(PROJECT_INDICATORS)) {
    for (const pattern of patterns) {
      if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1);
        if (files.some((f) => f.endsWith(ext))) {
          languages.push(lang);
          break;
        }
      } else if (files.includes(pattern)) {
        languages.push(lang);
        break;
      }
    }
  }
  return languages;
}

/** Get packages relevant to the current project */
export function getRecommendedPackages(cwd: string, statuses?: PackageStatus[]): PackageStatus[] {
  const langs = detectProjectLanguages(cwd);
  if (langs.length === 0) return [];

  const langSet = new Set(langs.map((l) => l.toLowerCase()));
  if (statuses) {
    return statuses.filter((s) => s.pkg.languages.some((l) => langSet.has(l.toLowerCase())));
  }
  const registry = loadRegistry();

  return registry
    .filter((p) => {
      if (p.deprecation) return false;
      return p.languages.some((l) => langSet.has(l.toLowerCase()));
    })
    .map(checkPackageStatus);
}

/** Install a package to ~/.baked/lsp-servers/ */
export async function installPackage(
  pkg: MasonPackage,
  onProgress?: (msg: string) => void,
): Promise<{ success: boolean; error?: string }> {
  const purl = parsePurl(pkg.source.id);
  if (!purl) return { success: false, error: "Cannot parse package source" };

  mkdirSync(BAKED_LSP_DIR, { recursive: true });
  const log = (msg: string) => onProgress?.(msg);

  try {
    switch (purl.type) {
      case "npm": {
        const fullName = purl.namespace
          ? `${purl.namespace}/${purl.name}@${purl.version}`
          : `${purl.name}@${purl.version}`;
        const extras = pkg.source.extra_packages ?? [];
        log(`Installing ${fullName} via bun...`);
        const bunBin = (() => {
          if (commandExists("bun")) return "bun";
          const sfBin = join(dataDir(), "bin", `bun${EXE}`);
          if (existsSync(sfBin)) return sfBin;
          return "bun";
        })();
        await runCommand(bunBin, ["add", "--cwd", BAKED_LSP_DIR, fullName, ...extras], log, {
          BUN_BE_BUN: "1",
        });
        break;
      }

      case "pypi": {
        log(`Installing ${purl.name} via pip3...`);
        const binDir = join(BAKED_LSP_DIR, "bin");
        const pipDir = join(BAKED_LSP_DIR, "pip-packages");
        mkdirSync(binDir, { recursive: true });
        mkdirSync(pipDir, { recursive: true });
        await runCommand(
          "pip3",
          ["install", "--target", pipDir, `${purl.name}==${purl.version}`],
          log,
        );
        // Create wrapper scripts for each binary. Windows gets a .cmd shim
        // that sets PYTHONPATH and invokes `python -m <pkg>`; POSIX gets a
        // bash wrapper.
        if (pkg.bin) {
          const moduleName = purl.name.replace(/-/g, "_");
          for (const binName of Object.keys(pkg.bin)) {
            if (IS_WIN) {
              const wrapper = join(binDir, binName + CMD_EXT);
              writeFileSync(
                wrapper,
                `@echo off\r\nset "PYTHONPATH=${pipDir};%PYTHONPATH%"\r\npython -m ${moduleName} %*\r\n`,
              );
            } else {
              const wrapper = join(binDir, binName);
              writeFileSync(
                wrapper,
                `#!/usr/bin/env bash\nPYTHONPATH="${pipDir}:$PYTHONPATH" exec python3 -m ${moduleName} "$@"\n`,
              );
              chmodSync(wrapper, 0o755);
            }
          }
        }
        break;
      }

      case "golang": {
        log(`Installing ${purl.namespace}/${purl.name} via go install...`);
        const binDir = join(BAKED_LSP_DIR, "bin");
        mkdirSync(binDir, { recursive: true });
        const fullPkg = `${purl.namespace}/${purl.name}@${purl.version}`;
        await runCommand("go", ["install", fullPkg], log, { GOBIN: binDir });
        break;
      }

      case "cargo": {
        log(`Installing ${purl.name} via cargo...`);
        mkdirSync(join(BAKED_LSP_DIR, "bin"), { recursive: true });
        await runCommand(
          "cargo",
          ["install", purl.name, "--version", purl.version, "--root", BAKED_LSP_DIR],
          log,
        );
        break;
      }

      case "github": {
        log(`Downloading ${purl.namespace}/${purl.name} from GitHub...`);
        const binDir = join(BAKED_LSP_DIR, "bin");
        mkdirSync(binDir, { recursive: true });

        // Find the right asset for this platform
        const asset = findPlatformAsset(pkg);
        if (!asset) {
          const target = getMasonTarget();
          return {
            success: false,
            error:
              `No pre-built binary for ${target} (${process.platform}/${process.arch}). ` +
              `This package may not publish an asset for your platform — try installing via ` +
              `\`bun add -g <pkg>\` instead.`,
          };
        }

        const version = purl.version;
        const fileUrl = `https://github.com/${purl.namespace}/${purl.name}/releases/download/${version}/${resolveAssetTemplate(asset.file, version)}`;
        const tmpDir = join(BAKED_LSP_DIR, ".tmp");
        mkdirSync(tmpDir, { recursive: true });

        log(`Downloading ${fileUrl}...`);
        await runCommand("curl", ["-fSL", "-o", join(tmpDir, "download"), fileUrl], log);

        // Extract — tar.exe on Win10 1809+ handles .tar.gz, .tar.xz, .zip via libarchive.
        const downloadPath = join(tmpDir, "download");
        // Rename to a name extractArchive can dispatch on (ext-based).
        const lower = asset.file.toLowerCase();
        let archivePath = downloadPath;
        if (
          lower.endsWith(".tar.gz") ||
          lower.endsWith(".tgz") ||
          lower.endsWith(".tar.xz") ||
          lower.endsWith(".zip")
        ) {
          const { safeRename } = await import("../../../platform/index.js");
          const ext = lower.endsWith(".tgz")
            ? ".tar.gz"
            : lower.endsWith(".tar.gz")
              ? ".tar.gz"
              : lower.endsWith(".tar.xz")
                ? ".tar.xz"
                : ".zip";
          archivePath = join(tmpDir, `download${ext}`);
          try {
            safeRename(downloadPath, archivePath);
          } catch {}
          const result = extractArchive(archivePath, tmpDir);
          if (!result.success) throw new Error(`Extract failed: ${result.error}`);
        }

        // Copy binaries. Windows: try .exe / .cmd suffixes when bare name misses.
        if (pkg.bin) {
          for (const [binName, binPath] of Object.entries(pkg.bin)) {
            const resolvedBin = binPath.includes("{{") ? (asset.bin ?? binName) : binPath;
            const winExts = IS_WIN ? [EXE, CMD_EXT, ""] : [""];
            const baseCandidates = [
              resolvedBin,
              binName,
              join(purl.name, resolvedBin),
              join(purl.name, binName),
            ];
            const candidates: string[] = [];
            for (const c of baseCandidates) {
              for (const ext of winExts) {
                candidates.push(join(tmpDir, c + ext));
              }
            }
            for (const candidate of candidates) {
              if (existsSync(candidate)) {
                const { copyFileSync } = await import("node:fs");
                // Preserve the source extension so callers resolve `foo.exe`
                // not `foo` on Windows.
                const srcExt = candidate.endsWith(".exe")
                  ? ".exe"
                  : candidate.endsWith(".cmd")
                    ? ".cmd"
                    : "";
                const dest = join(binDir, binName + (IS_WIN ? srcExt : ""));
                copyFileSync(candidate, dest);
                if (!IS_WIN) chmodSync(dest, 0o755);
                break;
              }
            }
          }
        }

        // A package without binaries is a folder its runtime starts (PowerShell Editor Services):
        // the extracted tree is kept whole in lsp-servers/NAME (#2125).
        if (getBinaries(pkg).length === 0) {
          const folder = bundleFolder(pkg.name);
          rmSync(folder, { recursive: true, force: true });
          for (const name of ["download", "download.tar.gz", "download.tar.xz", "download.zip"])
            rmSync(join(tmpDir, name), { force: true });
          renameSync(tmpDir, folder);
        }

        // Clean up
        rmSync(tmpDir, { recursive: true, force: true });
        break;
      }

      case "generic": {
        const error = await installGeneric(pkg, purl.version, log);
        if (error) return { success: false, error };
        break;
      }

      default:
        return { success: false, error: `Unsupported install method: ${purl.type}` };
    }

    log(`✓ ${pkg.name} installed`);
    recordInstalledVersion(pkg);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ Failed: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function uninstallPackage(
  pkg: MasonPackage,
  onProgress?: (msg: string) => void,
): Promise<{ success: boolean; error?: string }> {
  const purl = parsePurl(pkg.source.id);
  if (!purl) return { success: false, error: "Cannot parse package source" };

  const log = (msg: string) => onProgress?.(msg);
  const binaries = getBinaries(pkg);

  const { unlinkSync } = await import("node:fs");
  // On Windows we may have copied either `<bin>.exe` or `<bin>.cmd` (or both)
  // depending on the source asset shape. Try every suffix on uninstall.
  const removeBin = (dir: string, bin: string) => {
    const suffixes = IS_WIN ? [EXE, CMD_EXT, ""] : [""];
    for (const sfx of suffixes) {
      try {
        unlinkSync(join(dir, bin + sfx));
      } catch {}
    }
  };

  try {
    switch (purl.type) {
      case "npm": {
        const fullName = purl.namespace ? `${purl.namespace}/${purl.name}` : purl.name;
        log(`Removing ${fullName} via bun...`);
        const { spawnSync } = await import("node:child_process");
        const bunBin = (() => {
          if (commandExists("bun")) return "bun";
          const sfBin = join(dataDir(), "bin", `bun${EXE}`);
          if (existsSync(sfBin)) return sfBin;
          return "bun";
        })();
        const removeResult = spawnSync(bunBin, ["remove", "--cwd", BAKED_LSP_DIR, fullName], {
          stdio: "pipe",
          windowsHide: true,
        });
        if (removeResult.status !== 0) {
          for (const bin of binaries) {
            removeBin(join(BAKED_LSP_DIR, "node_modules", ".bin"), bin);
          }
        }
        break;
      }

      case "pypi": {
        log(`Removing ${purl.name}...`);
        const { rmSync } = await import("node:fs");
        const pipDir = join(BAKED_LSP_DIR, "pip-packages");
        const pkgDir = join(pipDir, purl.name.replace(/-/g, "_"));
        try {
          rmSync(pkgDir, { recursive: true, force: true });
        } catch {}
        for (const bin of binaries) {
          removeBin(join(BAKED_LSP_DIR, "bin"), bin);
        }
        break;
      }

      case "golang":
      case "cargo": {
        log(`Removing ${purl.name} binaries...`);
        for (const bin of binaries) {
          removeBin(join(BAKED_LSP_DIR, "bin"), bin);
        }
        break;
      }

      case "github": {
        log(`Removing ${purl.name} binaries...`);
        for (const bin of binaries) {
          removeBin(join(BAKED_LSP_DIR, "bin"), bin);
        }
        if (binaries.length === 0) rmSync(bundleFolder(pkg.name), { recursive: true, force: true });
        break;
      }

      case "generic": {
        log(`Removing ${pkg.name}...`);
        for (const bin of binaries) {
          removeBin(join(BAKED_LSP_DIR, "bin"), bin);
        }
        const pkgDir = genericPackageDir(pkg.name);
        if (pkgDir) rmSync(pkgDir, { recursive: true, force: true });
        break;
      }

      default:
        return { success: false, error: `Unsupported install method: ${purl.type}` };
    }

    log(`✓ ${pkg.name} uninstalled`);
    removeInstalledVersion(pkg);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`✗ Failed: ${msg}`);
    return { success: false, error: msg };
  }
}

/** Update a package: uninstall then reinstall at the registry version */
export async function updatePackage(
  pkg: MasonPackage,
  onProgress?: (msg: string) => void,
): Promise<{ success: boolean; error?: string }> {
  const status = checkPackageStatus(pkg);
  if (!status.installed) {
    return installPackage(pkg, onProgress);
  }
  const log = (msg: string) => onProgress?.(msg);
  const old = status.installedVersion ?? "unknown";
  const next = status.registryVersion ?? "latest";
  log(`Updating ${pkg.name} ${old} → ${next}...`);

  // Only uninstall baked-managed packages; PATH/mason ones just get overwritten
  if (status.source === "baked") {
    const rm = await uninstallPackage(pkg, onProgress);
    if (!rm.success) return rm;
  }
  return installPackage(pkg, onProgress);
}

function getMasonTarget(): string {
  // Mason registry target keys: darwin_arm64, darwin_x64, linux_arm64,
  // linux_x64, win_x64. (win_arm64 deferred to v2 — see windows-support.md.)
  if (IS_WIN) {
    return process.arch === "arm64" ? "win_arm64" : "win_x64";
  }
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}_${arch}`;
}

export function findPlatformAsset(pkg: MasonPackage): Omit<MasonAsset, "target"> | null {
  if (!pkg.source.asset) return null;
  // A single asset with no target is the same file on every platform (a PowerShell bundle).
  if (!Array.isArray(pkg.source.asset)) return pkg.source.asset;
  const target = getMasonTarget();

  // Try exact match first
  let match = pkg.source.asset.find((a) => a.target === target);
  if (match) return match;

  // Try with _gnu suffix (common for linux)
  match = pkg.source.asset.find((a) => a.target === `${target}_gnu`);
  if (match) return match;

  // Try without _gnu for darwin
  if (target.startsWith("darwin")) {
    match = pkg.source.asset.find(
      (a) =>
        a.target.startsWith("darwin") &&
        a.target.includes(process.arch === "arm64" ? "arm64" : "x64"),
    );
    if (match) return match;
  }

  return null;
}

/**
 * Mason target names that match a platform and architecture: `unix`, `linux`,
 * `linux_x64` and `linux_x64_gnu` on x64 Linux; `win` and `win_x64` on Windows.
 */
export function masonTargetsFor(platform: NodeJS.Platform, arch: string): string[] {
  const os = platform === "win32" ? "win" : platform === "darwin" ? "darwin" : "linux";
  const masonArch =
    arch === "arm64" ? "arm64" : arch === "ia32" ? "x86" : arch === "arm" ? "arm" : "x64";
  const targets = os === "win" ? [os] : ["unix", os];
  targets.push(`${os}_${masonArch}`);
  if (os === "linux") targets.push(`${os}_${masonArch}_gnu`);
  return targets;
}

/** The first download entry whose target matches the platform, as Mason picks it. */
export function findPlatformDownload(
  downloads: MasonDownload[] | undefined,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): MasonDownload | null {
  if (!downloads) return null;
  const accepted = new Set(masonTargetsFor(platform, arch));
  return (
    downloads.find((d) =>
      (Array.isArray(d.target) ? d.target : [d.target]).some((t) => accepted.has(t)),
    ) ?? null
  );
}

const ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".tar.xz", ".txz", ".zip"];

function archiveSuffix(name: string): string | null {
  const lower = name.toLowerCase();
  return ARCHIVE_SUFFIXES.find((s) => lower.endsWith(s)) ?? null;
}

/** `<lsp-servers>/packages/<name>`, or null when the name could escape that directory. */
function genericPackageDir(name: string): string | null {
  if (!/^[\w@.+-]+$/.test(name) || name === "." || name === "..") return null;
  return join(BAKED_LSP_DIR, "packages", name);
}

/** Resolve a registry-supplied relative path inside `root`; null when it points outside. */
function insideDir(root: string, rel: string): string | null {
  const full = resolve(root, rel);
  const fromRoot = relative(root, full);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return null;
  return full;
}

type GenericBin = { kind: "python" | "exec"; path: string };

/** Parse a Mason `bin` value of a generic package: `python:REL`, `exec:REL` or plain `REL`. */
export function parseGenericBin(value: string): GenericBin | { error: string } {
  if (value.includes("{{")) return { error: `templated bin "${value}" is not supported` };
  const prefixed = value.match(/^([a-z][a-z0-9-]*):(.+)$/);
  if (!prefixed) return { kind: "exec", path: value };
  const [, prefix = "", path = ""] = prefixed;
  if (prefix === "python") return { kind: "python", path };
  if (prefix === "exec") return { kind: "exec", path };
  return { error: `bin prefix "${prefix}:" is not supported (in "${value}")` };
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeLauncher(binDir: string, binName: string, bin: GenericBin, target: string): void {
  if (IS_WIN) {
    const command = bin.kind === "python" ? `${PYTHON_CMD} "${target}"` : `"${target}"`;
    writeFileSync(join(binDir, binName + CMD_EXT), `@echo off\r\n${command} %*\r\n`);
    return;
  }
  if (bin.kind === "exec") chmodSync(target, 0o755);
  // Exec the file by its real path so scripts can find files relative to themselves.
  const command = bin.kind === "python" ? `${PYTHON_CMD} ${shQuote(target)}` : shQuote(target);
  const launcher = join(binDir, binName);
  writeFileSync(launcher, `#!/bin/sh\nexec ${command} "$@"\n`);
  chmodSync(launcher, 0o755);
}

/** Install a pkg:generic package. Returns an error message, or null on success. */
async function installGeneric(
  pkg: MasonPackage,
  version: string,
  log: (msg: string) => void,
): Promise<string | null> {
  const pkgDir = genericPackageDir(pkg.name);
  if (!pkgDir) return `Invalid package name: ${pkg.name}`;
  const download = findPlatformDownload(pkg.source.download);
  if (!download) {
    return `No download of ${pkg.name} for ${process.platform}/${process.arch}`;
  }

  // Validate every bin before touching the disk so an unsupported package fails cleanly.
  const bins: [string, GenericBin][] = [];
  for (const [binName, value] of Object.entries(pkg.bin ?? {})) {
    const parsed = parseGenericBin(value);
    if ("error" in parsed) return `Cannot install ${pkg.name}: ${parsed.error}`;
    bins.push([binName, parsed]);
  }

  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(pkgDir, { recursive: true });
  for (const [fileName, urlTemplate] of Object.entries(download.files)) {
    const url = resolveAssetTemplate(urlTemplate, version);
    // A key ending in "/" names a directory the archive unpacks into.
    const intoDir = fileName.endsWith("/");
    const dest = insideDir(pkgDir, intoDir ? fileName.slice(0, -1) : fileName);
    if (!dest) throw new Error(`Refusing to write outside the package directory: ${fileName}`);
    log(`Downloading ${url}...`);
    const resp = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    if (!resp.ok) throw new Error(`Download of ${url} failed: HTTP ${String(resp.status)}`);
    const body = Buffer.from(await resp.arrayBuffer());
    const suffix = archiveSuffix(intoDir ? (url.split(/[?#]/)[0] ?? "") : fileName);
    if (suffix) {
      // Unpack in place so the archive's own layout (bin/, plugins/, config_*/) is kept.
      const extractTo = intoDir ? dest : dirname(dest);
      mkdirSync(extractTo, { recursive: true });
      const archivePath = join(pkgDir, `.download${suffix}`);
      writeFileSync(archivePath, body);
      const result = extractArchive(archivePath, extractTo);
      unlinkSync(archivePath);
      if (!result.success) throw new Error(`Extract of ${fileName} failed: ${result.error}`);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body);
    }
  }

  const binDir = join(BAKED_LSP_DIR, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const [binName, bin] of bins) {
    const target = insideDir(pkgDir, bin.path);
    if (!target) throw new Error(`Bin ${binName} points outside the package: ${bin.path}`);
    if (!existsSync(target)) throw new Error(`Bin ${binName} not found in package: ${bin.path}`);
    writeLauncher(binDir, binName, bin, target);
  }
  return null;
}

/** Render Mason's `{{ version }}` and `{{ version | strip_prefix "v" }}` templates. */
export function resolveAssetTemplate(template: string, version: string): string {
  return template
    .replace(/\{\{\s*version\s*\}\}/g, version)
    .replace(/\{\{\s*version\s*\|\s*strip_prefix\s*"v"\s*\}\}/g, version.replace(/^v/, ""));
}

function runCommand(
  cmd: string,
  args: string[],
  log: (msg: string) => void,
  extraEnv?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });

    let stderr = "";
    proc.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log(line);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${cmd} exited with code ${String(code)}: ${stderr.slice(0, 500).trim()}`),
        );
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run ${cmd}: ${err.message}`));
    });
  });
}
