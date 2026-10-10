import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  expandCustomCommand,
  expandCustomCommandInput,
  listCustomCommands,
  parseCommandFile,
  splitArguments,
} from "../src/core/commands/custom.js";
import { isBuiltinCommandName } from "../src/core/commands/registry.js";

let root: string;
let home: string;
let cwd: string;

function write(base: string, rel: string, content: string): void {
  const full = join(base, ".baked", "commands", rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baked-custom-commands-"));
  home = join(root, "home");
  cwd = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("custom command files", () => {
  test("loads project and global commands, project wins on a name clash", () => {
    write(home, "review.md", "Global review");
    write(home, "only-global.md", "Global only");
    write(cwd, "review.md", "Project review");

    const commands = listCustomCommands(cwd, { home });
    expect(commands.map((c) => c.name)).toEqual(["/only-global", "/review"]);
    const review = commands.find((c) => c.name === "/review");
    expect(review?.scope).toBe("project");
    expect(review?.body).toBe("Project review");
  });

  test("names nested files with a colon and skips invalid, hidden and non-Markdown files", () => {
    write(cwd, "frontend/Component.md", "Make a component");
    write(cwd, "bad name.md", "skipped");
    write(cwd, ".hidden.md", "skipped");
    write(cwd, "notes.txt", "skipped");
    write(cwd, ".drafts/x.md", "skipped");

    expect(listCustomCommands(cwd, { home }).map((c) => c.name)).toEqual(["/frontend:component"]);
  });

  test("skips files over the size cap", () => {
    write(cwd, "huge.md", "x".repeat(64 * 1024 + 1));
    expect(listCustomCommands(cwd, { home })).toEqual([]);
  });

  test("returns nothing when no command directories exist", () => {
    expect(listCustomCommands(cwd, { home })).toEqual([]);
  });

  test("reads description and argument hint from frontmatter", () => {
    const cmd = parseCommandFile(
      "/fix-ci",
      '---\ndescription: "Fix the failing CI job"\nargument-hint: <job>\nmodel: ignored\n---\nFix $1\n',
      "/x/fix-ci.md",
      "project",
    );
    expect(cmd.description).toBe("Fix the failing CI job");
    expect(cmd.argumentHint).toBe("<job>");
    expect(cmd.body).toBe("Fix $1");
  });

  test("falls back to the first body line for the description", () => {
    const cmd = parseCommandFile("/doc", "\n# Write docs\n\nMore text", "/x/doc.md", "global");
    expect(cmd.description).toBe("Write docs");
    expect(cmd.argumentHint).toBeUndefined();
  });
});

describe("expansion", () => {
  const make = (body: string) => parseCommandFile("/t", body, "/x/t.md", "project");

  test("substitutes $ARGUMENTS and positionals", () => {
    expect(expandCustomCommand(make("Fix $1 on $2. Notes: $ARGUMENTS"), 'lint "main branch"')).toBe(
      'Fix lint on main branch. Notes: lint "main branch"',
    );
  });

  test("missing positionals become empty", () => {
    expect(expandCustomCommand(make("A=$1 B=$2"), "one")).toBe("A=one B=");
  });

  test("does not substitute placeholders inside argument text", () => {
    expect(expandCustomCommand(make("Say $ARGUMENTS"), "$1 dollars")).toBe("Say $1 dollars");
  });

  test("appends arguments when the body has no placeholder", () => {
    expect(expandCustomCommand(make("Review the diff"), "focus on tests")).toBe(
      "Review the diff\n\nARGUMENTS: focus on tests",
    );
    expect(expandCustomCommand(make("Review the diff"), "  ")).toBe("Review the diff");
  });

  test("splits quoted arguments", () => {
    expect(splitArguments('a "b c" d')).toEqual(["a", "b c", "d"]);
  });

  test("expands input that invokes a command and ignores everything else", () => {
    write(cwd, "fix-ci.md", "Fix job $1");
    expect(expandCustomCommandInput("/Fix-CI build", cwd, undefined, { home })?.prompt).toBe(
      "Fix job build",
    );
    expect(expandCustomCommandInput("/unknown", cwd, undefined, { home })).toBeNull();
    expect(expandCustomCommandInput("fix-ci build", cwd, undefined, { home })).toBeNull();
    expect(expandCustomCommandInput("/tmp/x is broken", cwd, undefined, { home })).toBeNull();
  });

  test("built-in commands shadow custom commands", () => {
    write(cwd, "help.md", "custom help");
    write(cwd, "session.md", "custom session");
    write(cwd, "q.md", "custom quit alias");
    write(cwd, "mine.md", "mine");
    const run = (input: string) =>
      expandCustomCommandInput(input, cwd, isBuiltinCommandName, { home })?.prompt ?? null;
    expect(run("/help")).toBeNull();
    expect(run("/session")).toBeNull();
    expect(run("/q")).toBeNull();
    expect(run("/mine")).toBe("mine");
  });
});

describe("built-in names", () => {
  test("recognizes commands, first words, aliases and prefix handlers", () => {
    expect(isBuiltinCommandName("/help")).toBe(true);
    expect(isBuiltinCommandName("/git")).toBe(true);
    expect(isBuiltinCommandName("/drafts")).toBe(true);
    expect(isBuiltinCommandName("/plan")).toBe(true);
    expect(isBuiltinCommandName("/commands")).toBe(true);
    expect(isBuiltinCommandName("/fix-ci")).toBe(false);
  });
});
