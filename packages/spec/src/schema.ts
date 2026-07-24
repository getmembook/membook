import { z } from "zod";

/**
 * Memfile spec version. Bump only for breaking changes to the frontmatter
 * contract; additive optional fields do not require a bump.
 */
export const MEMFILE_SPEC_VERSION = 1;

export const MEMORY_TYPES = [
  "decision",
  "gotcha",
  "convention",
  "map",
  "deadend",
] as const;

export const MEMORY_STATUSES = [
  "unverified",
  "verified",
  "stale",
  "invalidated",
] as const;

export const MEMORY_SCOPES = ["repo", "user", "team"] as const;

/** Content-addressed short id, e.g. `m-4f2a`. Filename is `<id>.mem.md`. */
export const memoryIdSchema = z
  .string()
  .regex(/^m-[0-9a-f]{4,12}$/, "id must match m-<4..12 lowercase hex chars>");

const repoRelativePath = z
  .string()
  .min(1, "anchor path must not be empty")
  .refine((p) => !p.startsWith("/") && !p.startsWith("~"), {
    error: "anchor path must be repo-relative (no leading / or ~)",
  })
  .refine((p) => !p.split("/").includes("..") && !p.split("/").includes("."), {
    error: "anchor path must not contain . or .. segments",
  })
  .refine((p) => !p.endsWith("/"), {
    error: "anchor path must not end with /",
  });

const commitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "commit must be a full 40-char lowercase hex SHA");

/** 1-based inclusive [start, end] line range. */
export const lineRangeSchema = z
  .tuple([z.number().int().min(1), z.number().int().min(1)])
  .refine(([start, end]) => start <= end, {
    error: "line_range start must be <= end",
  });

/**
 * A git anchor pins a memory to a path (optionally narrowed to a symbol
 * and/or line range) at the commit where the memory was last verified.
 * Verification diffs `commit..HEAD` against the path.
 *
 * `kind` may be omitted on input but is always serialized, so the
 * lockfile-hash and API-contract anchors landing in v0.2 are an additive
 * change: existing files already discriminate.
 */
export const gitAnchorSchema = z
  .object({
    kind: z.literal("git").default("git"),
    path: repoRelativePath,
    symbol: z.string().min(1).optional(),
    line_range: lineRangeSchema.optional(),
    commit: commitSha,
  })
  .strict();

/**
 * v0.1 has exactly one anchor kind. This becomes a discriminated union in
 * v0.2 — note that Zod discriminates before defaults apply, so that change
 * must normalize a missing `kind` to "git" before the union.
 */
export const anchorSchema = gitAnchorSchema;

export const provenanceSchema = z.object({
  session: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  source_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "source_hash must be a sha256 hex digest"),
});

/**
 * CANONICAL TIMESTAMP FORM — pinned by the spec, not an implementation detail.
 *
 * `YYYY-MM-DDTHH:MM:SSZ`: always UTC, always the `Z` suffix, always second
 * precision (sub-second is truncated, never rounded). A memory written in
 * Kochi and re-verified in London must serialize identically, so a local
 * offset is a representation difference the format does not carry.
 */
export const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function isCanonicalTimestamp(value: string): boolean {
  return CANONICAL_TIMESTAMP_RE.test(value);
}

function toCanonicalTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Offsets and sub-second precision are ACCEPTED on input and normalized to
 * the canonical form — an author writing `2026-07-21T22:12:00+05:30` gets a
 * correct UTC timestamp, not a rejection.
 */
const isoTimestampString = z.iso
  .datetime({ offset: true })
  .transform((value) => toCanonicalTimestamp(new Date(value)));

/**
 * Timestamps are serialized double-quoted so YAML 1.1 parsers (js-yaml, via
 * gray-matter) keep them as strings. Unquoted timestamps in hand-written or
 * third-party files still arrive as Dates, so accept and normalize those
 * rather than failing on a difference the author cannot see.
 *
 * This tolerance is strictly one-directional: it is a reader courtesy of
 * THIS implementation, not part of the Memfile standard. Writes go through
 * `memoryWireSchema`, so a Date can never reach disk.
 */
const isoTimestamp = z.union([
  isoTimestampString,
  z.date().transform(toCanonicalTimestamp),
]);

/**
 * The machine layer of a Memfile: everything in the YAML frontmatter.
 * The human statement lives in the markdown body, outside this schema.
 */
const memoryObject = z
  .object({
    memfile: z.literal(MEMFILE_SPEC_VERSION, {
      error: `memfile must be the spec version literal ${MEMFILE_SPEC_VERSION}`,
    }),
    id: memoryIdSchema,
    type: z.enum(MEMORY_TYPES),
    status: z.enum(MEMORY_STATUSES),
    scope: z.enum(MEMORY_SCOPES),
    confidence: z.number().min(0).max(1),
    created: isoTimestampString,
    verified: isoTimestampString.optional(),
    anchors: z.array(anchorSchema).min(1, "a memory must carry at least one anchor"),
    provenance: provenanceSchema,
    supersedes: memoryIdSchema.optional(),
  })
  .strict();

const requireVerifiedTimestamp = (m: {
  status: string;
  verified?: string | undefined;
}) => m.status === "unverified" || m.verified !== undefined;

const verifiedTimestampIssue = {
  error: "a memory that is not unverified must carry a verified timestamp",
  path: ["verified"],
};

/**
 * THE WIRE SCHEMA IS THE MEMFILE STANDARD.
 *
 * Timestamps are strings, and this is what `memoryJsonSchema` projects — so
 * it is what any external implementer targets. It is also what a distillation
 * provider emits, and what every write validates against.
 *
 * A tool that emits real YAML timestamps is NOT spec-compliant, however
 * forgiving our own reader happens to be.
 */
export const memoryWireSchema = memoryObject.refine(
  requireVerifiedTimestamp,
  verifiedTimestampIssue,
);

/**
 * File form: the standard, plus this implementation's read-side tolerance for
 * YAML-coerced Dates. Never use it to validate a write.
 */
export const memorySchema = memoryObject
  .extend({
    created: isoTimestamp,
    verified: isoTimestamp.optional(),
  })
  .refine(requireVerifiedTimestamp, verifiedTimestampIssue);

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type GitAnchor = z.infer<typeof gitAnchorSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type Memory = z.infer<typeof memorySchema>;

/**
 * Frontmatter as accepted on WRITE — the standard's input surface. Anchor
 * `kind` may be omitted (defaults to "git") and timestamps may carry an
 * offset, but they must be strings: Date is deliberately not assignable.
 */
export type MemoryInput = z.input<typeof memoryWireSchema>;

/** Frontmatter as accepted on READ, which additionally tolerates Dates. */
export type MemoryFileInput = z.input<typeof memorySchema>;
