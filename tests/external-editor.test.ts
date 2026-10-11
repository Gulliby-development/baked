import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  editorInvocation,
  editTextInEditor,
  onInputEditorRequest,
  requestInputEditor,
  resolveEditor,
} from "../src/core/chat/external-editor.js";

const none = () => false;

describe("resolveEditor", () => {
  test("prefers $VISUAL, then $EDITOR", () => {
    expect(resolveEditor({ env: { VISUAL: "code --wait", EDITOR: "vim" }, exists: none })).toEqual({
      command: "code --wait",
      source: "VISUAL",
    });
    expect(resolveEditor({ env: { EDITOR: " hx " }, exists: none })).toEqual({
      command: "hx",
      source: "EDITOR",
    });
  });

  test("falls back to Notepad on Windows and the first editor on PATH elsewhere", () => {
    expect(resolveEditor({ env: {}, platform: "win32", exists: none })?.command).toBe("notepad");
    const onPath = (bin: string) => bin === "vi";
    expect(resolveEditor({ env: {}, platform: "linux", exists: onPath })?.command).toBe("vi");
    expect(resolveEditor({ env: {}, platform: "darwin", exists: () => true })?.command).toBe("nano");
    expect(resolveEditor({ env: {}, platform: "linux", exists: none })).toBeNull();
  });
});

describe("editorInvocation", () => {
  test("passes the file as $1 through sh on POSIX", () => {
    expect(editorInvocation("code --wait", "/tmp/x/prompt.md", "linux")).toEqual({
      cmd: "sh",
      args: ["-c", 'code --wait "$1"', "sh", "/tmp/x/prompt.md"],
      shell: false,
    });
  });

  test("quotes the file for cmd on Windows", () => {
    expect(editorInvocation("notepad", "C:\\Temp\\prompt.md", "win32")).toEqual({
      cmd: 'notepad "C:\\Temp\\prompt.md"',
      args: [],
      shell: true,
    });
  });
});

describe("editTextInEditor", () => {
  const fileOf = (inv: { cmd: string; args: string[] }) => inv.args.at(-1) ?? "";

  test("returns the saved text and hands the terminal over around the editor", async () => {
    const calls: string[] = [];
    const result = await editTextInEditor("draft", {
      env: { EDITOR: "fake" },
      platform: "linux",
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
      run: async (inv) => {
        calls.push("run");
        expect(readFileSync(fileOf(inv), "utf8")).toBe("draft");
        writeFileSync(fileOf(inv), "edited\r\nsecond line\n");
        return 0;
      },
    });
    expect(result).toEqual({ status: "saved", text: "edited\nsecond line" });
    expect(calls).toEqual(["suspend", "run", "resume"]);
  });

  test("cancels on a non-zero exit or an empty file", async () => {
    const failed = await editTextInEditor("draft", {
      env: { EDITOR: "fake" },
      platform: "linux",
      run: async () => 1,
    });
    expect(failed.status).toBe("cancelled");
    const emptied = await editTextInEditor("draft", {
      env: { EDITOR: "fake" },
      platform: "linux",
      run: async (inv) => {
        writeFileSync(fileOf(inv), "  \n");
        return 0;
      },
    });
    expect(emptied.status).toBe("cancelled");
  });

  test("resumes the terminal and reports an editor that cannot start", async () => {
    let resumed = 0;
    const result = await editTextInEditor("draft", {
      env: { EDITOR: "fake" },
      platform: "linux",
      resume: () => resumed++,
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(result).toEqual({ status: "error", message: "Could not run fake: ENOENT" });
    expect(resumed).toBe(1);
  });

  test("reports a missing editor", async () => {
    const result = await editTextInEditor("draft", { env: {}, platform: "linux", exists: none });
    expect(result.status).toBe("error");
  });

  test.skipIf(process.platform === "win32")("runs a real $EDITOR command line", async () => {
    const result = await editTextInEditor("draft", {
      env: { EDITOR: "printf 'from the editor\\n' >" },
    });
    expect(result).toEqual({ status: "saved", text: "from the editor" });
  });
});

test("editor requests reach subscribed inputs until they unsubscribe", () => {
  let hits = 0;
  const off = onInputEditorRequest(() => hits++);
  requestInputEditor();
  off();
  requestInputEditor();
  expect(hits).toBe(1);
});
