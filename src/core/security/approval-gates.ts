import { basename } from "node:path";

const DESTRUCTIVE_SHELL_PATTERNS = [
  /\brm\s+(-[^\s]*)?-r/,
  /\brm\s+(-[^\s]*)?-f/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+.*-f/,
  /\bgit\s+checkout\s+--\s/,
  /\bgit\s+branch\s+.*-D\b/,
  /\bgit\s+rebase\b/,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  /\bkill\s+-9/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bchmod\s+(-[^\s]+\s+)*0?777\b/,
  /\bcurl\b.*\|\s*(sudo\s+)?(ba)?sh/,
  /\bwget\b.*\|\s*(sudo\s+)?(ba)?sh/,
];

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_SHELL_PATTERNS.some((p) => p.test(command));
}

const SENSITIVE_FILE_PATTERNS = [
  /^\.env($|\.)/,
  /^\.env\..+/,
  /credentials/i,
  /secrets?\./i,
  /\bprivate[_-]?key/i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /id_ed25519/,
  /\.github\/workflows\//,
  /\.gitlab-ci\.yml$/,
  /Jenkinsfile$/,
  /docker-compose.*\.ya?ml$/,
  /Dockerfile$/,
  /\.npmrc$/,
  /\.pypirc$/,
];

export function isSensitiveFile(filePath: string): boolean {
  const name = basename(filePath);
  return SENSITIVE_FILE_PATTERNS.some((p) => p.test(filePath) || p.test(name));
}

export function describeDestructiveCommand(command: string): string {
  if (/\brm\s/.test(command)) return "delete files/directories";
  if (/\bgit\s+push.*--force|\bgit\s+push\s+-f/.test(command))
    return "force push (may overwrite remote history)";
  if (/\bgit\s+reset\s+--hard/.test(command)) return "discard all uncommitted changes";
  if (/\bgit\s+clean/.test(command)) return "delete untracked files";
  if (/\bgit\s+rebase/.test(command)) return "rewrite commit history";
  if (/\bgit\s+branch.*-D/.test(command)) return "force-delete a branch";
  if (/\bdrop\s/i.test(command)) return "drop database objects";
  if (/\btruncate\s/i.test(command)) return "truncate table data";
  if (/\bkill/.test(command)) return "kill processes";
  if (/\bcurl\b.*\|.*sh|\bwget\b.*\|.*sh/.test(command)) return "pipe remote script to shell";
  return "potentially destructive operation";
}
