/**
 * The program a check runs when it starts through a shell or batch launcher (#1507): `cmd /c mvn
 * -B -q verify`, `cmd.exe /d /s /c "mvn verify"`, `sh -c "pytest -q"`, `bash -lc "go test ./..."`,
 * `pwsh -NoProfile -Command "dotnet test"`. Routing that reads only the executable name saw `cmd`
 * and derived no task-end test check and no mutation gate in 7 of 7 fecsmith features (bench round
 * 42). A launched line with shell syntax (`&&`, pipes, redirections, variables) is not unwrapped:
 * what it runs is up to the shell.
 */
export interface LaunchedCommand {
  /** The file name of the program that runs, lowercase, without directories or `.exe`/`.cmd`/`.bat`. */
  program: string;
  /** Its arguments. */
  args: string[];
  /**
   * The command that runs `args` (and `program`, when given) through the same launcher, or null when
   * a word cannot be passed through it unchanged.
   */
  launch(args: string[], program?: string): { executable: string; args: string[] } | null;
}

/** A program's file name without directories, `.exe`, `.cmd` or `.bat`, lowercase. */
export const programName = (executable: string): string =>
  executable
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
/** Characters that make a launched line more than one program and its words. */
const SHELL_SYNTAX = {
  cmd: /[&|<>^%()\r\n]/,
  posix: /[&|<>;$`(){}*?[\]~#!\r\n\\]/,
  powershell: /[&|<>;$`(){}@,\r\n]/,
};
/** Words a launched line passes unquoted. */
const PLAIN = /^[A-Za-z0-9_./:=+@-]+$/;
/**
 * Words cmd.exe passes on unchanged. cmd.exe has no quoting that survives being passed as one
 * argument, so a word with anything else is not launched through it.
 */
const CMD_PLAIN = /^[A-Za-z0-9_./:=+@,~\\-]+$/;

type Kind = keyof typeof SHELL_SYNTAX;

/** The words of a launched line, or null when it holds shell syntax or an unclosed quote. */
function splitLine(line: string, kind: Kind): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const char of line) {
    if (quote) {
      // Inside double quotes cmd.exe still expands `%`, a POSIX shell and PowerShell `$` and `.
      if (quote === '"' && (kind === "cmd" ? char === "%" : char === "$" || char === "`"))
        return null;
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || (char === "'" && kind !== "cmd")) {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (SHELL_SYNTAX[kind].test(char)) return null;
    else word = (word ?? "") + char;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words.length ? words : null;
}

/** One word of a launched line, quoted when it is not plain, or null when it cannot be. */
function quoteWord(word: string, kind: Kind): string | null {
  if (kind === "cmd") return CMD_PLAIN.test(word) ? word : null;
  if (PLAIN.test(word)) return word;
  if (/[\r\n]/.test(word)) return null;
  return kind === "posix"
    ? `'${word.replaceAll("'", `'\\''`)}'`
    : `'${word.replaceAll("'", "''")}'`;
}

/** Where a launcher's command starts in its arguments, or null when it does not run one. */
function commandIndex(name: string, args: string[]): { at: number; kind: Kind } | null {
  if (name === "cmd") {
    const at = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
    if (at === -1 || !args.slice(0, at).every((arg) => /^\/[a-z]$/i.test(arg))) return null;
    return { at: at + 1, kind: "cmd" };
  }
  if (POSIX_SHELLS.has(name)) {
    const at = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (at === -1 || !args.slice(0, at).every((arg) => /^-/.test(arg))) return null;
    // `sh -c line` runs one line; further arguments become its positional parameters.
    return at + 2 === args.length ? { at: at + 1, kind: "posix" } : null;
  }
  if (POWERSHELLS.has(name)) {
    const at = args.findIndex((arg) => /^-(?:c|command)$/i.test(arg));
    return at === -1 ? null : { at: at + 1, kind: "powershell" };
  }
  return null;
}

/** The program a check runs, through at most two launchers (`cmd /c sh -c ...`). */
export function launchedCommand(executable: string, args: readonly string[]): LaunchedCommand {
  const direct: LaunchedCommand = {
    program: programName(executable),
    args: [...args],
    launch: (next, program) => ({ executable: program ?? executable, args: next }),
  };
  return unwrap(direct, 2);
}

function unwrap(outer: LaunchedCommand, depth: number): LaunchedCommand {
  if (depth === 0) return outer;
  const found = commandIndex(outer.program, outer.args);
  if (!found || found.at >= outer.args.length) return outer;
  const head = outer.args.slice(0, found.at);
  const rest = outer.args.slice(found.at);
  // One argument is a command line to split; several are already its words (`cmd /c mvn -B verify`).
  const single = rest.length === 1;
  // cmd.exe drops the quotes around a whole `/s /c "..."` line before it reads it.
  const line =
    found.kind === "cmd" ? (rest[0] as string).replace(/^"(.*)"$/s, "$1") : (rest[0] as string);
  const words = single ? splitLine(line, found.kind) : rest;
  if (!words || words.some((word) => SHELL_SYNTAX[found.kind].test(word) && !single)) return outer;
  const [program, ...inner] = words as [string, ...string[]];
  const launch = (next: string[], replaced?: string) => {
    const all = [replaced ?? program, ...next];
    const quoted = all.map((word) => quoteWord(word, found.kind));
    if (quoted.some((word) => word === null)) return null;
    return outer.launch(single ? [...head, quoted.join(" ")] : [...head, ...(quoted as string[])]);
  };
  return unwrap({ program: programName(program), args: inner, launch }, depth - 1);
}
