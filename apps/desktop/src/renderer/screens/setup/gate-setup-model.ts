import type { GateDraft, GateDraftKind, GatePlaces } from "../../client/setup.js";

/** The four steps of the gate setup, one gate at a time (#372). */
export type GateSetupStep = "kind" | "describe" | "review" | "place";
export const GATE_SETUP_STEPS: readonly { step: GateSetupStep; title: string }[] = [
  { step: "kind", title: "Kind" },
  { step: "describe", title: "Describe" },
  { step: "review", title: "Review" },
  { step: "place", title: "Where" },
];

/** Each kind in plain words, with what the person should write in the next step. */
export const GATE_KINDS: readonly {
  kind: GateDraftKind;
  title: string;
  what: string;
  placeholder: string;
  usesModel: boolean;
}[] = [
  {
    kind: "command",
    title: "Run a command",
    what: "An exact check: a command or a small test script whose exit code decides. It blocks the run when it fails.",
    placeholder: "Run the CLI with sum 50 6 and check it prints 56",
    usesModel: true,
  },
  {
    kind: "ai-acceptance",
    title: "AI check of the running app",
    what: "An AI starts your program, uses it in its terminal like a person would and reports what it saw. Advisory until you accept the test it writes.",
    placeholder: "Start the CLI, try a few sums and a missing number; errors should be clear",
    usesModel: true,
  },
  {
    kind: "ai-review",
    title: "AI review",
    what: "An AI reviewer reads the change with your instructions. Critical and high findings block. It goes in a review stage.",
    placeholder: "Check that every error message tells the user what to do next",
    usesModel: false,
  },
  {
    kind: "human",
    title: "Ask a person",
    what: "The run stops until a person approves. Nothing runs.",
    placeholder: "Product owner signs off the help text",
    usesModel: false,
  },
];

export const kindInfo = (kind: GateDraftKind) =>
  GATE_KINDS.find((k) => k.kind === kind) ?? GATE_KINDS[0];

/** The lines of a draft a person reads before saving, without raw JSON. */
export function draftLines(draft: GateDraft): { label: string; lines: string[] }[] {
  const gate = draft.gate;
  const out: { label: string; lines: string[] }[] = [
    { label: "What it checks", lines: [gate.description] },
  ];
  if (gate.command)
    out.push({
      label: "Command",
      lines: [[gate.command.executable, ...gate.command.args].join(" ")],
    });
  if (gate.acceptance) {
    const a = gate.acceptance;
    out.push({ label: "Steps", lines: a.scenario.steps.map((s, i) => `${i + 1}. ${s}`) });
    out.push({
      label: "Expectations",
      lines: a.scenario.expectations.map((e, i) => `E${i + 1}. ${e}`),
    });
    out.push({
      label: "Program",
      lines: [
        [a.start.executable, ...a.start.args].join(" "),
        ...(a.commands ?? []).map((c) => `then ${[c.executable, ...c.args].join(" ")}`),
      ],
    });
  }
  if (gate.human) out.push({ label: "The person is asked", lines: [gate.human.prompt] });
  if (gate.review?.instructions)
    out.push({ label: "Reviewer instructions", lines: [gate.review.instructions] });
  out.push({ label: "It may", lines: draft.capabilities });
  return out;
}

/** The first place the gate can go, so the last step starts with a sensible choice. */
export function firstOpenPlace(places: GatePlaces | null): string | null {
  return places?.places.find((p) => !p.disabled && !p.bound)?.key ?? null;
}
