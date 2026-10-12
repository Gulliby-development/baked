import type { FileMarker, Trigger } from "./trigger.js";
import { kindOf } from "./trigger.js";

const WINDOW = 20;

function excerpt(text: string, marker: FileMarker): string {
  const lines = text.split("\n");
  const from = Math.max(1, marker.line - WINDOW);
  const to = Math.min(lines.length, marker.endLine + WINDOW);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(`${String(n).padStart(width)}  ${lines[n - 1] ?? ""}`);
  return out.join("\n");
}

function where(marker: FileMarker): string {
  return marker.endLine > marker.line
    ? `${marker.path}:${marker.line}-${marker.endLine}`
    : `${marker.path}:${marker.line}`;
}

/** A one-line label for the turn, e.g. "src/x.ts:42 (baked!)". */
export function triggerLabel(trigger: Trigger, marker = "baked"): string {
  const first = trigger.requests[0];
  if (!first) return "";
  const more = trigger.requests.length > 1 ? ` and ${trigger.requests.length - 1} more` : "";
  return `${where(first)} (${marker}${first.kind === "act" ? "!" : "?"})${more}`;
}

/**
 * The user turn for a trigger: each request with its place in the file and the code around it,
 * then the context comments, then what to do. The agent edits through its normal tools, so the
 * marker removal is checked, approved and undone like any other edit.
 */
export function buildWatchPrompt(
  trigger: Trigger,
  read: (path: string) => string | null,
  options: { marker?: string; removeAnswered?: boolean } = {},
): string {
  const marker = options.marker ?? "baked";
  const act = kindOf(trigger) === "act";
  const parts: string[] = [
    act
      ? `I left \`${marker}!\` comments in the code asking for changes.`
      : `I left \`${marker}?\` comments in the code with questions.`,
  ];
  for (const request of trigger.requests) {
    const text = read(request.path);
    parts.push(
      [
        `## ${where(request)} (${marker}${request.kind === "act" ? "!" : "?"})`,
        request.text ? `> ${request.text.split("\n").join("\n> ")}` : "",
        text === null ? "" : `\`\`\`\n${excerpt(text, request)}\n\`\`\``,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  if (trigger.context.length > 0) {
    parts.push(
      [
        `## Context comments (\`${marker}\`)`,
        ...trigger.context.map((c) => `- ${where(c)}: ${c.text.split("\n").join(" ")}`),
      ].join("\n"),
    );
  }
  const asks = trigger.requests.some((r) => r.kind === "ask");
  const steps: string[] = [];
  if (act)
    steps.push(
      `Make the changes the \`${marker}!\` comments ask for, then remove the \`${marker}!\` comment lines you handled.`,
    );
  if (asks)
    steps.push(
      options.removeAnswered
        ? `Answer the \`${marker}?\` questions, then remove the \`${marker}?\` comment lines you answered; change nothing else for them.`
        : `Answer the \`${marker}?\` questions without editing files for them.`,
    );
  if (act && trigger.context.length > 0)
    steps.push(`Use the \`${marker}\` context comments; remove them once a change used them.`);
  parts.push(steps.join(" "));
  return parts.join("\n\n");
}
