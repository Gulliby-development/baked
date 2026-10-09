import { describe, expect, test } from "bun:test";
import { stripAbsolutePaths } from "../scripts/strip-paths";

const paths = [
  { prefix: "/root/work/baked", replacement: "" },
  { prefix: "/root", replacement: "~" },
];

describe("stripAbsolutePaths", () => {
  test("keeps relative imports that contain the home directory name", () => {
    const src = "import {root} from './root.js'\nimport x from '../root/index.js'";
    expect(stripAbsolutePaths(src, paths)).toBe(src);
  });

  test("keeps URLs and protocol method names containing the prefix", () => {
    const src = '"https://example.test/docs/API/root" + "notifications/roots/list_changed"';
    expect(stripAbsolutePaths(src, paths)).toBe(src);
  });

  test("keeps longer sibling paths", () => {
    expect(stripAbsolutePaths('"/rootfs/a"', paths)).toBe('"/rootfs/a"');
  });

  test("replaces cwd before home and home with a tilde", () => {
    const src = 'a("/root/work/baked/src/x.ts"); b("/root/.baked/native"); c("/root")';
    expect(stripAbsolutePaths(src, paths)).toBe('a("/src/x.ts"); b("~/.baked/native"); c("~")');
  });

  test("ignores trivial prefixes", () => {
    const src = '"/usr/bin"';
    expect(stripAbsolutePaths(src, [{ prefix: "/", replacement: "~" }])).toBe(src);
  });
});
