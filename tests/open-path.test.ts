import { describe, expect, test } from "bun:test";
import { openCommand } from "../src/core/utils/open-path.js";

const OAUTH =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&state=abc";

describe("openCommand", () => {
  test("opens a web URL with a query on Windows without cmd.exe", () => {
    expect(openCommand(OAUTH, "win32")).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      OAUTH,
    ]);
  });

  test("opens a plain path on Windows through start", () => {
    expect(openCommand("C:\\work\\report.html", "win32")).toEqual([
      "cmd.exe",
      "/c",
      "start",
      "",
      "C:\\work\\report.html",
    ]);
  });

  test("refuses shell metacharacters outside a web URL on Windows", () => {
    expect(openCommand("C:\\a & calc.exe", "win32")).toBeNull();
    expect(openCommand("file:///C:/a%20b", "win32")).toBeNull();
    expect(openCommand('https://example.com/"&calc', "win32")).toBeNull();
    expect(openCommand("https://example.com/a b&c", "win32")).toBeNull();
  });

  test("uses open on macOS and xdg-open on Linux", () => {
    expect(openCommand(OAUTH, "darwin")).toEqual(["open", OAUTH]);
    expect(openCommand(OAUTH, "linux")).toEqual(["xdg-open", OAUTH]);
  });
});
