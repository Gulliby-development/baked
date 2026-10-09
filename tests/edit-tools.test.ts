import { describe, expect, it } from "bun:test";
import { fuzzyWhitespaceMatch } from "../src/core/tools/edit-file.js";

// ════════════════════════════════════════════════════════════
// fuzzyWhitespaceMatch — escape-aware normalization (Level 2)
// ════════════════════════════════════════════════════════════

describe("fuzzyWhitespaceMatch — escape normalization", () => {
	it("matches when oldStr has extra backslash escaping", () => {
		const content = '  .replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&")';
		// Model sends double-escaped version (JSON corruption)
		const oldStr = '  .replace(/[.+^${}()|\\\\[\\\\]\\\\\\\\]/g, "\\\\\\\\$&")';
		const newStr = '  .replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&") // fixed';
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
		if (result) {
			expect(result.oldStr).toBe(content);
		}
	});

	it("matches when backslashes are collapsed (\\\\\\\\→\\\\)", () => {
		const content = 'const path = "C:\\\\Users\\\\test";';
		const oldStr = 'const path = "C:\\\\\\\\Users\\\\\\\\test";';
		const newStr = 'const path = "C:\\\\Users\\\\admin";';
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
	});

	it("matches regex character classes with bracket escaping", () => {
		const content = "const RE = /[\\w.-]+@[\\w.-]+/;";
		const oldStr = "const RE = /[\\\\w.-]+@[\\\\w.-]+/;";
		const newStr = "const RE = /[\\w.+-]+@[\\w.-]+/;";
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
	});

	it("still matches with whitespace normalization (level 1)", () => {
		const content = "\t\tconst x = 1;";
		const oldStr = "    const x = 1;";
		const newStr = "    const x = 2;";
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
		if (result) {
			expect(result.oldStr).toBe("\t\tconst x = 1;");
			expect(result.newStr).toBe("\t\tconst x = 2;");
		}
	});

	it("returns null when content genuinely differs", () => {
		const content = "const a = 1;";
		const oldStr = "const b = 2;";
		const newStr = "const b = 3;";
		expect(fuzzyWhitespaceMatch(content, oldStr, newStr)).toBeNull();
	});

	it("handles multi-line regex content", () => {
		const content = [
			"const re = pattern",
			'  .replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&")',
			'  .replace(/\\*\\*/g, "STAR")',
		].join("\n");
		// Model double-escapes the regex line
		const oldStr = [
			"const re = pattern",
			'  .replace(/[.+^${}()|\\\\[\\\\]\\\\\\\\]/g, "\\\\\\\\$&")',
			'  .replace(/\\\\*\\\\*/g, "STAR")',
		].join("\n");
		const newStr = [
			"const re = pattern",
			'  .replace(/[.+^${}()|[\\]\\\\]/g, "\\\\$&") // fixed',
			'  .replace(/\\*\\*/g, "STAR")',
		].join("\n");
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
	});

	it("does not false-match unrelated content", () => {
		const content = "console.log('hello');\nconsole.log('world');";
		const oldStr = "console.log('foo');";
		const newStr = "console.log('bar');";
		expect(fuzzyWhitespaceMatch(content, oldStr, newStr)).toBeNull();
	});

	it("matches when oldStr has escaped backticks from LLM markdown corruption", () => {
		const content = "    parts.push(`done ${count} items`);";
		const oldStr = "    parts.push(\\`done ${count} items\\`);";
		const newStr = "    parts.push(`finished ${count} items`);";
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
		expect(result!.oldStr).toBe(content);
	});

	it("matches multi-line template literals with escaped backticks", () => {
		const content = "  const msg = `hello ${name},\n  welcome to ${place}`;\n  return msg;";
		const oldStr = "  const msg = \\`hello ${name},\n  welcome to ${place}\\`;\n  return msg;";
		const newStr = "  const msg = `hi ${name},\n  welcome to ${place}`;\n  return msg;";
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
		expect(result!.oldStr).toBe(content);
	});

	it("matches Ruby string interpolation with escaped hash", () => {
		const content = '  puts "Hello #{name}, you have #{count} items"';
		const oldStr = '  puts "Hello \\#{name}, you have \\#{count} items"';
		const newStr = '  puts "Hi #{name}, you have #{count} items"';
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
		expect(result!.oldStr).toBe(content);
	});

	it("matches shell single quotes with escaped apostrophe", () => {
		const content = "  echo 'it\\'s working'";
		const oldStr = "  echo \\'it\\'s working\\'";
		const newStr = "  echo 'it\\'s done'";
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
	});

	it("matches markdown-like content with escaped tilde", () => {
		const content = "  const re = /~[^~]+~/g;";
		const oldStr = "  const re = /\\~[^\\~]+\\~/g;";
		const newStr = "  const re = /~[^~]*~/g;";
		const result = fuzzyWhitespaceMatch(content, oldStr, newStr);
		expect(result).not.toBeNull();
	});
});

// ════════════════════════════════════════════════════════════
// Line-based editing logic (unit tests via direct string manipulation)
// These test the same algorithm used in edit_file and multi_edit
// without requiring the full tool infrastructure
// ════════════════════════════════════════════════════════════

function lineReplace(
	content: string,
	lineStart: number,
	oldStr: string,
	newStr: string,
	lineEnd?: number,
): string {
	const lines = content.split("\n");
	const oldLineCount = oldStr.split("\n").length;
	const start = lineStart - 1;
	const end = lineEnd != null ? lineEnd : start + oldLineCount;
	const before = lines.slice(0, start);
	const after = lines.slice(end);
	return [...before, ...newStr.split("\n"), ...after].join("\n");
}

describe("lineReplace — basic", () => {
	it("replaces a single line", () => {
		const content = "a\nb\nc";
		expect(lineReplace(content, 2, "b", "B")).toBe("a\nB\nc");
	});

	it("replaces multiple lines", () => {
		const content = "a\nb\nc\nd\ne";
		expect(lineReplace(content, 2, "b\nc\nd", "X\nY")).toBe("a\nX\nY\ne");
	});

	it("replaces first line", () => {
		expect(lineReplace("first\nsecond", 1, "first", "FIRST")).toBe("FIRST\nsecond");
	});

	it("replaces last line", () => {
		expect(lineReplace("a\nb\nc", 3, "c", "C")).toBe("a\nb\nC");
	});

	it("inserts lines (1→3)", () => {
		const content = "a\nb\nc";
		expect(lineReplace(content, 2, "b", "b1\nb2\nb3")).toBe("a\nb1\nb2\nb3\nc");
	});

	it("removes lines (3→1)", () => {
		const content = "a\nb\nc\nd\ne";
		expect(lineReplace(content, 2, "b\nc\nd", "BCD")).toBe("a\nBCD\ne");
	});
});

// ════════════════════════════════════════════════════════════
// lineOffset drift (multi_edit algorithm)
// ════════════════════════════════════════════════════════════

function multiLineReplace(
	content: string,
	edits: Array<{ lineStart: number; oldStr: string; newStr: string }>,
): string {
	let lineOffset = 0;
	let result = content;
	for (const edit of edits) {
		const adjustedStart = edit.lineStart + lineOffset;
		const oldLineCount = edit.oldStr.split("\n").length;
		const newLineCount = edit.newStr.split("\n").length;
		result = lineReplace(result, adjustedStart, edit.oldStr, edit.newStr);
		lineOffset += newLineCount - oldLineCount;
	}
	return result;
}

describe("multiLineReplace — lineOffset drift", () => {
	it("handles adding lines before later edit", () => {
		const content = "L1\nL2\nL3\nL4\nL5";
		const result = multiLineReplace(content, [
			{ lineStart: 2, oldStr: "L2", newStr: "L2A\nL2B\nL2C" },
			{ lineStart: 4, oldStr: "L4", newStr: "L4_NEW" },
		]);
		expect(result).toBe("L1\nL2A\nL2B\nL2C\nL3\nL4_NEW\nL5");
	});

	it("handles removing lines before later edit", () => {
		const content = "L1\nL2\nL3\nL4\nL5\nL6\nL7";
		const result = multiLineReplace(content, [
			{ lineStart: 2, oldStr: "L2\nL3\nL4", newStr: "X" },
			{ lineStart: 6, oldStr: "L6", newStr: "L6_NEW" },
		]);
		expect(result).toBe("L1\nX\nL5\nL6_NEW\nL7");
	});

	it("handles three edits with cumulative drift", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
		const content = lines.join("\n");
		const result = multiLineReplace(content, [
			{ lineStart: 2, oldStr: "L2", newStr: "A\nB" },       // +1 line
			{ lineStart: 5, oldStr: "L5", newStr: "C\nD\nE" },    // +2 lines
			{ lineStart: 8, oldStr: "L8\nL9", newStr: "F" },      // -1 line
		]);
		// After edit 1: L1 A B L3 L4 L5 L6 L7 L8 L9 L10 (11 lines)
		// After edit 2 (5+1=6): L1 A B L3 L4 C D E L6 L7 L8 L9 L10 (13 lines)
		// After edit 3 (8+1+2=11): L1 A B L3 L4 C D E L6 L7 F L10 (12 lines)
		expect(result).toContain("A\nB");
		expect(result).toContain("C\nD\nE");
		expect(result).toContain("F");
		expect(result).not.toContain("L2");
		expect(result).not.toContain("L5");
		expect(result).not.toContain("L8");
		expect(result).not.toContain("L9");
	});

	it("handles zero-delta edits (no drift)", () => {
		const content = "A\nB\nC\nD\nE";
		const result = multiLineReplace(content, [
			{ lineStart: 2, oldStr: "B", newStr: "X" },
			{ lineStart: 4, oldStr: "D", newStr: "Y" },
		]);
		expect(result).toBe("A\nX\nC\nY\nE");
	});
});

// ════════════════════════════════════════════════════════════
// Language-specific escape patterns
// ════════════════════════════════════════════════════════════

describe("lineReplace — language-specific escapes", () => {
	it("TypeScript regex with character classes", () => {
		const content = [
			"function escapeRegex(s: string): string {",
			'  return s.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");',
			"}",
		].join("\n");
		const result = lineReplace(
			content,
			2,
			'  return s.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");',
			'  return s.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"); // escape special chars',
		);
		expect(result).toContain("// escape special chars");
	});

	it("Python regex with raw strings", () => {
		const content = [
			"import re",
			"",
			"PHONE = re.compile(r'\\d{3}[.-]\\d{3}[.-]\\d{4}')",
			"EMAIL = re.compile(r'[\\w.-]+@[\\w.-]+\\.[a-z]{2,}')",
		].join("\n");
		const result = lineReplace(
			content,
			3,
			"PHONE = re.compile(r'\\d{3}[.-]\\d{3}[.-]\\d{4}')",
			"PHONE = re.compile(r'\\+?\\d{1,3}[.-]\\d{3}[.-]\\d{4}')",
		);
		expect(result).toContain("\\+?\\d{1,3}");
	});

	it("Go regex with backtick strings", () => {
		const content = [
			"package main",
			"",
			"var emailRe = regexp.MustCompile(`[\\w.-]+@[\\w.-]+\\.[a-z]{2,}`)",
		].join("\n");
		const result = lineReplace(
			content,
			3,
			"var emailRe = regexp.MustCompile(`[\\w.-]+@[\\w.-]+\\.[a-z]{2,}`)",
			"var emailRe = regexp.MustCompile(`[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}`)",
		);
		expect(result).toContain("[\\w.+-]");
	});

	it("Rust regex", () => {
		const content = [
			"fn main() {",
			'    let re = Regex::new(r"\\d{3}-\\d{3}-\\d{4}").unwrap();',
			'    let path = r"C:\\Users\\test";',
			"}",
		].join("\n");
		const result = lineReplace(
			content,
			2,
			'    let re = Regex::new(r"\\d{3}-\\d{3}-\\d{4}").unwrap();',
			'    let re = Regex::new(r"\\d{3}[.-]\\d{3}[.-]\\d{4}").unwrap();',
		);
		expect(result).toContain("[.-]");
	});

	it("JSON with nested escapes", () => {
		const content = [
			"{",
			'  "pattern": "\\\\d+\\\\.\\\\d+",',
			'  "replacement": "\\\\$1.\\\\$2"',
			"}",
		].join("\n");
		const result = lineReplace(
			content,
			2,
			'  "pattern": "\\\\d+\\\\.\\\\d+",',
			'  "pattern": "\\\\d+\\\\.\\\\d+\\\\.\\\\d+",',
		);
		expect(result).toContain('\\\\.\\\\d+",');
	});

	it("Shell script with special chars", () => {
		const content = [
			"#!/bin/bash",
			'PATTERN="$HOME/.config/*/settings.json"',
			"for f in $PATTERN; do",
			'  grep -P "\\w+" "$f"',
			"done",
		].join("\n");
		const result = lineReplace(
			content,
			4,
			'  grep -P "\\w+" "$f"',
			'  grep -P "\\w+@\\w+" "$f"',
		);
		expect(result).toContain("\\w+@\\w+");
	});

	it("C++ raw string literal", () => {
		const content = [
			"#include <regex>",
			'auto re = std::regex(R"(\\d{3}-\\d{4})");',
			'auto path = R"(C:\\Users\\test)";',
		].join("\n");
		const result = lineReplace(
			content,
			2,
			'auto re = std::regex(R"(\\d{3}-\\d{4})");',
			'auto re = std::regex(R"(\\d{3}[.-]\\d{4})");',
		);
		expect(result).toContain("[.-]");
	});

	it("YAML with anchors and special values", () => {
		const content = [
			"defaults: &defaults",
			"  adapter: postgres",
			"  host: localhost",
			"",
			"production:",
			"  <<: *defaults",
			"  host: db.production.internal",
		].join("\n");
		const result = lineReplace(
			content,
			7,
			"  host: db.production.internal",
			"  host: db.prod.us-east-1.internal",
		);
		expect(result).toContain("us-east-1");
	});
});

// ════════════════════════════════════════════════════════════
// Edge cases
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
// BUG REPRODUCTIONS: lineStart must be authoritative
// These reproduce the exact bugs hit during the bake-analyze editing session
// where oldString matched at line 151 instead of the intended line 815.
// ════════════════════════════════════════════════════════════

describe("lineReplace — lineStart is authoritative over oldString", () => {
	it("replaces at lineStart even when oldString matches earlier in file", () => {
		// Simulates: file has `return result;` at line 3 AND line 7
		// Agent wants to edit line 7, provides lineStart=7
		const content = [
			"function a() {",      // 1
			"  const x = 1;",      // 2
			"  return result;",     // 3  ← oldString matches here too
			"}",                    // 4
			"function b() {",      // 5
			"  const y = 2;",      // 6
			"  return result;",     // 7  ← intended target
			"}",                    // 8
		].join("\n");

		// Line-based replacement at line 7 should NOT touch line 3
		const result = lineReplace(content, 7, "  return result;", "  return newResult;");
		const lines = result.split("\n");
		expect(lines[2]).toBe("  return result;");    // line 3 untouched
		expect(lines[6]).toBe("  return newResult;"); // line 7 replaced
	});

	it("replaces at end of file when same pattern exists at start", () => {
		// Exact reproduction of the bake-analyze bug:
		// `return { success: true, output: lines.join("\\n") };\n}` at both
		// line 152 (inside identifierFrequency) and line 815 (end of symbolSummaries)
		const content = [
			"function identifierFrequency() {",  // 1
			"  if (name) {",                      // 2
			"    return { success: true };",       // 3  ← pattern here
			"  }",                                 // 4
			"  return other;",                     // 5
			"}",                                   // 6
			"",                                    // 7
			"function symbolSummaries() {",        // 8
			"  return { success: true };",          // 9  ← intended target
			"}",                                   // 10
		].join("\n");

		const result = lineReplace(content, 9, "  return { success: true };", "  return { success: true };\n}\n\nfunction newFunc() {\n  return 42;\n}");
		const lines = result.split("\n");
		// Line 3 must be untouched
		expect(lines[2]).toBe("    return { success: true };");
		// Line 9 should have the replacement
		expect(lines[8]).toBe("  return { success: true };");
		expect(result).toContain("function newFunc()");
	});
});

describe("multiLineReplace — lineStart is authoritative over oldString", () => {
	it("multi_edit replaces at correct location with duplicate patterns", () => {
		const content = [
			"const a = 1;",   // 1
			"return x;",      // 2  ← duplicate
			"const b = 2;",   // 3
			"return x;",      // 4  ← duplicate (target)
			"const c = 3;",   // 5
		].join("\n");

		// Edit at line 4, not line 2
		const result = multiLineReplace(content, [
			{ lineStart: 4, oldStr: "return x;", newStr: "return y;" },
		]);
		const lines = result.split("\n");
		expect(lines[1]).toBe("return x;");  // line 2 untouched
		expect(lines[3]).toBe("return y;");  // line 4 replaced
	});

	it("multi_edit handles two edits targeting different occurrences of same pattern", () => {
		const content = [
			"// block A",     // 1
			"return x;",      // 2
			"// block B",     // 3
			"return x;",      // 4
			"// block C",     // 5
			"return x;",      // 6
		].join("\n");

		const result = multiLineReplace(content, [
			{ lineStart: 2, oldStr: "return x;", newStr: "return a;" },
			{ lineStart: 6, oldStr: "return x;", newStr: "return c;" },
		]);
		const lines = result.split("\n");
		expect(lines[1]).toBe("return a;");  // line 2
		expect(lines[3]).toBe("return x;");  // line 4 untouched
		expect(lines[5]).toBe("return c;");  // line 6
	});
});

describe("lineReplace — edge cases", () => {
	it("empty replacement (delete line)", () => {
		expect(lineReplace("a\nb\nc", 2, "b", "")).toBe("a\n\nc");
	});

	it("replace with more lines than original", () => {
		const result = lineReplace("a\nb\nc", 2, "b", "x\ny\nz\nw");
		expect(result).toBe("a\nx\ny\nz\nw\nc");
	});

	it("single line file", () => {
		expect(lineReplace("only", 1, "only", "replaced")).toBe("replaced");
	});

	it("handles trailing newline", () => {
		expect(lineReplace("a\nb\nc\n", 2, "b", "B")).toBe("a\nB\nc\n");
	});

	it("explicit lineEnd overrides oldStr line count", () => {
		const content = "a\nb\nc\nd\ne";
		const result = lineReplace(content, 2, "ignored", "X", 4);
		expect(result).toBe("a\nX\ne");
	});
});
