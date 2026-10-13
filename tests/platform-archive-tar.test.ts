import { describe, expect, test } from "bun:test";
import { tarCommand } from "../src/core/platform/archive";

describe("tarCommand", () => {
  test("POSIX runs tar from PATH", () => {
    expect(tarCommand(false, undefined, () => true)).toBe("tar");
  });

  test("Windows runs the system bsdtar by absolute path, not GNU tar from Git Bash", () => {
    expect(tarCommand(true, "C:\\Windows", () => true)).toBe("C:\\Windows\\System32\\tar.exe");
  });

  test("Windows without the system tar falls back to PATH", () => {
    expect(tarCommand(true, "C:\\Windows", () => false)).toBe("tar");
  });
});
