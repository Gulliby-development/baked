/**
 * `baked session coordinator send TEXT` and `... launched`: talking to the project coordinator from
 * the headless CLI. The coordinator runs in this process, as in the terminal UI, so the sessions
 * and runs it launches are hosted here too; `send` keeps following them until nothing it launched
 * is active, unless `--no-follow` is given.
 */
import { loadConfig, loadEffectiveProjectConfig, mergeConfigs } from "../config/index.js";
import { LocalCoordinator, ReadonlyProjectState } from "../core/chat/coordinator-host.js";
import {
  type LaunchedView,
  launchLabel,
  launchNoteText,
  stageTrack,
} from "../core/chat/coordinator-launch.js";
import { BakeChatHost } from "../core/chat/host.js";
import { scriptedHostFromEnv } from "../core/chat/scripted-host.js";
import {
  type ChatEvent,
  type ChatPrompt,
  ChatService,
  type ChatSession,
  type PromptAnswer,
} from "../core/chat/sessions.js";
import { getCwd } from "../core/cwd.js";
import { SessionManager } from "../core/sessions/manager.js";
import { WorkflowClient } from "../core/workers/workflow-client.js";

export interface CoordinatorChatIO {
  out(text: string): void;
  err(text: string): void;
  /** Reads one line from the terminal; null when there is none to ask. */
  ask: ((question: string) => Promise<string>) | null;
}

export interface CoordinatorChatOptions {
  json: boolean;
  /** Approves every approval, split and workflow card the turn asks for. */
  yes: boolean;
  /** Keeps following launched work after the reply until none of it is active. */
  follow: boolean;
}

/** One line describing what a prompt asks. */
export function promptLine(prompt: ChatPrompt): string {
  switch (prompt.kind) {
    case "destructive":
      return prompt.description;
    case "web-search":
      return `Search the web for "${prompt.query}"`;
    case "fetch-page":
      return `Fetch ${prompt.url}`;
    case "outside-cwd":
      return `${prompt.tool} outside the project: ${prompt.path}`;
    case "question":
      return prompt.question;
    case "plan-review":
      return `Run the plan "${prompt.title}"`;
    case "workflow": {
      const stages = prompt.stages.length ? ` (${prompt.stages.join(" > ")})` : "";
      const gates = (prompt.gates ?? []).map((g) => `\n  Gate: ${g}`).join("");
      return `Run the workflow ${prompt.workflow}${stages}: ${prompt.why}\n  Request: ${prompt.prompt.replace(/\s+/g, " ")}${gates}`;
    }
    case "split": {
      const flows = prompt.flows.map((f) => `\n  - ${f.title} (${f.task})`).join("");
      return `Split "${prompt.title}" into ${prompt.flows.length} ${prompt.mode === "initiative" ? "flows of one initiative" : "runs"}:${flows}`;
    }
  }
}

const YES = /^(y|yes)$/i;

/**
 * How the CLI answers a prompt: `--yes` approves, a terminal asks, and without either an approval
 * is denied and a question skipped, so a script never hangs on a card.
 */
export async function answerPrompt(
  prompt: ChatPrompt,
  options: Pick<CoordinatorChatOptions, "yes">,
  io: CoordinatorChatIO,
): Promise<PromptAnswer> {
  if (prompt.kind === "question") {
    const choices = prompt.options.map((o, i) => `  ${i + 1}. ${o.label}`).join("\n");
    if (!io.ask) return { answer: prompt.allowSkip ? "" : (prompt.options[0]?.value ?? "") };
    const typed = (await io.ask(`${prompt.question}\n${choices}\nAnswer: `)).trim();
    const picked = prompt.options[Number(typed) - 1];
    return { answer: picked ? picked.value : typed };
  }
  let approve = options.yes;
  if (!approve && io.ask)
    approve = YES.test((await io.ask(`${promptLine(prompt)}\nAllow? [y/N] `)).trim());
  if (prompt.kind === "plan-review") return { action: approve ? "execute" : "cancel" };
  if (prompt.kind === "split" || prompt.kind === "workflow")
    return approve ? { approve, digest: prompt.digest } : { approve };
  return { approve };
}

/** One line per launched item, and its stages under a run, for `launched` and the end of `send`. */
export function launchedLines(launched: LaunchedView[]): string[] {
  const open = launched.filter((item) => !item.closed);
  const lines = open.flatMap((item) => {
    const head = `${item.active ? "●" : "○"} ${launchLabel(item)}${item.workflow ? ` [${item.workflow}]` : ""}: ${item.status}${item.activity ? ` (${item.activity})` : ""} · ${item.tokens} tokens`;
    return item.progress?.stages.length ? [head, `  ${stageTrack(item.progress)}`] : [head];
  });
  const closed = launched.length - open.length;
  if (closed > 0) lines.push(`${closed} closed`);
  return lines.length > 0 ? lines : ["The coordinator has launched nothing yet."];
}

/**
 * Sends `text` to the coordinator, prints its reply and answers its prompts; with `follow`, then
 * prints the news about launched work until none of it is active. Returns the exit code.
 */
export async function talkToCoordinator(
  chat: ChatService,
  session: ChatSession,
  text: string,
  options: CoordinatorChatOptions,
  io: CoordinatorChatIO,
  /** How often launched work is checked while following. */
  pollMs = 2000,
): Promise<number> {
  let reply = "";
  let failed: string | null = null;
  const answering = new Set<string>();
  const onEvent = (event: ChatEvent) => {
    if (event.type === "text") {
      reply += event.delta;
      if (!options.json) io.out(event.delta);
    } else if (event.type === "tool-call" && !options.json) io.err(`· ${event.tool}\n`);
    else if (event.type === "prompt" && !answering.has(event.prompt.id)) {
      const { prompt } = event;
      answering.add(prompt.id);
      void answerPrompt(prompt, options, io).then((answer) => {
        if (!session.hasPrompt(prompt.id)) return;
        const approved = "approve" in answer ? answer.approve : true;
        if (!options.json) io.err(`${approved ? "Allowed" : "Denied"}: ${promptLine(prompt)}\n`);
        session.answer(prompt.id, answer);
      });
    } else if (event.type === "notice" && event.message.launch && !options.json)
      io.err(`${launchNoteText(event.message.launch)}\n`);
    else if (event.type === "turn-done") {
      if (event.status === "failed") failed = event.error ?? "The turn failed";
      if (!options.json && reply && !reply.endsWith("\n")) io.out("\n");
    }
  };
  const stop = session.subscribe(session.detail().lastSeq, onEvent);
  try {
    session.send(text);
    await session.settled();
    if (options.follow) {
      // A run's stage track is printed each time it moves, so a script sees where the run is.
      const tracks = new Map<string, string>();
      const reportStages = (launched: LaunchedView[]) => {
        for (const item of launched) {
          if (item.closed || !item.progress?.stages.length) continue;
          const track = stageTrack(item.progress);
          if (tracks.get(item.id) === track) continue;
          tracks.set(item.id, track);
          if (!options.json) io.err(`${launchLabel(item)}: ${track}\n`);
        }
      };
      // Launched sessions and runs are hosted here, so the process stays until they finish.
      for (;;) {
        const launched = chat.launched(session.id);
        reportStages(launched);
        if (!launched.some((item) => item.active && !item.closed)) break;
        await Bun.sleep(pollMs);
        await session.settled();
      }
      // The last status change is noted now rather than at the watcher's next tick.
      await chat.syncLaunched();
      await session.settled();
    }
    const launched = chat.launched(session.id);
    if (options.json)
      io.out(
        `${JSON.stringify({ sessionId: session.id, reply, launched, ...(failed ? { error: failed } : {}) }, null, 2)}\n`,
      );
    else if (launched.length > 0) io.err(`\n${launchedLines(launched).join("\n")}\n`);
    if (failed && !options.json) io.err(`${failed}\n`);
    return failed ? 1 : 0;
  } finally {
    stop?.();
  }
}

function terminalAsk(): ((question: string) => Promise<string>) | null {
  if (!process.stdin.isTTY) return null;
  return async (question) => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

const io: CoordinatorChatIO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  ask: terminalAsk(),
};

/** `baked session coordinator send TEXT [--yes] [--no-follow] [--model M] [--json]`. */
export async function coordinatorSend(args: string[]): Promise<number> {
  const flags = new Set(["--yes", "--no-follow", "--json"]);
  const model = args[args.indexOf("--model") + 1];
  const words = args.filter(
    (arg, i) => !flags.has(arg) && arg !== "--model" && args[i - 1] !== "--model",
  );
  const unknown = words.find((w) => w.startsWith("--"));
  if (unknown) {
    io.err(`Unknown argument: ${unknown}\n`);
    return 1;
  }
  const text = words.join(" ").trim();
  if (!text) {
    io.err("Say what to send: baked session coordinator send TEXT\n");
    return 1;
  }
  const workspace = getCwd();
  const config = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace));
  const client = new WorkflowClient(workspace, config);
  // As in `baked serve`: BAKED_TEST_SCRIPT plays scripted turns instead of a model.
  const test = scriptedHostFromEnv();
  let local: LocalCoordinator | null = null;
  const interrupt = () => local?.session.interrupt();
  process.once("SIGINT", interrupt);
  try {
    local = await LocalCoordinator.open({
      workspace,
      config,
      client,
      ...(test ? { host: test } : {}),
      model: () => (args.includes("--model") && model ? model : config.defaultModel),
    });
    return await talkToCoordinator(
      local.chat,
      local.session,
      text,
      {
        json: args.includes("--json"),
        yes: args.includes("--yes"),
        follow: !args.includes("--no-follow"),
      },
      io,
    );
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", interrupt);
    await local?.close();
    client.close();
  }
}

/** `baked session coordinator launched [--json]`: what the coordinator launched, as it is now. */
export async function coordinatorLaunched(args: string[]): Promise<number> {
  const unknown = args.find((a) => a !== "--json");
  if (unknown) {
    io.err(`Unknown argument: ${unknown}\n`);
    return 1;
  }
  const workspace = getCwd();
  const coordinator = new SessionManager(workspace)
    .listSessions()
    .find((s) => s.kind === "coordinator");
  if (!coordinator) {
    io.err(
      "This project has no coordinator yet; `baked session coordinator send TEXT` creates it.\n",
    );
    return 1;
  }
  const config = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace));
  const chat = new ChatService({ workspace, config, host: new BakeChatHost(workspace, config) });
  const state = new ReadonlyProjectState(workspace, config);
  try {
    chat.setProjectState(state, null, 0);
    const launched = chat.launched(coordinator.id);
    io.out(
      args.includes("--json")
        ? `${JSON.stringify({ sessionId: coordinator.id, launched }, null, 2)}\n`
        : `${launchedLines(launched).join("\n")}\n`,
    );
    return 0;
  } finally {
    await chat.shutdown();
    state.close();
  }
}
