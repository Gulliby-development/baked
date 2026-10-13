import { isAbsolute, relative, resolve } from "node:path";
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";

/**
 * The opt-in approval reviewer of chat tool calls (`agentFeatures.approvalReview`, #599). A model
 * decides the approvals the host lets it decide: project-local cleanup commands and edits to
 * sensitive files that hold no secrets. It approves only at low risk; anything else, a timeout or
 * a malformed answer goes to the person as before, with the reviewer's verdict in the prompt.
 */

/** What an approval is for, so the reviewer judges the call and not its description. */
export type ApprovalDetail = (
  | { kind: "shell"; command: string; cwd: string; crossTab?: boolean }
  | { kind: "edit"; path: string; cwd: string }
) & {
  /** Set when the reviewer approved the call, for the tool's result. */
  approvedBy?: string;
};

export type ApproveDestructive = (description: string, detail?: ApprovalDetail) => Promise<boolean>;

export const ChatApprovalReviewSchema = z
  .object({
    verdict: z.enum(["approve", "escalate"]),
    risk: z.enum(["low", "medium", "high"]),
    reasons: z.array(z.string().min(1).max(2000)).min(1).max(10),
  })
  .strict();
export type ChatApprovalReview = z.infer<typeof ChatApprovalReviewSchema>;

/** One model call: a system prompt and a user prompt in, text out. */
export type ReviewModel = (prompt: {
  system: string;
  user: string;
  signal: AbortSignal;
}) => Promise<string>;

export const APPROVAL_REVIEW_TIMEOUT_MS = 30_000;

/** Shell operators that chain, substitute or redirect: such a command always goes to a person. */
const COMPOUND = /[;&|`<>\n\r]|\$\(/;
const SECRET_FILE =
  /(^|[\\/])\.env($|\.)|credentials|secrets?\.|private[_-]?key|\.pem$|\.key$|id_rsa|id_ed25519|\.npmrc$|\.pypirc$/i;

function words(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/** A path argument the reviewer may judge: inside the project, not the project or `.git` itself. */
function projectPath(arg: string, cwd: string): boolean {
  if (/^[~$%]/.test(arg) || arg.includes("..")) return false;
  const target = resolve(cwd, arg);
  const rel = relative(cwd, target);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) return false;
  const first = rel.split(/[\\/]/)[0] ?? "";
  // A bare glob such as `*` or `.*` would reach the whole project.
  return first !== ".git" && !/^[.]?\*$/.test(first);
}

/**
 * Why a call always goes to the person, or null when the reviewer may decide it. Only these may
 * reach the reviewer: `rm` of paths inside the project, `git branch -D`, `git rebase`, `kill` of
 * process IDs, and edits of sensitive files that are not secrets (CI, Dockerfile, compose files).
 */
export function alwaysHumanReason(detail: ApprovalDetail): string | null {
  if (detail.kind === "edit") {
    if (SECRET_FILE.test(detail.path)) return "the file may hold secrets";
    return projectPath(detail.path, detail.cwd) ? null : "the file is outside the project";
  }
  if (detail.crossTab) return "other tabs are editing files";
  const command = detail.command.trim();
  if (COMPOUND.test(command)) return "the command chains, substitutes or redirects";
  const argv = words(command);
  const [program, sub] = argv;
  if (program === "rm") {
    const paths = argv.slice(1).filter((arg) => !arg.startsWith("-"));
    if (paths.length === 0 || argv.slice(1).some((arg) => arg === "--no-preserve-root"))
      return "the command names no project path";
    return paths.every((path) => projectPath(path, detail.cwd))
      ? null
      : "it deletes a path outside the project, the project itself or .git";
  }
  if (program === "git" && sub === "branch" && argv.includes("-D")) return null;
  if (program === "git" && sub === "rebase") return null;
  if (program === "kill" && argv.slice(1).every((arg) => /^(-9|-KILL|-SIGKILL|\d+)$/.test(arg)))
    return argv.slice(1).some((arg) => /^\d+$/.test(arg)) ? null : "the command names no process";
  return "this kind of command is always decided by a person";
}

const SYSTEM = `You decide whether a coding agent's tool call may run without asking the person. Reply with one JSON object and nothing else: {"verdict": "approve" | "escalate", "risk": "low" | "medium" | "high", "reasons": ["..."]}.

Approve only when all of these hold:
- the person's own words in the conversation ask for this operation or plainly imply it;
- it touches only what the request needs, inside the project;
- it removes nothing the person may still want (source they wrote, data, history someone else depends on).
Rate the risk low, medium or high. When in doubt, escalate. You cannot change the call: you only let it run or send it to the person. Name what decides it in the reasons.`;

function requestText(detail: ApprovalDetail, description: string): string {
  return JSON.stringify({
    call:
      detail.kind === "shell"
        ? { kind: "shell command", command: detail.command }
        : { kind: "edit of a sensitive file", path: detail.path },
    description,
  });
}

function parseReview(text: string): ChatApprovalReview {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the reviewer returned no JSON object");
  return ChatApprovalReviewSchema.parse(JSON.parse(body.slice(start, end + 1)));
}

/** The reviewer's verdict in one line, for the person's prompt or the tool result. */
export function reviewLine(review: ChatApprovalReview): string {
  return `Approval reviewer ${review.verdict === "approve" ? "approved" : "escalated"} at ${review.risk} risk: ${review.reasons.join(" ")}`;
}

/**
 * Wraps the person's approval with the reviewer. A call the reviewer may decide goes to it first;
 * a low-risk approval runs the call without asking. Everything else asks the person (or is denied
 * where nobody can be asked), with the verdict or the reviewer's failure added to the prompt.
 */
export function withApprovalReview(
  ask: ApproveDestructive | undefined,
  model: ReviewModel,
  conversation: () => string[],
  timeoutMs = APPROVAL_REVIEW_TIMEOUT_MS,
): ApproveDestructive {
  const escalate = (description: string, detail: ApprovalDetail | undefined, note: string) =>
    ask ? ask(`${description}\n\n${note}`, detail) : Promise.resolve(false);
  return async (description, detail) => {
    if (!detail || alwaysHumanReason(detail) !== null)
      return ask ? ask(description, detail) : false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const text = await model({
        system: SYSTEM,
        user: JSON.stringify({
          request: JSON.parse(requestText(detail, description)),
          conversation: conversation(),
        }),
        signal: controller.signal,
      });
      const review = parseReview(text);
      if (review.verdict === "approve" && review.risk === "low") {
        detail.approvedBy = reviewLine(review);
        return true;
      }
      return escalate(description, detail, reviewLine(review));
    } catch (error) {
      const reason = controller.signal.aborted
        ? "it did not answer in time"
        : error instanceof Error
          ? error.message
          : String(error);
      return escalate(
        description,
        detail,
        `The approval reviewer could not decide (${reason.slice(0, 300)}).`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A review model over the chat's own model: one `generateText` call. */
export function chatReviewModel(
  model: LanguageModel,
  options: { providerOptions?: Record<string, unknown>; headers?: Record<string, string> } = {},
): ReviewModel {
  return async ({ system, user, signal }) => {
    const result = await generateText({
      model,
      system,
      prompt: user,
      maxOutputTokens: 1024,
      abortSignal: signal,
      ...(options.providerOptions && Object.keys(options.providerOptions).length
        ? { providerOptions: options.providerOptions as never }
        : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
    return result.text;
  };
}

/** The person's recent messages, newest last, for the reviewer. */
export function recentUserTexts(texts: string[], max = 5, chars = 2000): string[] {
  return texts.slice(-max).map((text) => text.slice(0, chars));
}
