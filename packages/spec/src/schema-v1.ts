import { z } from "zod";
import {
  gitAnchorSchema,
  isoTimestamp,
  isoTimestampString,
  memoryIdSchema,
  provenanceSchema,
  requireVerifiedTimestamp,
  verifiedTimestampIssue,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type Memory,
} from "./schema.js";

/**
 * MEMFILE VERSION 1, FROZEN.
 *
 * This file describes files that already exist in the world and can never be
 * changed by changing our mind. It is edited only to fix a description that
 * never matched what v0.1 actually wrote — never to evolve the format; that
 * is what new versions are for.
 *
 * v1 files are read by WIDENING into the current `Memory` shape: the parse
 * output carries `memfile: 2`, and the version the file declared on disk
 * survives only in `Memfile.version`. Widening is what keeps every consumer
 * single-shaped — nothing downstream ever sees a v1 object.
 *
 * One deliberate narrowing, recorded as a ruling: v1's schema *named*
 * `scope: user` but no released v0.1 surface could write it — `remember`,
 * distillation and seeding all emit `scope: repo`. In v2 the user scope is
 * reserved for a shape that forbids anchors (v0.2 §8), which a v1 file
 * cannot represent. So a v1 file declaring `scope: user` is refused with its
 * own message rather than widened into a claim the current shape cannot
 * carry. No legitimate file is affected, because no tool ever produced one.
 */

const scopeV1 = z.enum(["repo", "team"], {
  error:
    "scope must be repo or team — no released v0.1 tool ever wrote a `user`-scope file, and v2 reserves that scope for the anchorless user store",
});

const memoryObjectV1 = z
  .object({
    memfile: z.literal(1),
    id: memoryIdSchema,
    type: z.enum(MEMORY_TYPES),
    status: z.enum(MEMORY_STATUSES),
    scope: scopeV1,
    confidence: z.number().min(0).max(1),
    created: isoTimestampString,
    verified: isoTimestampString.optional(),
    /** v1 knows exactly one anchor kind. */
    anchors: z
      .array(gitAnchorSchema)
      .min(1, "a memory must carry at least one anchor"),
    provenance: provenanceSchema,
    supersedes: memoryIdSchema.optional(),
  })
  .strict();

const widen = <T extends { memfile: 1 }>(m: T): T & { memfile: 2 } => ({
  ...m,
  memfile: 2 as const,
});

export const memfileV1WireSchema: z.ZodType<Memory> = memoryObjectV1
  .refine(requireVerifiedTimestamp, verifiedTimestampIssue)
  .transform(widen);

/** v1 file form: the same read-side tolerance for YAML-coerced Dates. */
export const memfileV1FileSchema: z.ZodType<Memory> = memoryObjectV1
  .extend({
    created: isoTimestamp,
    verified: isoTimestamp.optional(),
  })
  .refine(requireVerifiedTimestamp, verifiedTimestampIssue)
  .transform(widen);
