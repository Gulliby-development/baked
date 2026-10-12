import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCwd, setCwd } from "../src/core/cwd.js";
import { initForbidden } from "../src/core/security/forbidden.js";
import { setFormatCache } from "../src/core/tools/auto-format.js";
import { clearEditStacks, undoEditTool } from "../src/core/tools/edit-stack.js";
import { editFileTool } from "../src/core/tools/edit-file.js";
import {
	describeLineEndings,
	detectNewFileLineEnding,
	dominantLineEnding,
	withLineEnding,
} from "../src/core/tools/line-endings.js";
import { multiEditTool } from "../src/core/tools/multi-edit.js";
import { readFileTool } from "../src/core/tools/read-file.js";

const TMP = join(tmpdir(), `line-endings-test-${Date.now()}`);
const ORIG_CWD = getCwd();

async function fixture(name: string, content: string): Promise<string> {
	const path = join(TMP, name);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content, "utf-8");
	return path;
}

beforeEach(async () => {
	clearEditStacks();
	setFormatCache(null);
	await rm(TMP, { recursive: true, force: true });
	await mkdir(TMP, { recursive: true });
	setCwd(TMP, { changeProcess: false });
	initForbidden(TMP);
});

afterAll(async () => {
	setCwd(ORIG_CWD, { changeProcess: false });
	await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("line ending helpers", () => {
	it("picks the dominant ending and defaults to LF", () => {
		expect(dominantLineEnding("a\r\nb\r\nc\n")).toBe("crlf");
		expect(dominantLineEnding("a\nb\r\n")).toBe("lf");
		expect(dominantLineEnding("no breaks")).toBe("lf");
	});

	it("describes only non-LF files", () => {
		expect(describeLineEndings("a\nb\n")).toBeNull();
		expect(describeLineEndings("a\r\nb\r\n")).toBe("CRLF");
		expect(describeLineEndings("a\r\nb\r\nc\n")).toContain("mixed: 2 CRLF, 1 LF");
	});

	it("re-encodes mixed text uniformly", () => {
		expect(withLineEnding("a\nb\r\nc", "crlf")).toBe("a\r\nb\r\nc");
		expect(withLineEnding("a\r\nb\n", "lf")).toBe("a\nb\n");
	});

	it("detects the ending of a new file from .editorconfig, then siblings", async () => {
		await fixture("ec/.editorconfig", "root = true\n[*]\nend_of_line = crlf\n");
		expect(detectNewFileLineEnding(join(TMP, "ec"))).toBe("crlf");
		await fixture("sib/a.txt", "x\r\ny\r\n");
		await fixture("sib/b.txt", "x\r\ny\r\n");
		await fixture("sib/c.txt", "x\ny\n");
		expect(detectNewFileLineEnding(join(TMP, "sib"))).toBe("crlf");
		await mkdir(join(TMP, "empty"), { recursive: true });
		expect(detectNewFileLineEnding(join(TMP, "empty"))).toBeNull();
	});
});

describe("edit_file keeps the file's line endings", () => {
	it("keeps CRLF when the model sends LF text", async () => {
		const path = await fixture("a.js", "one\r\ntwo\r\nthree\r\n");
		const res = await editFileTool.execute({
			path,
			oldString: "two",
			newString: "two\nextra",
			lineStart: 2,
		});
		expect(res.success).toBe(true);
		expect(await readFile(path, "utf-8")).toBe("one\r\ntwo\r\nextra\r\nthree\r\n");
		expect(res.output).toContain("CRLF");
	});

	it("matches a multi-line oldString written with LF against CRLF content", async () => {
		const path = await fixture("b.txt", "a\r\nb\r\nc\r\nd\r\n");
		const res = await editFileTool.execute({ path, oldString: "b\nc", newString: "B\nC" });
		expect(res.success).toBe(true);
		expect(await readFile(path, "utf-8")).toBe("a\r\nB\r\nC\r\nd\r\n");
	});

	it("normalizes a mixed file to its dominant ending (212/38 case in miniature)", async () => {
		const path = await fixture("mixed.js", "a\r\nb\r\nc\r\nd\ne\r\n");
		const res = await editFileTool.execute({
			path,
			oldString: "b",
			newString: "B",
			lineStart: 2,
		});
		expect(res.success).toBe(true);
		const out = await readFile(path, "utf-8");
		expect(out).toBe("a\r\nB\r\nc\r\nd\r\ne\r\n");
		expect(out.replace(/\r\n/g, "")).not.toContain("\n");
		expect(res.output).toContain("normalized 1 mixed line endings to CRLF");
	});

	it("leaves LF files alone", async () => {
		const path = await fixture("lf.txt", "a\nb\n");
		await editFileTool.execute({ path, oldString: "b", newString: "x\ny", lineStart: 2 });
		expect(await readFile(path, "utf-8")).toBe("a\nx\ny\n");
	});

	it("undo restores the original bytes", async () => {
		const path = await fixture("undo.txt", "a\r\nb\r\n");
		await editFileTool.execute({ path, oldString: "b", newString: "c", lineStart: 2 });
		await undoEditTool.execute({ path });
		expect(await readFile(path, "utf-8")).toBe("a\r\nb\r\n");
	});

	it("creates a new file with the ending of its siblings", async () => {
		await fixture("proj/one.txt", "x\r\ny\r\n");
		const path = join(TMP, "proj", "two.txt");
		const res = await editFileTool.execute({ path, oldString: "", newString: "p\nq\n" });
		expect(res.success).toBe(true);
		expect(await readFile(path, "utf-8")).toBe("p\r\nq\r\n");
	});

	it("creates a file as given when nothing says which ending to use", async () => {
		const path = join(TMP, "fresh", "new.txt");
		await editFileTool.execute({ path, oldString: "", newString: "p\nq\n" });
		expect(await readFile(path, "utf-8")).toBe("p\nq\n");
	});
});

describe("multi_edit keeps the file's line endings", () => {
	it("applies several LF edits to a CRLF file", async () => {
		const path = await fixture("m.js", "a\r\nb\r\nc\r\nd\r\n");
		const res = await multiEditTool.execute({
			path,
			edits: [
				{ oldString: "a", newString: "A", lineStart: 1 },
				{ oldString: "c\nd", newString: "C\nD\nE", lineStart: 3 },
			],
		});
		expect(res.success).toBe(true);
		expect(await readFile(path, "utf-8")).toBe("A\r\nb\r\nC\r\nD\r\nE\r\n");
	});

	it("normalizes a mixed file", async () => {
		const path = await fixture("m2.js", "a\r\nb\nc\r\nd\r\n");
		const res = await multiEditTool.execute({
			path,
			edits: [{ oldString: "d", newString: "D" }],
		});
		expect(res.success).toBe(true);
		expect(await readFile(path, "utf-8")).toBe("a\r\nb\r\nc\r\nD\r\n");
	});
});

describe("read shows the file's line endings", () => {
	it("adds a header for CRLF files and hides the carriage returns", async () => {
		const path = await fixture("r.txt", "one\r\ntwo\r\n");
		const res = await readFileTool.execute({ path });
		expect(res.success).toBe(true);
		expect(res.output.split("\n")[0]).toBe("line endings: CRLF");
		expect(res.output).not.toContain("\r");
		expect(res.output).toMatch(/^\s*2\s+two$/m);
	});

	it("has no header for LF files", async () => {
		const path = await fixture("r2.txt", "one\ntwo\n");
		const res = await readFileTool.execute({ path });
		expect(res.output).not.toContain("line endings");
	});

	it("round-trips: hash from read works as ifHash for an edit", async () => {
		const path = await fixture("r3.txt", "one\r\ntwo\r\n");
		const read = await readFileTool.execute({ path });
		const hash = read.output.match(/hash:(\w+)/)?.[1];
		expect(hash).toBeDefined();
		const res = await editFileTool.execute({
			path,
			oldString: "two",
			newString: "2",
			lineStart: 2,
			ifHash: hash,
		});
		expect(res.success).toBe(true);
		expect(await readFile(path, "utf-8")).toBe("one\r\n2\r\n");
	});
});
