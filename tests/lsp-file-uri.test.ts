import { describe, expect, it } from "bun:test";
import {
  filePathToUri,
  uriToFilePath,
} from "../src/core/intelligence/backends/lsp/protocol.js";
import { IS_WIN } from "../src/core/platform/index.js";

describe("filePathToUri", () => {
  it("gives a Windows drive path an empty authority", () => {
    // `file://C:/proj/a.ts` names `C:` as the host; servers read it as the UNC path `\\C:\proj\a.ts`.
    expect(filePathToUri("C:\\proj\\src\\a.ts")).toBe("file:///C:/proj/src/a.ts");
    expect(filePathToUri("C:/proj/src/a.ts")).toBe("file:///C:/proj/src/a.ts");
    expect(filePathToUri("d:\\My Code\\x.ts")).toBe("file:///d:/My%20Code/x.ts");
  });

  it("keeps POSIX paths as before", () => {
    expect(filePathToUri("/home/u/proj/a.ts")).toBe("file:///home/u/proj/a.ts");
    expect(filePathToUri("/home/u/my proj/a.ts")).toBe("file:///home/u/my%20proj/a.ts");
  });

  it("round-trips through uriToFilePath", () => {
    expect(uriToFilePath(filePathToUri("/home/u/my proj/a.ts"))).toBe("/home/u/my proj/a.ts");
    if (IS_WIN) expect(uriToFilePath(filePathToUri("C:\\proj\\a.ts"))).toBe("C:/proj/a.ts");
  });
});
