import { z } from "zod";
import { CHAT_MODES } from "../chat/sessions.js";
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
export const ForkSessionBody = z.strictObject({ atMessageId: z.string().min(1).optional() });
export const MessageBody = z.strictObject({ text: Text });
export const PromptAnswerBody = z.union([
  z.strictObject({ approve: z.boolean() }),
  z.strictObject({ answer: z.string().max(20_000) }),
]);
export const SessionListQuery = z.strictObject({ limit: z.string().regex(/^\d+$/).optional() });
export const ModelsQuery = z.strictObject({ provider: z.string().min(1).optional() });
