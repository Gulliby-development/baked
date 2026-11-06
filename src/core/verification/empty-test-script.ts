import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { isTestCheck } from "../workflows/quality/mutation.js";
import { toolchainCommand } from "../workflows/toolchain.js";
import type { Check } from "../workflows/types.js";

/**
 * A test check that runs one test script with its language's interpreter, not a test runner:
 * `php tests/run.php`, `python tests/run.py`, `node tests/run.js`, `bash tests/run.sh` (#2611).
 * Such a command prints nothing a test counter reads, so a script that holds no code passes it
 * with exit 0 and no output. php-wordcount (cloud smoke 2026-11-01): the test task's
 * `tests/run.php` was 0 bytes, and `php-tests` accepted it. Each row names the interpreters, the
 * script extensions, and the comment and boilerplate forms that run no code in that language.
 */
const SCRIPT_LANGUAGES: readonly {
  programs: RegExp;
  extensions: readonly string[];
  /** Comments and lines that run nothing: an opening tag, a strict-mode pragma. */
  inert: readonly RegExp[];
  /** The arguments before the script that mean the code is not in a file: `-c`, `-e`, `-m`. */
  inline: RegExp;
  /** A subcommand the interpreter takes before the script: `bun run`, `deno run`. */
  subcommand?: string;
}[] = [
  {
    programs: /^php$/,
    extensions: [".php"],
    inert: [
      /\/\*[\s\S]*?\*\//g,
      /(?:\/\/|#(?!\[)).*$/gm,
      /<\?php\b|\?>/g,
      /^\s*declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;/gm,
    ],
    inline: /^-[rRBE]$/,
  },
  {
    programs: /^(?:python[\d.]*|py|pypy[\d.]*)$/,
    extensions: [".py"],
    inert: [
      /^[ \t]*[rbuf]*("""|''')[\s\S]*?\1/gim,
      /#.*$/gm,
      /^\s*from\s+__future__\s+import\b.*$/gm,
    ],
    inline: /^-[cm]$/,
  },
  {
    programs: /^(?:node|bun|deno|tsx|ts-node)$/,
    extensions: [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"],
    inert: [/\/\*[\s\S]*?\*\//g, /\/\/.*$/gm, /^#!.*$/m, /^\s*["']use strict["'];?/gm],
    inline: /^-(?:e|p|-eval|-print)$/,
  },
  {
    programs: /^(?:bash|sh|zsh|dash|ksh)$/,
    extensions: [".sh", ".bash", ".zsh"],
    inert: [/#.*$/gm, /^[ \t]*set[ \t]+[-+][\w \t-]*$/gm],
    inline: /^-c$/,
  },
  {
    programs: /^ruby$/,
    extensions: [".rb"],
    inert: [/^=begin\b[\s\S]*?^=end\b.*$/gm, /#.*$/gm],
    inline: /^-e$/,
  },
  {
    programs: /^perl$/,
    extensions: [".pl", ".t"],
    inert: [/^=\w+[\s\S]*?^=cut\b.*$/gm, /#.*$/gm, /^\s*use\s+(?:strict|warnings)\s*;/gm],
    inline: /^-[eE]$/,
  },
  {
    programs: /^rscript$/i,
    extensions: [".r"],
    inert: [/#.*$/gm],
    inline: /^-e$/,
  },
  {
    programs: /^lua(?:jit|[\d.]*)$/,
    extensions: [".lua"],
    inert: [/--\[(=*)\[[\s\S]*?\]\1\]/g, /--.*$/gm, /^#!.*$/m],
    inline: /^-e$/,
  },
  {
    programs: /^(?:pwsh|powershell)$/i,
    extensions: [".ps1"],
    inert: [
      /<#[\s\S]*?#>/g,
      /#.*$/gm,
      /^\s*Set-StrictMode\b.*$/gim,
      /^\s*\$ErrorActionPreference\s*=.*$/gim,
    ],
    inline: /^-(?:c|command|encodedcommand|ec)$/i,
  },
];

/** The options of an interpreter that take a value before the script: `php -c php.ini`, `pwsh -ExecutionPolicy Bypass`. */
const VALUE_OPTION = /^-(?:c|d|executionpolicy|ep|r|-require|-import|-loader)$/i;

/**
 * The script a plain-script test check runs and its language row, or null when the check runs a
 * test runner, inline code or no test.
 */
function testScript(
  check: Pick<Check, "id" | "executable" | "args">,
): { path: string; inert: readonly RegExp[] } | null {
  if (!isTestCheck(check)) return null;
  const { program, args } = toolchainCommand(check.executable, check.args);
  const name = program.replace(/\.exe$/i, "");
  const language = SCRIPT_LANGUAGES.find((row) => row.programs.test(name));
  if (!language) return null;
  let rest = args;
  if ((name === "bun" || name === "deno") && rest[0] === "run") rest = rest.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (language.inline.test(arg)) return null;
    if (/^-file$/i.test(arg)) continue;
    if (arg.startsWith("-")) {
      // `php -c php.ini` and the PowerShell value options: skip the value too. php's `-c` is a
      // config file, python's `-c` is inline code, so the inline test above runs first.
      if (VALUE_OPTION.test(arg) && !arg.includes("=")) i++;
      continue;
    }
    return language.extensions.includes(extname(arg).toLowerCase())
      ? { path: arg, inert: language.inert }
      : null;
  }
  return null;
}

/**
 * The script of a plain-script test check that holds no code once its comments and inert lines
 * are removed, relative to the check's directory, or null (#2611). It runs no test, so a check
 * that exits 0 on it verified nothing. A script the host cannot read is not taken as empty.
 */
export function emptyTestScript(
  check: Pick<Check, "id" | "executable" | "args">,
  cwd: string,
): string | null {
  const script = testScript(check);
  if (!script) return null;
  let text: string;
  try {
    text = readFileSync(join(cwd, script.path), "utf8");
  } catch {
    return null;
  }
  const code = script.inert.reduce((left, pattern) => left.replace(pattern, ""), text);
  return code.replace(/^﻿/, "").trim() ? null : script.path;
}

/** The note a check run on an empty test script gets; its "no tests ran" is what `noTestsCollected` reads. */
export const emptyScriptNote = (check: Pick<Check, "id">, script: string): string =>
  `Note: ${check.id} exited 0, but no tests ran: ${script} holds no code, so it verified nothing. Write the tests in ${script} so each one fails the script (a nonzero exit) when its expectation does not hold.`;
