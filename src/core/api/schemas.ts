import { z } from "zod";
import { MAX_CONCURRENT_WRITERS, RunStatus, SafeId } from "../workflows/schemas.js";

/** Every mutation names a client-chosen command ID; a retry with the same ID returns the first result. */
const Command = z.object({
  commandId: SafeId,
  expectedRevision: z.number().int().min(0),
});
const PositiveInt = z.number().int().min(1);

export const StartBody = z.strictObject({
  commandId: SafeId,
  feature: SafeId,
  prompt: z.string().min(1),
  workflow: SafeId.optional(),
  /** A run policy object, as the CLI reads from `--policy FILE`. */
  policy: z.unknown().optional(),
  model: z.string().min(1).optional(),
  owner: z.string().min(1).max(200).optional(),
  confirmAutoApproval: z.string().min(1).optional(),
  worktree: z.boolean().optional(),
  writers: z.number().int().min(1).max(MAX_CONCURRENT_WRITERS).optional(),
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
