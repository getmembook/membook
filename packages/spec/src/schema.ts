import { z } from "zod";
import { WORKSPACE_NAME_RE } from "./workspace.js";

/**
 * Memfile spec version. Bump only for breaking changes to the frontmatter
 * contract; additive optional fields do not require a bump.
 *
 * 2 — the `xgit` cross-repo anchor kind. A v1 reader would reject any file
 * carrying one, which is exactly what the version field exists to say.
 * v1 files remain readable forever: see `schema-v1.ts` and the registry in
 * `versions.ts`.
 */
export const MEMFILE_SPEC_VERSION = 2;

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

export const repoRelativePath = z
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

export const commitSha = z
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
 * A cross-repo anchor: the same claim, pinned into a DIFFERENT repository,
 * resolved through the workspace manifest by member name. `commit` is the
 * last-verified SHA in THAT repo's history. `kind` has no default here —
 * crossing a repository boundary is something a file must say out loud.
 */
export const xgitAnchorSchema = z
  .object({
    kind: z.literal("xgit"),
    /** Workspace member name — the manifest resolves it to a checkout. */
    repo: z
      .string()
      .regex(
        WORKSPACE_NAME_RE,
        "repo must be a workspace member name (lowercase letters, digits, dot, dash, underscore)"
      ),
    path: repoRelativePath,
    symbol: z.string().min(1).optional(),
    line_range: lineRangeSchema.optional(),
    commit: commitSha,
  })
  .strict();

/**
 * A plain union, with `git` FIRST — that ordering is load-bearing. Zod
 * discriminates before defaults apply, so a discriminated union would reject
 * the spec-legal anchor that omits `kind`; the plain union lets the git
 * branch's default claim it, and an explicit `kind: xgit` falls through to
 * the second branch on the literal mismatch.
 */
export const anchorSchema = z.union([gitAnchorSchema, xgitAnchorSchema]);

export const PROVENANCE_ORIGINS = ["distilled", "authored"] as const;
export const PROVENANCE_AUTHORS = ["human", "agent"] as const;

const sessionId = z.string().min(1);
const agentName = z.string().min(1);
const modelName = z.string().min(1);

/**
 * Distilled from a session: `source_hash` is REQUIRED, and is the sha256 of
 * the exact digest artifact the distiller consumed. A distillation always
 * runs inside a session, with an agent and a model, so all are required.
 */
export const distilledProvenanceSchema = z
  .object({
    origin: z.literal("distilled"),
    session: sessionId,
    agent: agentName,
    model: modelName,
    source_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "source_hash must be a sha256 hex digest"),
  })
  .strict();

/**
 * Authored by an agent: it knows what it is, and saying so is auditable.
 * `session` is optional — an agent may write outside a session context.
 */
export const agentAuthoredProvenanceSchema = z
  .object({
    origin: z.literal("authored"),
    author: z.literal("agent"),
    session: sessionId.optional(),
    agent: agentName,
    model: modelName,
  })
  .strict();

/**
 * Authored by a person at the CLI: `agent` and `model` are FORBIDDEN, because
 * a human has neither. The schema makes inventing them impossible rather than
 * merely discouraged.
 */
export const humanAuthoredProvenanceSchema = z
  .object({
    origin: z.literal("authored"),
    author: z.literal("human"),
    session: sessionId.optional(),
  })
  .strict();

export const authoredProvenanceSchema = z.discriminatedUnion("author", [
  agentAuthoredProvenanceSchema,
  humanAuthoredProvenanceSchema,
]);

/**
 * PROVENANCE IS SHAPED BY WHO WROTE IT, AND FROM WHAT.
 *
 * `origin` says how the memory came to exist and governs `source_hash`;
 * within `authored`, `author` says who wrote it and governs `agent`/`model`.
 * Every field's presence is therefore meaningful: an auditor can reconstruct
 * *who wrote this, from what, in what context* purely from which fields
 * exist, and no field can be plausible junk because none can be present
 * without a nameable referent behind it.
 *
 * `.strict()` on each variant is what does the forbidding — an unrecognized
 * key is a validation failure, never a field to ignore.
 *
 * Both discriminators are always serialized and lead their block, with no
 * default: defaulting would silently mean the wrong thing. Future origins
 * (`imported`, `registry`) stay additive, as with anchor `kind`.
 */
export const provenanceSchema = z.discriminatedUnion("origin", [
  distilledProvenanceSchema,
  authoredProvenanceSchema,
]);

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
export const isoTimestampString = z.iso
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
export const isoTimestamp = z.union([
  isoTimestampString,
  z.date().transform(toCanonicalTimestamp),
]);

const memfileVersion = z.literal(MEMFILE_SPEC_VERSION, {
  error: `memfile must be the spec version literal ${MEMFILE_SPEC_VERSION}`,
});

/**
 * THE SCOPE DISCRIMINATION (v0.2 §8, ruled).
 *
 * An anchor is what makes a memory a checkable claim about the world. A user
 * preference is not a claim about the world — it is testimony about the
 * human, and verification is a category error against it, not a pending
 * obligation. So the schema splits on `scope`, exactly as provenance splits
 * on `origin` and `author`:
 *
 *   repo | team — anchors REQUIRED (min 1), full verification lifecycle
 *   user        — anchors FORBIDDEN; `status` and `verified` absent from
 *                 the shape, because a field implying a pending check must
 *                 not exist on a memory that can never be checked
 *
 * Anchors are forbidden rather than optional on purpose: if you have a file
 * to point at, it is not a preference — it is repo knowledge wearing the
 * wrong scope.
 */
const anchoredMemoryObject = z
  .object({
    memfile: memfileVersion,
    id: memoryIdSchema,
    type: z.enum(MEMORY_TYPES),
    status: z.enum(MEMORY_STATUSES),
    scope: z.enum(["repo", "team"]),
    confidence: z.number().min(0).max(1),
    created: isoTimestampString,
    verified: isoTimestampString.optional(),
    anchors: z
      .array(anchorSchema)
      .min(1, "a memory must carry at least one anchor"),
    provenance: provenanceSchema,
    supersedes: memoryIdSchema.optional(),
  })
  .strict();

const userMemoryObject = z
  .object({
    memfile: memfileVersion,
    id: memoryIdSchema,
    type: z.enum(MEMORY_TYPES),
    scope: z.literal("user"),
    confidence: z.number().min(0).max(1),
    created: isoTimestampString,
    provenance: provenanceSchema,
    supersedes: memoryIdSchema.optional(),
  })
  .strict();

/**
 * `verified` records when the memory last passed verification, so it exists
 * if and only if that ever happened — presence is meaningful here too.
 *
 * Required for `verified`, and forbidden for nothing: a memory created
 * `unverified` whose anchored code then changes becomes `stale` having never
 * been verified at all, and must be representable. Demanding a timestamp
 * there would force one to be invented, which is the failure this format
 * exists to prevent.
 */
export const requireVerifiedTimestamp = (m: {
  status: string;
  verified?: string | undefined;
}) => m.status !== "verified" || m.verified !== undefined;

export const verifiedTimestampIssue = {
  error: "a memory with status `verified` must carry a verified timestamp",
  path: ["verified"],
};

/**
 * The union refinement: the verified-timestamp rule applies exactly where a
 * verified status can exist. A user memory passes vacuously — not because
 * the rule is relaxed for it, but because the fields the rule is about are
 * absent from its shape.
 */
const requireVerifiedTimestampAcrossScopes = (m: {
  scope: string;
  status?: string;
  verified?: string | undefined;
}) =>
  m.scope === "user" ||
  requireVerifiedTimestamp(m as { status: string; verified?: string });

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
export const memoryWireSchema = z
  .discriminatedUnion("scope", [anchoredMemoryObject, userMemoryObject])
  .refine(requireVerifiedTimestampAcrossScopes, verifiedTimestampIssue);

/**
 * File form: the standard, plus this implementation's read-side tolerance for
 * YAML-coerced Dates. Never use it to validate a write.
 */
export const memorySchema = z
  .discriminatedUnion("scope", [
    anchoredMemoryObject.extend({
      created: isoTimestamp,
      verified: isoTimestamp.optional(),
    }),
    userMemoryObject.extend({ created: isoTimestamp }),
  ])
  .refine(requireVerifiedTimestampAcrossScopes, verifiedTimestampIssue);

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type GitAnchor = z.infer<typeof gitAnchorSchema>;
export type XgitAnchor = z.infer<typeof xgitAnchorSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type ProvenanceOrigin = (typeof PROVENANCE_ORIGINS)[number];
export type ProvenanceAuthor = (typeof PROVENANCE_AUTHORS)[number];
export type Provenance = z.infer<typeof provenanceSchema>;
export type DistilledProvenance = z.infer<typeof distilledProvenanceSchema>;
export type AuthoredProvenance = z.infer<typeof authoredProvenanceSchema>;
export type AgentAuthoredProvenance = z.infer<
  typeof agentAuthoredProvenanceSchema
>;
export type HumanAuthoredProvenance = z.infer<
  typeof humanAuthoredProvenanceSchema
>;
export type Memory = z.infer<typeof memorySchema>;
/** The repo/team variant: at least one anchor, full verification lifecycle. */
export type AnchoredMemory = Extract<Memory, { scope: "repo" | "team" }>;
/** The user variant: testimony about the human — no anchors, no lifecycle. */
export type UserMemory = Extract<Memory, { scope: "user" }>;

/**
 * Frontmatter as accepted on WRITE — the standard's input surface. Anchor
 * `kind` may be omitted (defaults to "git") and timestamps may carry an
 * offset, but they must be strings: Date is deliberately not assignable.
 */
export type MemoryInput = z.input<typeof memoryWireSchema>;

/** Frontmatter as accepted on READ, which additionally tolerates Dates. */
export type MemoryFileInput = z.input<typeof memorySchema>;

/** The input variants, split the way the scope discrimination splits them. */
export type AnchoredMemoryInput = Extract<MemoryInput, { anchors: unknown }>;
export type UserMemoryInput = Exclude<MemoryInput, { anchors: unknown }>;
