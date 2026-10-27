import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitMode } from "../src/core/workflows/delivery-git.js";

// #2331: a Windows working tree has no executable bit (mode 0644 here), so a new launcher took
// `100644` and failed a Unix CI. A new file's mode also comes from its shebang.
const encode = (text: string) => new TextEncoder().encode(text);

describe("the mode of a new file (#2331)", () => {
  const launchers: Record<string, string> = {
    ruby: "#!/usr/bin/env ruby\nrequire 'callmend'\n",
    python: "#!/usr/bin/env python3\nimport sys\n",
    shell: "#!/bin/sh\nset -eu\n",
    php: "#!/usr/bin/env php\n<?php echo 1;\n",
    r: "#!/usr/bin/env Rscript\ncat(1)\n",
    typescript: "#!/usr/bin/env bun\nconsole.log(1);\n",
    lua: "#!/usr/bin/env lua\nprint(1)\n",
    powershell: "#!/usr/bin/env pwsh\nWrite-Output 1\n",
  };
  for (const [language, text] of Object.entries(launchers))
    test(`${language}: a launcher with a shebang is executable on a tree without the bit`, () => {
      expect(gitMode(0o100644, encode(text))).toBe("100755");
    });

  test("a file without a shebang keeps the working tree's mode", () => {
    expect(gitMode(0o100644, encode("puts 1\n"))).toBe("100644");
    expect(gitMode(0o100644, encode("﻿#!/bin/sh\n"))).toBe("100644");
    expect(gitMode(0o100644, encode("#"))).toBe("100644");
    expect(gitMode(0o100644, null)).toBe("100644");
    expect(gitMode(0o100755, encode("binary"))).toBe("100755");
  });

  // Every commit path takes a content file's mode from `gitMode` or the baseline's tree, never from
  // a literal: the literals left are the type, the tree reader, BAKED's own spec files and the
  // fallback of a modified file the baseline has.
  test("no workflow source writes a literal 100644 for a content file outside the named exceptions", () => {
    const allowed: Record<string, number> = {
      "delivery-git.ts": 6,
      "delivery.ts": 3,
      "worktree.ts": 1,
    };
    const dir = join(import.meta.dir, "..", "src", "core", "workflows");
    const counts: Record<string, number> = {};
    for (const name of readdirSync(dir, { recursive: true }) as string[]) {
      if (!name.endsWith(".ts")) continue;
      const found = readFileSync(join(dir, name), "utf8").match(/100644/g)?.length ?? 0;
      if (found) counts[name.replaceAll("\\", "/")] = found;
    }
    expect(counts).toEqual(allowed);
  });
});
