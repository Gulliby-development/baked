import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { CMD_EXT, commandExists, EXE, IS_WIN, masonBinDir } from "../platform/index.js";
import { getVendoredPath } from "./install.js";

interface Prerequisite {
  name: string;
  description: string;
  required: boolean;
  check: () => boolean;
  install: Record<string, string[]>;
  /** If set, only show this prerequisite on these platforms */
  platforms?: string[];
}

const MASON_BIN = masonBinDir();

function lspExists(...cmds: string[]): boolean {
  for (const cmd of cmds) {
    if (commandExists(cmd)) return true;
    // Bare name
    if (existsSync(join(MASON_BIN, cmd))) return true;
    // Windows: Mason installs .cmd shims pointing at the real .exe / interpreter.
    if (IS_WIN) {
      if (existsSync(join(MASON_BIN, cmd + CMD_EXT))) return true;
      if (existsSync(join(MASON_BIN, cmd + EXE))) return true;
    }
  }
  return false;
}

const PREREQUISITES: Prerequisite[] = [
  {
    name: "Git",
    description: "Version control (required)",
    required: true,
    check: () => commandExists("git"),
    install: {
      darwin: ["brew install git"],
      linux: ["sudo apt install git"],
      win32: ["winget install Git.Git"],
    },
  },
  {
    name: "ripgrep",
    description: "Fast code search (used by /grep)",
    required: false,
    check: () => getVendoredPath("rg") !== null || commandExists("rg"),
    install: {
      darwin: ["brew install ripgrep"],
      linux: ["sudo apt install ripgrep"],
      win32: ["scoop install ripgrep"],
    },
  },
  {
    name: "fd",
    description: "Fast file finder (used by /glob, fallback: find)",
    required: false,
    check: () => getVendoredPath("fd") !== null || commandExists("fd") || commandExists("fdfind"),
    install: {
      darwin: ["brew install fd"],
      linux: [
        "sudo apt install fd-find && sudo ln -sf $(which fdfind) /usr/local/bin/fd",
        "# or Arch: sudo pacman -S fd",
      ],
      win32: ["scoop install fd"],
    },
  },
  {
    name: "clipboard",
    description: "Clipboard support (wl-clipboard for Wayland, xclip/xsel for X11)",
    required: false,
    platforms: ["linux"],
    check: () => commandExists("wl-copy") || commandExists("xclip") || commandExists("xsel"),
    install: {
      linux: [
        "# Wayland (KDE/GNOME):",
        "sudo apt install wl-clipboard",
        "# or Arch: sudo pacman -S wl-clipboard",
        "# or Fedora: sudo dnf install wl-clipboard",
        "# X11 fallback:",
        "sudo apt install xclip",
      ],
    },
  },
  {
    name: "secret-tool",
    description: "Secure API key storage (keychain)",
    required: false,
    platforms: ["linux"],
    check: () => commandExists("secret-tool"),
    install: {
      linux: [
        "sudo apt install libsecret-tools",
        "# or Arch: sudo pacman -S libsecret",
        "# or Fedora: sudo dnf install libsecret",
      ],
    },
  },
  {
    name: "typescript-language-server",
    description: "LSP for TypeScript/JavaScript",
    required: false,
    check: () => lspExists("typescript-language-server"),
    install: {
      darwin: ["bun add -g typescript-language-server typescript"],
      linux: ["bun add -g typescript-language-server typescript"],
      win32: ["bun add -g typescript-language-server typescript"],
    },
  },
  {
    name: "pyright",
    description: "LSP for Python",
    required: false,
    check: () => lspExists("pyright-langserver", "pylsp"),
    install: {
      darwin: ["bun add -g pyright"],
      linux: ["bun add -g pyright"],
      win32: ["bun add -g pyright"],
    },
  },
  {
    name: "gopls",
    description: "LSP for Go",
    required: false,
    check: () => lspExists("gopls"),
    install: {
      darwin: ["go install golang.org/x/tools/gopls@latest"],
      linux: ["go install golang.org/x/tools/gopls@latest"],
      win32: ["go install golang.org/x/tools/gopls@latest"],
    },
  },
  {
    name: "rust-analyzer",
    description: "LSP for Rust",
    required: false,
    check: () => lspExists("rust-analyzer"),
    install: {
      darwin: ["rustup component add rust-analyzer"],
      linux: ["rustup component add rust-analyzer"],
      win32: ["rustup component add rust-analyzer"],
    },
  },
];

export interface PrerequisiteStatus {
  prerequisite: Prerequisite;
  installed: boolean;
}

export function checkPrerequisites(): PrerequisiteStatus[] {
  const os = platform();
  return PREREQUISITES.filter((p) => !p.platforms || p.platforms.includes(os)).map((p) => ({
    prerequisite: p,
    installed: p.check(),
  }));
}

export function getInstallCommands(name: string): string[] {
  const os = platform();
  const prereq = PREREQUISITES.find((p) => p.name === name);
  if (!prereq) return [];
  return prereq.install[os] ?? prereq.install.linux ?? [];
}

export function getMissingRequired(): PrerequisiteStatus[] {
  return checkPrerequisites().filter((s) => !s.installed && s.prerequisite.required);
}
