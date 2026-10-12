import { z } from "zod";
import { BriefContentSchema } from "../chat/coordinator.js";
import { MAX_IMAGES_PER_MESSAGE } from "../chat/images.js";
import { CHAT_MODES, PLAN_ACTIONS } from "../chat/sessions.js";
import { CHAT_EFFORTS } from "../llm/provider-options.js";
import { BUDGET_PRESETS } from "../workflows/budget.js";
import { MAX_CONCURRENT_WRITERS, RunStatus, SafeId } from "../workflows/schemas.js";
import { USAGE_DIMENSIONS } from "../workflows/usage.js";

/** Every mutation names a client-chosen command ID; a retry with the same ID returns the first result. */
const Command = z.object({
  commandId: SafeId,
  expectedRevision: z.number().int().min(0),
});
const PositiveInt = z.number().int().min(1);

export const StartBody = z
  .strictObject({
    commandId: SafeId,
    /** Optional with `issue`, which names the feature `issue-N-TITLE`. */
    feature: SafeId.optional(),
    /** Optional with `issue`; with it, extra instructions added to the issue's text. */
    prompt: z.string().min(1).optional(),
    /** A GitHub issue URL, `owner/name#N` or `#N`, as `--issue`; delivery closes the issue. */
    issue: z.string().min(1).max(500).optional(),
    workflow: SafeId.optional(),
    /** A run policy object, as the CLI reads from `--policy FILE`. */
    policy: z.unknown().optional(),
    /** A budget preset scaling the policy (or the configured or default one), as `--budget`. */
    budget: z.enum(BUDGET_PRESETS).optional(),
    model: z.string().min(1).optional(),
    owner: z.string().min(1).max(200).optional(),
    confirmAutoApproval: z.string().min(1).optional(),
    worktree: z.boolean().optional(),
    writers: z.number().int().min(1).max(MAX_CONCURRENT_WRITERS).optional(),
    /** What blocking spec questions do, as `--clarification`; omitted, the policy decides. */
    clarification: z.enum(["ask", "assume"]).optional(),
    /** The run model overrides configured model routes, as `--model-strict`. */
    modelStrict: z.boolean().optional(),
    /** The approval reviewer may approve low-risk plans outside the limits, as `--approval-review`. */
    approvalReview: z.boolean().optional(),
  })
  .refine((body) => body.issue !== undefined || (body.feature && body.prompt), {
    message: "feature and prompt are required without issue",
  });
export const CommandBody = Command.strict();
export const ApproveBody = Command.extend({
  requestId: SafeId,
  digest: z.string().min(1),
  excludeUserChanges: z.boolean().optional(),
}).strict();
export const RejectBody = Command.extend({
  requestId: SafeId,
  reason: z.string().min(1),
}).strict();
export const AnswerBody = Command.extend({
  requestId: SafeId,
  answers: z.record(z.string(), z.string()),
}).strict();
export const ExtendBody = Command.extend({
  tokens: PositiveInt.optional(),
  calls: PositiveInt.optional(),
  timeMs: PositiveInt.optional(),
}).strict();

/** A new run model and/or stage routes (stage ID to model or `$class`), as `workflow reroute`. */
export const RerouteBody = Command.extend({
  model: z.string().min(1).optional(),
  routes: z.record(SafeId, z.string().min(1)).optional(),
})
  .strict()
  .refine((body) => body.model || Object.keys(body.routes ?? {}).length, {
    message: "Name a model or stage routes",
  });

/** `doctor` and `estimate`: the run inputs that change a start; the API uses the configured policy. */
export const PreRunQuery = z.strictObject({
  workflow: SafeId.optional(),
  model: z.string().min(1).optional(),
  route: z.string().min(1).optional(),
  modelStrict: z.enum(["true", "false"]).optional(),
  worktree: z.enum(["true", "false"]).optional(),
  writers: z.string().regex(/^\d+$/).optional(),
  confirmAutoApproval: z.string().min(1).optional(),
});
export const ListQuery = z.strictObject({
  feature: SafeId.optional(),
  status: RunStatus.optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  cursor: SafeId.optional(),
});
export const EventsQuery = z.strictObject({
  after: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

/** Paths relative to the project root; removals apply before additions. */
export const WorkingSetBody = z
  .strictObject({
    add: z.array(z.string().min(1)).max(200).optional(),
    remove: z.array(z.string().min(1)).max(200).optional(),
  })
  .refine((body) => body.add?.length || body.remove?.length, {
    message: "Name entries to add or remove",
  });

const ChatModeSchema = z.enum(CHAT_MODES);
const ChatEffortSchema = z.enum(CHAT_EFFORTS);
const ModelId = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[^/\s]+\/\S+$/, "Use provider/model");
const Title = z.string().trim().min(1).max(200);
/** A chat message; large enough for pasted files, well under the body limit. */
const Text = z.string().min(1).max(200_000);

/** An attached image; `acceptImages` checks the type, size and data. */
const ImageBody = z.strictObject({
  mediaType: z.string().min(1).max(100),
  data: z.string().min(1),
});
const Images = z.array(ImageBody).min(1).max(MAX_IMAGES_PER_MESSAGE);

export const CreateSessionBody = z.strictObject({
  title: Title.optional(),
  model: ModelId.optional(),
  mode: ChatModeSchema.optional(),
  effort: ChatEffortSchema.optional(),
  text: Text.optional(),
  images: Images.optional(),
});
export const CoordinatorBody = z.strictObject({ model: ModelId.optional() });
export const BriefBody = BriefContentSchema.extend({
  expectedRevision: z.number().int().min(0),
});
export const UpdateSessionBody = z
  .strictObject({
    title: Title.optional(),
    model: ModelId.optional(),
    mode: ChatModeSchema.optional(),
    effort: ChatEffortSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Name a field to change" });
export const ForkSessionBody = z.strictObject({
  atMessageId: z.string().min(1).optional(),
  rollbackFiles: z.boolean().optional(),
  force: z.boolean().optional(),
});
export const UndoSessionBody = z.strictObject({
  toCheckpoint: z.number().int().min(0).optional(),
  force: z.boolean().optional(),
});
export const RedoSessionBody = z.strictObject({ force: z.boolean().optional() });
/** A message is text, images, or both. */
export const MessageBody = z
  .strictObject({ text: z.string().max(200_000).default(""), images: Images.optional() })
  .refine((body) => body.text.length > 0 || body.images !== undefined, {
    message: "Send text or images",
  });
export const CompactBody = z.strictObject({});
export const WatchBody = z.strictObject({ on: z.boolean() });
export const PromptAnswerBody = z.union([
  z.strictObject({
    approve: z.boolean(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  z.strictObject({ answer: z.string().max(20_000) }),
  z.strictObject({ action: z.enum(PLAN_ACTIONS), feedback: z.string().max(20_000).optional() }),
]);
export const SessionListQuery = z.strictObject({ limit: z.string().regex(/^\d+$/).optional() });
export const SessionExportQuery = z.strictObject({
  format: z.enum(["markdown", "json"]).optional(),
});
export const ModelsQuery = z.strictObject({ provider: z.string().min(1).optional() });
export const MentionsQuery = z.strictObject({
  q: z.string().max(200).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

export const ContinueBody = Command.extend({ requestId: SafeId }).strict();
export const EvidenceBody = Command.extend({
  requestId: SafeId,
  evidence: z.string().min(1).max(200_000),
  accepted: z.boolean(),
}).strict();
export const RecoverBody = Command.extend({
  requestId: SafeId,
  effectId: SafeId,
  resolution: z.enum(["record-applied", "record-not-applied", "retry", "cancel"]),
  evidence: z.string().min(1).max(200_000),
}).strict();
export const ReviseBody = Command.extend({
  candidate: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
/** A revision of a run's accepted inputs; with no field it adopts the current instructions. */
export const CandidateBody = z.strictObject({
  commandId: SafeId,
  spec: z.record(z.string(), z.unknown()).optional(),
  plan: z.string().min(1).max(1_000_000).optional(),
  tasks: z.record(z.string(), z.unknown()).optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
});
export const UndoBody = Command.extend({ path: z.string().min(1).optional() }).strict();
export const DeliverBody = z.strictObject({
  remote: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  draft: z.boolean().optional(),
  pullRequest: z.boolean().optional(),
});
export const DeliverExecuteBody = z.strictObject({
  expectedRevision: z.number().int().min(0),
  requestId: SafeId.optional(),
});
export const GatesConfirmBody = z
  .strictObject({
    ids: z.array(SafeId).min(1).max(200).optional(),
    all: z.literal(true).optional(),
  })
  .refine((body) => Boolean(body.ids) !== Boolean(body.all), {
    message: "Name the gates to confirm in ids, or send all: true",
  });
const EditorTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stage"), stageId: SafeId }),
  z.strictObject({ kind: z.literal("transition"), id: z.string().min(1).max(200) }),
]);
const Index = z.number().int().min(0).max(1000);
const Delta = z.union([z.literal(-1), z.literal(1)]);
export const EditorOpBody = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("addGate"), target: EditorTarget, gateId: SafeId }),
  z.strictObject({ op: z.literal("removeGate"), target: EditorTarget, index: Index }),
  z.strictObject({ op: z.literal("moveGate"), target: EditorTarget, index: Index, delta: Delta }),
  z.strictObject({ op: z.literal("toggleMode"), target: EditorTarget, index: Index }),
  z.strictObject({
    op: z.literal("addTransition"),
    from: SafeId,
    to: z.string().min(1).max(100),
    on: z.enum(["passed", "failed", "changes_requested"]),
    loop: z.number().int().min(1).max(5).nullable(),
  }),
  z.strictObject({ op: z.literal("removeTransition"), id: z.string().min(1).max(200) }),
  z.strictObject({
    op: z.literal("changeField"),
    stageId: SafeId,
    key: z.string().min(1).max(200),
    delta: Delta,
  }),
  z.strictObject({ op: z.literal("duplicate") }),
]);
/**
 * The working copy the editor sends back. Only its outline is checked here: an edit may leave it
 * schema-invalid for a while (a check stage with no gate), and the editor reports that as problems.
 */
const WorkingCopy = z.looseObject({
  id: SafeId,
  stages: z.array(z.looseObject({ id: z.string(), type: z.string() })).max(100),
  transitions: z
    .array(
      z.looseObject({
        id: z.string(),
        from: z.string(),
        to: z.string(),
        gates: z.array(z.looseObject({ gateId: z.string() })),
      }),
    )
    .max(500),
});
export const EditorBody = z.strictObject({
  from: SafeId,
  copy: z.boolean().optional(),
  definition: WorkingCopy.optional(),
  op: EditorOpBody.optional(),
});
export const EditorSaveBody = z.strictObject({
  from: SafeId,
  copy: z.boolean().optional(),
  definition: WorkingCopy,
  /** The first characters of the auto approval limits hash, when the review asked for them. */
  confirm: z.string().max(200).optional(),
});
/** `POST /v1/workflow/runs/:id/export`: a new directory, relative to the workspace. */
export const ExportBody = z.strictObject({ destination: z.string().min(1).max(500).optional() });
export const RedactBody = z.strictObject({
  artifactId: SafeId,
  reason: z.string().trim().min(1).max(500),
});
export const GcBody = z.strictObject({
  before: z.string().refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Expected an ISO date",
  }),
  dryRun: z.boolean().optional(),
});
export const ImportBody = z.strictObject({
  source: z.enum(["spec-kit", "ecc", "markdown-edit"]),
  /** A local directory, relative to the workspace or absolute. */
  path: z.string().min(1).max(1000),
  featureId: SafeId,
  commandId: SafeId.optional(),
});
export const RouteQuery = z.strictObject({
  workflow: SafeId.optional(),
  model: z.string().min(1).optional(),
  route: z.string().min(1).optional(),
});
export const UsageQuery = z.strictObject({
  days: z.string().regex(/^\d+$/).optional(),
  /** One dimension, or two separated by a comma (`stage,model`). */
  groupBy: z
    .string()
    .transform((value) => value.split(","))
    .pipe(
      z
        .array(z.enum(USAGE_DIMENSIONS))
        .min(1)
        .max(2)
        .refine((list) => new Set(list).size === list.length, "Name each dimension once"),
    )
    .optional(),
  model: z.string().min(1).optional(),
  stage: z.string().min(1).optional(),
  /** `md` answers `{ markdown }`, the summary as a Markdown document to share. */
  format: z.literal("md").optional(),
});
