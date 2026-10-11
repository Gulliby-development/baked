import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { isBinaryFile } from "isbinaryfile";
import { parseSessionMeta } from "../sessions/meta.js";
import { createWorkerHandler } from "./rpc.js";

const MAX_READ_LINES = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_READ_SIZE = 250 * 1024;

const handlers: Record<string, (...args: unknown[]) => unknown> = {
  // ── File Read (offloaded from main thread) ─────────────────────────
  readFileNumbered: async (filePath: unknown, startLine: unknown, endLine: unknown) => {
    const fp = filePath as string;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(fp);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg =
        code === "EACCES" || code === "EPERM"
          ? `Permission denied: ${fp}`
          : `File not found: ${fp}`;
      return { error: "not_found", message: msg };
    }

    if (st.isDirectory()) {
      return { error: "directory", message: `Path is a directory: ${fp}` };
    }

    if (await isBinaryFile(fp)) {
      const ext = extname(fp).toLowerCase();
      const sizeStr =
        st.size > 1024 * 1024
          ? `${(st.size / (1024 * 1024)).toFixed(1)}MB`
          : `${(st.size / 1024).toFixed(0)}KB`;
      return { error: "binary", ext, sizeStr };
    }

    if (st.size > MAX_READ_SIZE) {
      const sizeStr =
        st.size > 1024 * 1024
          ? `${(st.size / (1024 * 1024)).toFixed(1)}MB`
          : `${String(Math.round(st.size / 1024))}KB`;
      return { error: "too_large", sizeStr };
    }

    const content = await readFile(fp, "utf-8");
    const lines = content.split("\n");
    const start = ((startLine as number | null) ?? 1) - 1;
    const end = (endLine as number | null) ?? lines.length;
    let slice = lines.slice(start, end);

    const totalLines = lines.length;
    const truncated = slice.length > MAX_READ_LINES;
    if (truncated) slice = slice.slice(0, MAX_READ_LINES);

    const numbered = slice
      .map((line: string, i: number) => {
        const l = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}...` : line;
        return `${String(start + i + 1).padStart(4)}  ${l}`;
      })
      .join("\n");

    return {
      ok: true,
      numbered,
      totalLines,
      truncated,
      start,
      hash: Bun.hash(content).toString(16),
    };
  },

  // ── Shell Output Compression ───────────────────────────────────────
  compressShellOutput: async (raw: unknown) => {
    const { compressShellOutput } = await import("../tools/shell-compress.js");
    return compressShellOutput(raw as string);
  },

  compressShellOutputFull: async (raw: unknown) => {
    const { compressShellOutputFull } = await import("../tools/shell-compress.js");
    return compressShellOutputFull(raw as string);
  },

  // ── File Tree ──────────────────────────────────────────────────────
  walkDir: async (dir: unknown, prefix: unknown, depth: unknown) => {
    const { walkDir } = await import("../context/file-tree.js");
    const lines: string[] = [];
    walkDir(dir as string, prefix as string, depth as number, lines);
    return lines;
  },

  // ── Git Parsing ────────────────────────────────────────────────────
  parseGitLogLine: async (line: unknown) => {
    const { parseGitLogLine } = await import("../git/status.js");
    return parseGitLogLine(line as string);
  },

  parseGitLogBatch: async (lines: unknown) => {
    const { parseGitLogLine } = await import("../git/status.js");
    return (lines as string[]).map(parseGitLogLine);
  },

  // ── Compaction Serialization ───────────────────────────────────────
  serializeWorkingState: async (state: unknown) => {
    const { serializeState } = await import("../compaction/working-state.js");
    const s = state as import("../compaction/types.js").WorkingState;
    return serializeState(s);
  },

  buildConvoText: async (messages: unknown, charBudget: unknown) => {
    const { buildFullConvoText } = await import("../compaction/convo-text.js");
    type ModelMessage = import("ai").ModelMessage;
    return buildFullConvoText(messages as ModelMessage[], charBudget as number);
  },

  // ── Session Persistence ────────────────────────────────────────────
  saveSession: async (
    sessionDir: unknown,
    meta: unknown,
    tabEntries: unknown,
    coreEntries: unknown,
  ) => {
    const dir = sessionDir as string;
    const sessionMeta = meta as import("../sessions/types.js").SessionMeta;
    const entries = tabEntries as [string, unknown[]][];

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const allMessages: unknown[] = [];
    const updatedTabs = sessionMeta.tabs.map((tab) => {
      const msgs = entries.find(([id]) => id === tab.id)?.[1] ?? [];
      const startLine = allMessages.length;
      for (const msg of msgs) allMessages.push(msg);
      const endLine = allMessages.length;
      return { ...tab, messageRange: { startLine, endLine } };
    });

    const updatedMeta = { ...sessionMeta, tabs: updatedTabs };
    const metaJson = JSON.stringify(updatedMeta, null, 2);
    const lines = allMessages.map((m) => JSON.stringify(m)).join("\n");

    const metaPath = join(dir, "meta.json");
    const jsonlPath = join(dir, "messages.jsonl");
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const metaTmp = `${metaPath}.${suffix}.tmp`;
    const jsonlTmp = `${jsonlPath}.${suffix}.tmp`;

    await writeFile(metaTmp, metaJson, { encoding: "utf-8", mode: 0o600 });
    await writeFile(jsonlTmp, lines ? `${lines}\n` : "", { encoding: "utf-8", mode: 0o600 });
    await rename(jsonlTmp, jsonlPath);
    await rename(metaTmp, metaPath);

    const cores = coreEntries as [string, unknown[]][] | null;
    if (cores && cores.length > 0) {
      const coreData: Record<string, unknown[]> = {};
      for (const [tabId, msgs] of cores) {
        coreData[tabId] = msgs;
      }
      const corePath = join(dir, "core.json");
      const coreTmp = `${corePath}.${suffix}.tmp`;
      await writeFile(coreTmp, JSON.stringify(coreData), { encoding: "utf-8", mode: 0o600 });
      await rename(coreTmp, corePath);
    }
  },

  loadSession: async (sessionDir: unknown) => {
    const dir = sessionDir as string;
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) return null;

    const meta = parseSessionMeta(readFileSync(metaPath, "utf-8"));
    const jsonlPath = join(dir, "messages.jsonl");
    const allMessages: unknown[] = [];

    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, "utf-8").trim();
      if (content) {
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            allMessages.push(JSON.parse(line));
          } catch {
            break;
          }
        }
      }
    }

    const tabEntries: [string, unknown[]][] = [];
    for (const tab of meta.tabs) {
      const { startLine, endLine } = tab.messageRange;
      tabEntries.push([tab.id, allMessages.slice(startLine, endLine)]);
    }

    const corePath = join(dir, "core.json");
    let coreEntries: [string, unknown[]][] | undefined;
    if (existsSync(corePath)) {
      try {
        const coreData = JSON.parse(readFileSync(corePath, "utf-8")) as Record<string, unknown[]>;
        coreEntries = Object.entries(coreData);
      } catch {
        /* ignore */
      }
    }

    return { meta, tabEntries, coreEntries };
  },

  // ── Session Listing ───────────────────────────────────────────────
  listSessions: (sessionsDir: unknown) => {
    const dir = sessionsDir as string;
    if (!existsSync(dir)) return [];
    try {
      const entries = readdirSync(dir);
      const metas: Array<{
        id: string;
        title: string;
        messageCount: number;
        startedAt: number;
        updatedAt: number;
        sizeBytes: number;
        projectId?: string;
      }> = [];

      for (const entry of entries) {
        try {
          const fullPath = join(dir, entry);
          const s = statSync(fullPath);
          if (!s.isDirectory()) continue;
          const metaPath = join(fullPath, "meta.json");
          if (!existsSync(metaPath)) continue;
          const raw = readFileSync(metaPath, "utf-8");
          const meta = JSON.parse(raw);
          const totalMessages = (meta.tabs ?? []).reduce(
            (sum: number, t: { messageRange: { startLine: number; endLine: number } }) =>
              sum + (t.messageRange.endLine - t.messageRange.startLine),
            0,
          );
          let sizeBytes = 0;
          for (const file of ["meta.json", "messages.jsonl"]) {
            try {
              sizeBytes += statSync(join(fullPath, file)).size;
            } catch {}
          }
          metas.push({
            id: meta.id,
            title: meta.title,
            messageCount: totalMessages,
            startedAt: meta.startedAt,
            updatedAt: meta.updatedAt,
            sizeBytes,
            ...(typeof meta.projectId === "string" ? { projectId: meta.projectId } : {}),
          });
        } catch {
          // Skip corrupted entries
        }
      }
      return metas.sort(
        (a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt,
      );
    } catch {
      return [];
    }
  },
};

createWorkerHandler(handlers);
