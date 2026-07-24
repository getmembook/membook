import matter from "gray-matter";
import { Document, Scalar, isScalar, isSeq, visit } from "yaml";
import {
  memorySchema,
  memoryWireSchema,
  type Memory,
  type MemoryInput,
} from "./schema.js";
import { MemfileValidationError } from "./errors.js";

/**
 * A parsed Memfile: validated machine layer + the human statement body.
 */
export interface Memfile {
  frontmatter: Memory;
  body: string;
}

/**
 * Stable key order for frontmatter. Deterministic serialization is a
 * requirement, not a nicety: memories live in git, and unstable key order
 * turns every rewrite into a noisy diff.
 */
const KEY_ORDER = [
  "memfile",
  "id",
  "type",
  "status",
  "scope",
  "confidence",
  "created",
  "verified",
  "anchors",
  "provenance",
  "supersedes",
] as const;

/**
 * `kind` leads every anchor map so PR review can scan what kind of anchor
 * changed without reading the rest of the entry.
 */
const ANCHOR_KEY_ORDER = ["kind", "path", "symbol", "line_range", "commit"] as const;

/** Fields quoted by explicit rule below — never by the emitter's heuristics. */
const TIMESTAMP_KEYS = new Set(["created", "verified"]);
const PROVENANCE_KEY_ORDER = ["session", "agent", "model", "source_hash"] as const;

function orderKeys<T extends Record<string, unknown>>(
  value: T,
  order: readonly string[],
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of order) {
    if (value[key] !== undefined) ordered[key] = value[key];
  }
  // Anything not in the order list would be a spec violation caught by
  // .strict() upstream; surface it rather than silently dropping it.
  for (const key of Object.keys(value)) {
    if (!order.includes(key)) ordered[key] = value[key];
  }
  return ordered;
}

function orderFrontmatter(memory: Memory): Record<string, unknown> {
  const ordered = orderKeys(memory, KEY_ORDER);
  ordered["anchors"] = memory.anchors.map((anchor) =>
    orderKeys(anchor, ANCHOR_KEY_ORDER),
  );
  ordered["provenance"] = orderKeys(memory.provenance, PROVENANCE_KEY_ORDER);
  return ordered;
}

/**
 * Validate and serialize a memory to Memfile text.
 *
 * Validation runs on WRITE as well as read: a malformed memory must never
 * reach disk. Body is normalized to a single trailing newline.
 *
 * Writes validate against the WIRE schema — the standard — so the reader's
 * tolerance for YAML-coerced Dates stays one-directional and a Date object
 * can never be written to a Memfile.
 */
export function serializeMemfile(
  frontmatter: MemoryInput,
  body: string,
  file?: string,
): string {
  const result = memoryWireSchema.safeParse(frontmatter);
  if (!result.success) {
    throw MemfileValidationError.fromZodError(result.error, file);
  }
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    throw new MemfileValidationError(
      ["body: a memory must carry a human-readable statement"],
      file,
    );
  }
  const doc = new Document(orderFrontmatter(result.data));
  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key)) return;
      // Line ranges read as `[18, 46]`; other collections stay block style.
      if (pair.key.value === "line_range" && isSeq(pair.value)) {
        pair.value.flow = true;
      }
      // Quote timestamps so YAML 1.1 parsers cannot coerce them to dates.
      // Stated as a rule, because it was the emitter's quoting heuristics
      // that let the coercion through in the first place.
      if (
        typeof pair.key.value === "string" &&
        TIMESTAMP_KEYS.has(pair.key.value) &&
        isScalar(pair.value)
      ) {
        pair.value.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  const yaml = doc.toString({
    lineWidth: 0,
    singleQuote: false,
    flowCollectionPadding: false,
  });
  return `---\n${yaml}---\n\n${trimmedBody}\n`;
}

/**
 * Parse and validate Memfile text. Throws MemfileValidationError with
 * actionable issues; callers quarantine rather than skip.
 */
export function parseMemfile(source: string, file?: string): Memfile {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(source);
  } catch (cause) {
    throw new MemfileValidationError(
      [`frontmatter: unparseable YAML — ${(cause as Error).message}`],
      file,
    );
  }

  if (Object.keys(parsed.data).length === 0) {
    throw new MemfileValidationError(
      ["frontmatter: missing — a Memfile must open with a YAML frontmatter block"],
      file,
    );
  }

  const result = memorySchema.safeParse(parsed.data);
  if (!result.success) {
    throw MemfileValidationError.fromZodError(result.error, file);
  }

  const body = parsed.content.trim();
  if (body.length === 0) {
    throw new MemfileValidationError(
      ["body: a memory must carry a human-readable statement"],
      file,
    );
  }

  return { frontmatter: result.data, body };
}

/** Non-throwing parse, for bulk reads that quarantine failures. */
export function safeParseMemfile(
  source: string,
  file?: string,
): { ok: true; memfile: Memfile } | { ok: false; error: MemfileValidationError } {
  try {
    return { ok: true, memfile: parseMemfile(source, file) };
  } catch (error) {
    if (error instanceof MemfileValidationError) return { ok: false, error };
    throw error;
  }
}

/**
 * Re-serialize a parsed Memfile. Round-tripping must be a fixed point:
 * parse(serialize(x)) === x and serialize(parse(s)) === s for canonical s.
 */
export function serializeMemfileRecord(memfile: Memfile, file?: string): string {
  return serializeMemfile(memfile.frontmatter, memfile.body, file);
}
