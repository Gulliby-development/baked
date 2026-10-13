import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "../src/core/sessions/manager.js";
import type { SessionMeta, TabMeta } from "../src/core/sessions/types.js";
import type { ChatMessage } from "../src/types/index.js";

const TEST_DIR = join(import.meta.dir, ".tmp-session-test");

function makeTab(id: string): TabMeta {
	return {
		id,
		label: "Tab",
		activeModel: "test-model",
		sessionId: "test",
		planMode: false,
		planRequest: null,
		coAuthorCommits: false,
		tokenUsage: { prompt: 0, completion: 0, total: 0 },
		messageRange: { startLine: 0, endLine: 0 },
	};
}

function makeMeta(id: string, tabs: Array<{ id: string }> = [{ id: "tab-1" }]): SessionMeta {
	return {
		id,
		title: "Test session",
		startedAt: Date.now(),
		updatedAt: Date.now(),
		activeTabId: tabs[0]!.id,
		cwd: TEST_DIR,
		bakeMode: "default",
		tabs: tabs.map((t) => makeTab(t.id)),
	};
}

function makeMessage(role: "user" | "assistant", content: string): ChatMessage {
	return { role, content } as ChatMessage;
}

describe("SessionManager", () => {
	let manager: SessionManager;

	beforeEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		mkdirSync(TEST_DIR, { recursive: true });
		manager = new SessionManager(TEST_DIR);
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	it("saves and loads a session round-trip", async () => {
		const meta = makeMeta("sess-1");
		const msgs = [makeMessage("user", "hello"), makeMessage("assistant", "hi")];
		const tabMessages = new Map([["tab-1", msgs]]);

		await manager.saveSession(meta, tabMessages);
		const loaded = manager.loadSession("sess-1");

		expect(loaded).not.toBeNull();
		expect(loaded!.meta.id).toBe("sess-1");
		const loadedMsgs = loaded!.tabMessages.get("tab-1");
		expect(loadedMsgs).toHaveLength(2);
		expect(loadedMsgs![0]!.content).toBe("hello");
		expect(loadedMsgs![1]!.content).toBe("hi");
	});

	it("atomic writes — no .tmp files left after save", async () => {
		const meta = makeMeta("sess-2");
		const tabMessages = new Map([["tab-1", [makeMessage("user", "test")]]]);

		await manager.saveSession(meta, tabMessages);

		const sessionDir = join(TEST_DIR, ".baked", "sessions", "sess-2");
		expect(existsSync(join(sessionDir, "meta.json"))).toBe(true);
		expect(existsSync(join(sessionDir, "messages.jsonl"))).toBe(true);
		expect(existsSync(join(sessionDir, "meta.json.tmp"))).toBe(false);
		expect(existsSync(join(sessionDir, "messages.jsonl.tmp"))).toBe(false);
	});

	it("handles corrupted meta.json gracefully", async () => {
		const meta = makeMeta("sess-corrupt");
		const tabMessages = new Map([["tab-1", [makeMessage("user", "test")]]]);
		await manager.saveSession(meta, tabMessages);

		const metaPath = join(TEST_DIR, ".baked", "sessions", "sess-corrupt", "meta.json");
		writeFileSync(metaPath, "{ broken json ---");

		const loaded = manager.loadSession("sess-corrupt");
		expect(loaded).toBeNull();
	});

	it("recovers valid lines before corruption in messages.jsonl", async () => {
		const meta = makeMeta("sess-jsonl-corrupt");
		const msgs = [makeMessage("user", "hello"), makeMessage("assistant", "hi")];
		const tabMessages = new Map([["tab-1", msgs]]);
		await manager.saveSession(meta, tabMessages);

		const jsonlPath = join(
			TEST_DIR,
			".baked",
			"sessions",
			"sess-jsonl-corrupt",
			"messages.jsonl",
		);
		writeFileSync(jsonlPath, '{"role":"user","content":"ok"}\n{broken\n');

		const loaded = manager.loadSession("sess-jsonl-corrupt");
		expect(loaded).not.toBeNull();
		const tabMsgs = loaded!.tabMessages.get("tab-1") ?? [];
		expect(tabMsgs.length).toBeGreaterThanOrEqual(1);
		expect((tabMsgs[0] as { role: string }).role).toBe("user");
	});

	it("handles missing messages.jsonl (meta exists, data missing)", async () => {
		const meta = makeMeta("sess-no-jsonl");
		const tabMessages = new Map([["tab-1", [makeMessage("user", "test")]]]);
		await manager.saveSession(meta, tabMessages);

		const jsonlPath = join(
			TEST_DIR,
			".baked",
			"sessions",
			"sess-no-jsonl",
			"messages.jsonl",
		);
		rmSync(jsonlPath);

		const loaded = manager.loadSession("sess-no-jsonl");
		expect(loaded).not.toBeNull();
		expect(loaded!.tabMessages.get("tab-1")).toHaveLength(0);
	});

	it("handles empty messages.jsonl", async () => {
		const meta = makeMeta("sess-empty");
		const tabMessages = new Map([["tab-1", []]]);
		await manager.saveSession(meta, tabMessages);

		const loaded = manager.loadSession("sess-empty");
		expect(loaded).not.toBeNull();
		expect(loaded!.tabMessages.get("tab-1")).toHaveLength(0);
	});

	it("handles truncated messages.jsonl (partial last line)", async () => {
		const meta = makeMeta("sess-trunc");
		const msgs = [makeMessage("user", "hello"), makeMessage("assistant", "world")];
		const tabMessages = new Map([["tab-1", msgs]]);
		await manager.saveSession(meta, tabMessages);

		const jsonlPath = join(
			TEST_DIR,
			".baked",
			"sessions",
			"sess-trunc",
			"messages.jsonl",
		);
		const content = readFileSync(jsonlPath, "utf-8");
		writeFileSync(jsonlPath, content.slice(0, content.length - 10));

		const loaded = manager.loadSession("sess-trunc");
		expect(loaded).not.toBeNull();
		const tabMsgs = loaded!.tabMessages.get("tab-1") ?? [];
		expect(tabMsgs.length).toBeGreaterThanOrEqual(1);
	});

	it("returns null for non-existent session", () => {
		expect(manager.loadSession("does-not-exist")).toBeNull();
	});

	it("deletes a session", async () => {
		const meta = makeMeta("sess-del");
		await manager.saveSession(meta, new Map([["tab-1", []]]));
		expect(manager.deleteSession("sess-del")).toBe(true);
		expect(manager.loadSession("sess-del")).toBeNull();
	});

	it("lists sessions sorted by updatedAt descending", async () => {
		const m1 = makeMeta("sess-old");
		m1.updatedAt = 1000;
		const m2 = makeMeta("sess-new");
		m2.updatedAt = 2000;
		await manager.saveSession(m1, new Map([["tab-1", []]]));
		await manager.saveSession(m2, new Map([["tab-1", []]]));

		const list = manager.listSessions();
		expect(list).toHaveLength(2);
		expect(list[0]!.id).toBe("sess-new");
		expect(list[1]!.id).toBe("sess-old");
	});

	it("sessionCount returns correct count", async () => {
		await manager.saveSession(makeMeta("s1"), new Map([["tab-1", []]]));
		await manager.saveSession(makeMeta("s2"), new Map([["tab-1", []]]));
		expect(manager.sessionCount()).toBe(2);
	});

	it("clearAllSessions removes everything", async () => {
		await manager.saveSession(makeMeta("s1"), new Map([["tab-1", []]]));
		await manager.saveSession(makeMeta("s2"), new Map([["tab-1", []]]));
		const cleared = manager.clearAllSessions();
		expect(cleared).toBe(2);
		expect(manager.sessionCount()).toBe(0);
	});

	it("deriveTitle truncates long messages", () => {
		const long = "a".repeat(100);
		const title = SessionManager.deriveTitle([makeMessage("user", long)]);
		expect(title.length).toBeLessThanOrEqual(60);
		expect(title.endsWith("...")).toBe(true);
	});

	it("multi-tab session preserves per-tab messages", async () => {
		const meta = makeMeta("sess-multi", [{ id: "tab-a" }, { id: "tab-b" }]);
		const tabMessages = new Map([
			["tab-a", [makeMessage("user", "tab a msg")]],
			["tab-b", [makeMessage("user", "tab b msg1"), makeMessage("assistant", "tab b msg2")]],
		]);

		await manager.saveSession(meta, tabMessages);
		const loaded = manager.loadSession("sess-multi");

		expect(loaded).not.toBeNull();
		expect(loaded!.tabMessages.get("tab-a")).toHaveLength(1);
		expect(loaded!.tabMessages.get("tab-b")).toHaveLength(2);
		expect(loaded!.tabMessages.get("tab-a")![0]!.content).toBe("tab a msg");
		expect(loaded!.tabMessages.get("tab-b")![1]!.content).toBe("tab b msg2");
	});
});

// ── saveTab slice writes — the multi-tab restore-corruption fix ───────────
describe("SessionManager.saveTab", () => {
	let manager: SessionManager;
	const SID = "app-session-1";
	const fallback = (activeTabId: string) => ({
		title: "Test",
		cwd: TEST_DIR,
		bakeMode: "default" as const,
		activeTabId,
	});

	beforeEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		mkdirSync(TEST_DIR, { recursive: true });
		manager = new SessionManager(TEST_DIR);
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	it("writes a single tab into an empty session dir", async () => {
		const tab = makeTab("tab-a");
		const msgs = [makeMessage("user", "hello a")];
		await manager.saveTab(SID, tab, msgs, undefined, fallback("tab-a"));

		const loaded = manager.loadSession(SID);
		expect(loaded).not.toBeNull();
		expect(loaded!.meta.tabs).toHaveLength(1);
		expect(loaded!.tabMessages.get("tab-a")![0]!.content).toBe("hello a");
	});

	it("preserves other tabs when only one tab saves", async () => {
		// Initial multi-tab session.
		await manager.saveSession(
			makeMeta(SID, [{ id: "tab-a" }, { id: "tab-b" }, { id: "tab-c" }]),
			new Map([
				["tab-a", [makeMessage("user", "A1"), makeMessage("assistant", "A2")]],
				["tab-b", [makeMessage("user", "B1")]],
				["tab-c", [makeMessage("user", "C1")]],
			]),
		);

		// Only tab-c saves a new final assistant message.
		await manager.saveTab(
			SID,
			makeTab("tab-c"),
			[makeMessage("user", "C1"), makeMessage("assistant", "C-FINAL")],
			undefined,
			fallback("tab-c"),
		);

		const loaded = manager.loadSession(SID);
		expect(loaded).not.toBeNull();
		expect(loaded!.meta.tabs).toHaveLength(3);
		// tab-a + tab-b untouched
		expect(loaded!.tabMessages.get("tab-a")).toHaveLength(2);
		expect(loaded!.tabMessages.get("tab-a")![1]!.content).toBe("A2");
		expect(loaded!.tabMessages.get("tab-b")![0]!.content).toBe("B1");
		// tab-c got the new final assistant
		expect(loaded!.tabMessages.get("tab-c")).toHaveLength(2);
		expect(loaded!.tabMessages.get("tab-c")![1]!.content).toBe("C-FINAL");
	});

	it("concurrent saves from different tabs all land — no tab lost", async () => {
		await manager.saveSession(
			makeMeta(SID, [{ id: "tab-a" }, { id: "tab-b" }, { id: "tab-c" }]),
			new Map([
				["tab-a", []],
				["tab-b", []],
				["tab-c", []],
			]),
		);

		await Promise.all([
			manager.saveTab(
				SID,
				makeTab("tab-a"),
				[makeMessage("user", "A-final")],
				undefined,
				fallback("tab-a"),
			),
			manager.saveTab(
				SID,
				makeTab("tab-b"),
				[makeMessage("user", "B-final")],
				undefined,
				fallback("tab-b"),
			),
			manager.saveTab(
				SID,
				makeTab("tab-c"),
				[makeMessage("user", "C-final")],
				undefined,
				fallback("tab-c"),
			),
		]);

		const loaded = manager.loadSession(SID);
		expect(loaded).not.toBeNull();
		expect(loaded!.meta.tabs).toHaveLength(3);
		expect(loaded!.tabMessages.get("tab-a")![0]!.content).toBe("A-final");
		expect(loaded!.tabMessages.get("tab-b")![0]!.content).toBe("B-final");
		expect(loaded!.tabMessages.get("tab-c")![0]!.content).toBe("C-final");
	});

	it("appends a new tab id not yet in meta", async () => {
		await manager.saveSession(
			makeMeta(SID, [{ id: "tab-a" }]),
			new Map([["tab-a", [makeMessage("user", "A")]]]),
		);

		await manager.saveTab(
			SID,
			makeTab("tab-new"),
			[makeMessage("user", "NEW")],
			undefined,
			fallback("tab-new"),
		);

		const loaded = manager.loadSession(SID);
		expect(loaded!.meta.tabs).toHaveLength(2);
		expect(loaded!.tabMessages.get("tab-a")![0]!.content).toBe("A");
		expect(loaded!.tabMessages.get("tab-new")![0]!.content).toBe("NEW");
	});

	it("keeps the longer saved slice unless the save rewrites the history on purpose", async () => {
		const msgs = [
			makeMessage("user", "1"),
			makeMessage("assistant", "2"),
			makeMessage("user", "3"),
			makeMessage("assistant", "4"),
		];
		await manager.saveTab(SID, makeTab("tab-a"), msgs, undefined, fallback("tab-a"));

		// A shorter slice is taken for a stale save.
		await manager.saveTab(SID, makeTab("tab-a"), msgs.slice(0, 2), undefined, fallback("tab-a"));
		expect(manager.loadSession(SID)!.tabMessages.get("tab-a")).toHaveLength(4);

		// An undo rewrites it, with the undone turn kept in the tab for a redo.
		const undone = {
			...makeTab("tab-a"),
			redoTurns: [{ index: 2, anchorMessageId: msgs[2]!.id, messages: msgs.slice(2) }],
		};
		await manager.saveTab(SID, undone, msgs.slice(0, 2), undefined, fallback("tab-a"), {
			rewrite: true,
		});
		const loaded = manager.loadSession(SID)!;
		expect(loaded.tabMessages.get("tab-a")!.map((m) => m.content)).toEqual(["1", "2"]);
		expect(loaded.meta.tabs[0]!.messageRange).toEqual({ startLine: 0, endLine: 2 });
		expect(loaded.meta.tabs[0]!.redoTurns).toHaveLength(1);
	});

	it("preserves core.json slots for non-target tabs", async () => {
		const meta = makeMeta(SID, [{ id: "tab-a" }, { id: "tab-b" }]);
		await manager.saveSession(
			meta,
			new Map([
				["tab-a", [makeMessage("user", "A")]],
				["tab-b", [makeMessage("user", "B")]],
			]),
			new Map([
				["tab-a", [{ role: "user", content: "A-core" }]],
				["tab-b", [{ role: "user", content: "B-core" }]],
			]),
		);

		// tab-b saves new core
		await manager.saveTab(
			SID,
			makeTab("tab-b"),
			[makeMessage("user", "B"), makeMessage("assistant", "B2")],
			[
				{ role: "user", content: "B-core" },
				{ role: "assistant", content: "B-final-core" },
			],
			fallback("tab-b"),
		);

		const loaded = manager.loadSession(SID);
		expect(loaded!.tabCoreMessages?.get("tab-a")).toHaveLength(1);
		expect((loaded!.tabCoreMessages!.get("tab-a")![0] as { content: string }).content).toBe(
			"A-core",
		);
		expect(loaded!.tabCoreMessages?.get("tab-b")).toHaveLength(2);
	});
});
