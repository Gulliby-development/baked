import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { extractArchive } from "../platform/archive.js";
import { dataDir, EXE, IS_WIN } from "../platform/index.js";

const baked_DIR = dataDir();
const BIN_DIR = join(baked_DIR, "bin");
const INSTALLS_DIR = join(baked_DIR, "installs");
const RG_VERSION = "14.1.1";
const FD_VERSION = "10.2.0";
const AST_GREP_VERSION = "0.40.0";

interface PlatformAsset {
  url: string;
  binPath: string;
}

type PlatformKey = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "win32-x64";

function getPlatformKey(): PlatformKey {
  const key = `${process.platform}-${process.arch}` as PlatformKey;
  if (
    key !== "darwin-arm64" &&
    key !== "darwin-x64" &&
    key !== "linux-x64" &&
    key !== "linux-arm64" &&
    key !== "win32-x64"
  ) {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }
  return key;
}

interface BinaryConfig {
  name: string;
  binName: string;
  version: string;
  getAsset: (key: PlatformKey) => PlatformAsset;
}

async function installBinary(config: BinaryConfig): Promise<string> {
  ensureDirs();
  const key = getPlatformKey();
  const asset = config.getAsset(key);
  const extractDir = join(INSTALLS_DIR, `${config.name}-${config.version}`);

  if (!existsSync(asset.binPath)) {
    await downloadAndExtract(asset.url, extractDir);
  }
  if (!existsSync(asset.binPath)) {
    throw new Error(`${config.name} binary not found after extraction at ${asset.binPath}`);
  }

  // NTFS has no POSIX execute bit; downloaded .exe is already runnable.
  if (!IS_WIN) {
    try {
      chmodSync(asset.binPath, 0o755);
    } catch {}
  }
  createSymlink(asset.binPath, join(BIN_DIR, config.binName + EXE));
  return join(BIN_DIR, config.binName + EXE);
}

const RUST_TRIPLETS: Record<PlatformKey, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const FD_TRIPLETS: Record<PlatformKey, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export function getVendoredPath(binary: "rg" | "fd" | "ast-grep"): string | null {
  const binLink = join(BIN_DIR, binary + EXE);
  return existsSync(binLink) ? binLink : null;
}

function ensureDirs(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  mkdirSync(INSTALLS_DIR, { recursive: true });
}

async function downloadAndExtract(url: string, extractDir: string): Promise<void> {
  mkdirSync(extractDir, { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  }

  const lower = url.toLowerCase();
  const ext = lower.endsWith(".zip") ? ".zip" : ".tar.gz";
  const tmpFile = join(extractDir, `download${ext}`);
  const buffer = await response.arrayBuffer();
  await Bun.write(tmpFile, buffer);

  const result = extractArchive(tmpFile, extractDir);
  if (!result.success) {
    throw new Error(`Extract failed: ${result.error}`);
  }
  unlinkSync(tmpFile);
}

function createSymlink(target: string, link: string): void {
  if (existsSync(link)) {
    unlinkSync(link);
  }
  // Windows: symlinks need Developer Mode or admin token. Copy instead — bin
  // dir lives under %LOCALAPPDATA% (user-writable), and the wasted disk is
  // a few MB per tool.
  if (IS_WIN) {
    const { copyFileSync } = require("node:fs") as typeof import("node:fs");
    copyFileSync(target, link);
    return;
  }
  symlinkSync(target, link);
}

export async function installRipgrep(): Promise<string> {
  return installBinary({
    name: "ripgrep",
    binName: "rg",
    version: RG_VERSION,
    getAsset: (key) => {
      const triplet = RUST_TRIPLETS[key];
      const dirName = `ripgrep-${RG_VERSION}-${triplet}`;
      // Windows ripgrep release ships as a .zip with rg.exe at the top level.
      if (key === "win32-x64") {
        return {
          url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${dirName}.zip`,
          binPath: join(INSTALLS_DIR, `ripgrep-${RG_VERSION}`, dirName, "rg.exe"),
        };
      }
      return {
        url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${dirName}.tar.gz`,
        binPath: join(INSTALLS_DIR, `ripgrep-${RG_VERSION}`, dirName, "rg"),
      };
    },
  });
}

export async function installFd(): Promise<string> {
  return installBinary({
    name: "fd",
    binName: "fd",
    version: FD_VERSION,
    getAsset: (key) => {
      const triplet = FD_TRIPLETS[key];
      const dirName = `fd-v${FD_VERSION}-${triplet}`;
      // Windows fd release ships as a .zip with fd.exe at the top level.
      if (key === "win32-x64") {
        return {
          url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${dirName}.zip`,
          binPath: join(INSTALLS_DIR, `fd-${FD_VERSION}`, dirName, "fd.exe"),
        };
      }
      return {
        url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${dirName}.tar.gz`,
        binPath: join(INSTALLS_DIR, `fd-${FD_VERSION}`, dirName, "fd"),
      };
    },
  });
}

export async function installAstGrep(): Promise<string> {
  return installBinary({
    name: "ast-grep",
    binName: "ast-grep",
    version: AST_GREP_VERSION,
    getAsset: (key) => {
      const map: Record<PlatformKey, string> = {
        "darwin-arm64": "app-aarch64-apple-darwin.zip",
        "darwin-x64": "app-x86_64-apple-darwin.zip",
        "linux-x64": "app-x86_64-unknown-linux-gnu.zip",
        "linux-arm64": "app-aarch64-unknown-linux-gnu.zip",
        "win32-x64": "app-x86_64-pc-windows-msvc.zip",
      };
      const asset = map[key];
      // Archive flattens to `ast-grep` + `sg` at the extract-dir root (no subdir).
      return {
        url: `https://github.com/ast-grep/ast-grep/releases/download/${AST_GREP_VERSION}/${asset}`,
        binPath: join(
          INSTALLS_DIR,
          `ast-grep-${AST_GREP_VERSION}`,
          `ast-grep${IS_WIN ? ".exe" : ""}`,
        ),
      };
    },
  });
}
