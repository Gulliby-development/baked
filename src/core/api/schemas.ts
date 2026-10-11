import { z } from "zod";
import { CHAT_MODES } from "../chat/sessions.js";
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
    model: z.string().min(1).optional(),
    owner: z.string().min(1).max(200).optional(),
    confirmAutoApproval: z.string().min(1).optional(),
    worktree: z.boolean().optional(),
    writers: z.number().int().min(1).max(MAX_CONCURRENT_WRITERS).optional(),
    /** What blocking spec questions do, as `--clarification`; omitted, the policy decides. */
    clarification: z.enum(["ask", "assume"]).optional(),
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
const ModelId = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[^/\s]+\/\S+$/, "Use provider/model");
const Title = z.string().trim().min(1).max(200);
/** A chat message; large enough for pasted files, well under the body limit. */
const Text = z.string().min(1).max(200_000);

export const CreateSessionBody = z.strictObject({
  title: Title.optional(),
  model: ModelId.optional(),
  mode: ChatModeSchema.optional(),
  text: Text.optional(),
});
export const UpdateSessionBody = z
  .strictObject({
    title: Title.optional(),
    model: ModelId.optional(),
    mode: ChatModeSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Name a field to change" });
export const ForkSessionBody = z.strictObject({
  atMessageId: z.string().min(1).optional(),
  rollbackFiles: z.boolean().optional(),
  force: z.boolean().optional(),
});
export const MessageBody = z.strictObject({ text: Text });
export const CompactBody = z.strictObject({});
export const RewindBody = z.strictObject({
  checkpoint: z.number().int().min(0),
  rollbackFiles: z.boolean().optional(),
  force: z.boolean().optional(),
});
export const RedoBody = z.strictObject({ force: z.boolean().optional() });
export const PromptAnswerBody = z.union([
  z.strictObject({ approve: z.boolean() }),
  z.strictObject({ answer: z.string().max(20_000) }),
]);
export const SessionListQuery = z.strictObject({ limit: z.string().regex(/^\d+$/).optional() });
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
});
