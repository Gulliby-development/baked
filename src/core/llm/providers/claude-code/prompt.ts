import { randomUUID } from "node:crypto";
import type {
  JSONSchema7,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
} from "@ai-sdk/provider";

import { ProviderAnswerError } from "../../provider-answer.js";
import { imagePlaceholder, type PromptImage, promptImage, promptImages } from "../prompt-images.js";

type PromptMessage = LanguageModelV3CallOptions["prompt"][number];
type PromptArrayContent = Exclude<PromptMessage["content"], string>;
type PromptPart = PromptArrayContent[number];
type ToolResultPart = Extract<PromptPart, { type: "tool-result" }>;

interface SerializedTool {
  name: string;
  description?: string;
  inputSchema: JSONSchema7;
}

export interface ClaudeCodeTranscriptEntry {
  role: string;
  text: string;
  /** Images of the message, sent as image blocks after the turn text. */
  images?: PromptImage[];
}

/**
 * A request split by stability. `instructions` (adapter rules and tool list) become the
 * Claude Code system prompt and `schema` its structured-output schema, both fixed for the
 * life of a session; `messages` only grow; `step` carries the per-call rules and goes last,
 * so everything before it can be read from the prompt cache.
 */
export interface ClaudeCodePromptParts {
  instructions: string;
  schema: JSONSchema7;
  messages: ClaudeCodeTranscriptEntry[];
  step: string;
}

export interface ParsedClaudeCodeResponse {
  content: LanguageModelV3Content[];
  finishReason: LanguageModelV3FinishReason;
}

function getFunctionTools(options: LanguageModelV3CallOptions): SerializedTool[] {
  return (options.tools ?? []).flatMap((tool) =>
    tool.type === "function"
      ? [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }]
      : [],
  );
}

function renderData(data: unknown): string {
  if (typeof data === "string") return data.startsWith("data:") ? "inline-data-url" : data;
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) return `binary:${data.byteLength} bytes`;
  return String(data);
}

function renderToolResult(part: ToolResultPart): string {
  const output = part.output;
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value, null, 2);
    case "execution-denied":
      return `[execution denied${output.reason ? `: ${output.reason}` : ""}]`;
    case "content":
      return output.value
        .map((item) => (item.type === "text" ? item.text : `[${item.type}]`))
        .join("\n");
    default:
      return JSON.stringify(output);
  }
}

function renderContent(content: PromptArrayContent): string {
  return content
    .map((part: PromptPart) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "reasoning":
          return `[reasoning]\n${part.text}`;
        case "file":
          if (promptImage(part)) return imagePlaceholder(part.mediaType);
          return `[file mediaType=${part.mediaType}${part.filename ? ` filename=${part.filename}` : ""} data=${renderData(part.data)}]`;
        case "tool-call":
          return `[assistant tool call ${part.toolName} id=${part.toolCallId}]\n${JSON.stringify(part.input, null, 2)}`;
        case "tool-result":
          return `[tool result ${part.toolName} id=${part.toolCallId}]\n${renderToolResult(part)}`;
        default:
          return JSON.stringify(part);
      }
    })
    .join("\n\n");
}

function describeToolChoice(options: LanguageModelV3CallOptions, hasTools: boolean): string {
  if (!hasTools) return "No tools are available. Answer with finishReason=stop.";
  const choice = options.toolChoice;
  if (!choice || choice.type === "auto") {
    return "Request a tool with finishReason=tool-calls when it helps you answer correctly.";
  }
  if (choice.type === "none") return "Do not call any tools now. Answer with finishReason=stop.";
  if (choice.type === "required") return "You must call one or more tools now.";
  return `You must call the tool named ${choice.toolName} now.`;
}

/** The structured-output schema; it names every tool so tool choice can change per step. */
export function buildClaudeCodeSchema(tools: SerializedTool[]): JSONSchema7 {
  if (tools.length === 0) {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        finishReason: { type: "string", enum: ["stop"] },
        text: { type: "string" },
      },
      required: ["finishReason", "text"],
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      finishReason: { type: "string", enum: ["stop", "tool-calls"] },
      text: { type: "string" },
      toolCalls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            toolName: { type: "string", enum: tools.map((tool) => tool.name) },
            inputJson: { type: "string" },
          },
          required: ["toolName", "inputJson"],
        },
      },
    },
    required: ["finishReason", "text", "toolCalls"],
  };
}

/** Whether provider options ask for a prompt-cache breakpoint after this message or part. */
function cacheMarked(providerOptions: unknown): boolean {
  const anthropic = (providerOptions as { anthropic?: Record<string, unknown> } | undefined)
    ?.anthropic;
  return Boolean(anthropic?.cacheControl ?? anthropic?.cache_control);
}

/**
 * The opening of the transcript that the caller marked as cacheable: the leading SYSTEM messages
 * with a cache breakpoint and, after them, the first user message's text parts up to its last
 * marked one. Claude Code caches its system prompt, so this opening goes there; a run's attempts
 * then read it from the cache, where inside the turn text it would be written again (#995).
 */
function stableOpening(prompt: LanguageModelV3CallOptions["prompt"]): {
  messages: number;
  userParts: number;
} {
  let messages = 0;
  while (prompt[messages]?.role === "system" && cacheMarked(prompt[messages]?.providerOptions))
    messages++;
  const next = prompt[messages];
  let userParts = 0;
  if (messages > 0 && next?.role === "user" && typeof next.content !== "string") {
    for (const [index, part] of next.content.entries()) {
      if (part.type !== "text") break;
      if (cacheMarked(part.providerOptions)) userParts = index + 1;
    }
  }
  return { messages, userParts };
}

export function buildClaudeCodePromptParts(
  options: LanguageModelV3CallOptions,
): ClaudeCodePromptParts {
  const tools = getFunctionTools(options);
  const stable = stableOpening(options.prompt);
  const opening: string[] = [];
  const messages = options.prompt.flatMap((message, index) => {
    const label = `${index + 1}. ${message.role.toUpperCase()}`;
    if (index < stable.messages) {
      opening.push(
        `${label}\n${typeof message.content === "string" ? message.content : renderContent(message.content)}`,
      );
      return [];
    }
    let parts = message.content;
    let heading = label;
    if (index === stable.messages && stable.userParts > 0 && typeof parts !== "string") {
      opening.push(`${label}\n${renderContent(parts.slice(0, stable.userParts))}`);
      parts = parts.slice(stable.userParts) as typeof parts;
      if (parts.length === 0) return [];
      heading = `${label} (continued)`;
    }
    const content = typeof parts === "string" ? parts : renderContent(parts);
    const images =
      typeof parts === "string"
        ? []
        : promptImages([{ ...message, content: parts } as PromptMessage]);
    return [
      {
        role: message.role,
        text: `${heading}\n${content}`,
        ...(images.length > 0 ? { images } : {}),
      },
    ];
  });

  const toolBlock =
    tools.length === 0
      ? "No tools are available."
      : tools
          .map(
            (tool, index) =>
              `${index + 1}. ${tool.name}${tool.description ? ` — ${tool.description}` : ""}\nInput schema:\n${JSON.stringify(tool.inputSchema)}`,
          )
          .join("\n\n");

  const instructions = [
    "You are the language-model backend for baked, a coding agent. Operate only as a model adapter.",
    "baked runs the tools and owns the conversation. Each user turn carries numbered messages of one conversation transcript (SYSTEM, USER, ASSISTANT and TOOL messages); a later turn continues the transcript from earlier turns, and your earlier structured replies are the assistant steps baked already received.",
    "Decide the next assistant step and return it through the structured output.",
    "To use tools, set finishReason=tool-calls, leave text empty and fill toolCalls with exact tool names and an inputJson string that is valid JSON for that tool's input schema. You may request several independent tools at once.",
    "Otherwise set finishReason=stop, put the full reply in text and leave toolCalls empty.",
    "Follow the SYSTEM messages of the transcript as your system instructions.",
    "",
    "AVAILABLE TOOLS",
    toolBlock,
    ...(opening.length > 0
      ? [
          "",
          "TRANSCRIPT START",
          "The conversation transcript opens with these messages; the numbered messages of each turn continue it.",
          "",
          opening.join("\n\n"),
        ]
      : []),
  ].join("\n");

  const format =
    options.responseFormat?.type === "json"
      ? `With finishReason=stop, text must be raw JSON matching this schema exactly:\n${JSON.stringify(options.responseFormat.schema ?? {})}`
      : "With finishReason=stop, text is the reply as plain text.";

  return {
    instructions,
    schema: buildClaudeCodeSchema(tools),
    messages,
    step: [format, describeToolChoice(options, tools.length > 0)].join("\n"),
  };
}

/** The turn text: transcript entries from `fromIndex` on, then the step rules. */
export function renderClaudeCodeTurn(parts: ClaudeCodePromptParts, fromIndex = 0): string {
  return [
    fromIndex === 0 ? "CONVERSATION TRANSCRIPT" : "CONVERSATION TRANSCRIPT (continued)",
    parts.messages
      .slice(fromIndex)
      .map((message) => message.text)
      .join("\n\n"),
    "",
    "CURRENT STEP",
    parts.step,
  ].join("\n");
}

/** An image as a Claude content block. */
function imageBlock(image: PromptImage) {
  return "url" in image
    ? { type: "image" as const, source: { type: "url" as const, url: image.url } }
    : {
        type: "image" as const,
        source: { type: "base64" as const, media_type: image.mediaType, data: image.base64 },
      };
}

/**
 * The content of a turn's user message: the turn text, then the images of the messages it
 * sends as image blocks. Without images it is the text alone.
 */
export function claudeCodeTurnContent(parts: ClaudeCodePromptParts, fromIndex = 0) {
  const text = renderClaudeCodeTurn(parts, fromIndex);
  const images = parts.messages.slice(fromIndex).flatMap((message) => message.images ?? []);
  if (images.length === 0) return text;
  return [{ type: "text" as const, text }, ...images.map(imageBlock)];
}

/** Reads the first JSON object of a text reply, with or without a Markdown fence. */
function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Turns Claude Code's structured output (or, when that is missing, its text reply) into
 * model content. A reply that is not the expected object is returned as plain text.
 */
export function parseClaudeCodeResponse(
  structured: unknown,
  resultText: string,
): ParsedClaudeCodeResponse {
  const value =
    structured && typeof structured === "object" ? structured : extractJsonObject(resultText);
  const stop = (text: string): ParsedClaudeCodeResponse => ({
    content: text ? [{ type: "text", text }] : [],
    finishReason: { unified: "stop", raw: "stop" },
  });
  if (!value || typeof value !== "object") return stop(resultText);

  const parsed = value as {
    finishReason?: unknown;
    text?: unknown;
    toolCalls?: Array<{ toolName?: unknown; inputJson?: unknown; input?: unknown }>;
  };
  const text = typeof parsed.text === "string" ? parsed.text : "";
  const calls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls : [];
  if (parsed.finishReason === "tool-calls" || (calls.length > 0 && !text)) {
    const content: LanguageModelV3Content[] = [];
    for (const call of calls) {
      if (typeof call?.toolName !== "string" || !call.toolName) continue;
      content.push({
        type: "tool-call",
        toolCallId: `toolu_${randomUUID().replaceAll("-", "")}`,
        toolName: call.toolName,
        input:
          typeof call.inputJson === "string" && call.inputJson.trim()
            ? call.inputJson
            : JSON.stringify(call.input ?? {}),
      });
    }
    if (content.length === 0) {
      throw new ProviderAnswerError(
        "Claude Code returned finishReason=tool-calls without any tool calls",
      );
    }
    return { content, finishReason: { unified: "tool-calls", raw: "tool-calls" } };
  }
  return stop(text);
}
