import { randomUUID } from "node:crypto";
import type {
  JSONSchema7,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
} from "@ai-sdk/provider";

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

export function buildClaudeCodePromptParts(
  options: LanguageModelV3CallOptions,
): ClaudeCodePromptParts {
  const tools = getFunctionTools(options);
  const messages = options.prompt.map((message, index) => {
    const content =
      typeof message.content === "string" ? message.content : renderContent(message.content);
    return { role: message.role, text: `${index + 1}. ${message.role.toUpperCase()}\n${content}` };
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
      throw new Error("Claude Code returned finishReason=tool-calls without any tool calls");
    }
    return { content, finishReason: { unified: "tool-calls", raw: "tool-calls" } };
  }
  return stop(text);
}
