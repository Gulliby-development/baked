import { redactSecrets } from "../workflows/redaction.js";

/** Key formats that should never leave the machine inside a published page. */
const KEY_PATTERNS: [string, RegExp][] = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Vercel token", /\bvercel_[A-Za-z0-9]{20,}/i],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export interface SecretFinding {
  line: number;
  kind: string;
}

/**
 * Lines of a page that look like they hold a secret: a known key format, a credential assignment
 * or the value of a secret environment variable of this process. Values are never returned.
 */
export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const known = KEY_PATTERNS.find(([, pattern]) => pattern.test(line));
    if (known) findings.push({ line: index + 1, kind: known[0] });
    else if (redactSecrets(line) !== line)
      findings.push({ line: index + 1, kind: "credential or secret environment value" });
  });
  return findings;
}
