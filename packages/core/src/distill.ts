import { createHash } from "node:crypto";
import { z } from "zod";
import { MEMORY_TYPES, type MemoryType } from "@membook/spec";
import type { ModelProvider } from "./provider.js";
import { ProviderError } from "./provider.js";
import type { Instrumentation } from "./instrumentation.js";
import { NullInstrumentation } from "./instrumentation.js";
import { scanForSecrets } from "./secret-scan.js";

/**
 * DISTILLATION REJECTS BY DEFAULT.
 *
 * The economics say write generously — break-even reuse probability for a
 * memory is only 3–6%. The economics also say retrieval precision is the
 * binding constraint, because a wrong memory retrieved into a loop inflates
 * per-step error roughly sevenfold. Those pull in opposite directions, and
 * this file resolves them: generous about *whether* to write, ruthless about
 * *what* qualifies.
 *
 * So every candidate must survive three gates, and each one is cheap:
 *
 *   1. SCHEMA — a well-formed candidate of a known type, or one repair retry,
 *      then nothing. A model that cannot produce the shape does not get to
 *      write memories.
 *   2. GROUNDING — every anchor path must actually exist in the repository.
 *      A model asked to name files will invent plausible ones, and an anchor
 *      to a file that does not exist can never be verified, so it is not a
 *      memory, it is a rumour.
 *   3. SECRETS — a candidate carrying a credential is dropped before a human
 *      ever sees it, not merely blocked at the write.
 *
 * Everything that fails a gate is DISCARDED, silently to the model and
 * visibly to the caller. The failure mode this avoids is a seeded book full
 * of confident nonsense, which would poison the retrieval surface on day one
 * and teach the user that the tool is noise.
 */

export const MAX_STATEMENT_CHARS = 400;

/**
 * The model-facing prompt for session distillation, mirroring
 * `prompts/distill.md`.
 *
 * Inlined so the package carries no runtime file dependency; a test asserts it
 * is character-identical to the reviewed markdown, because a prompt file that
 * nothing reads is documentation of an intention rather than of behaviour.
 *
 * It is a stricter sibling of `SEED_SYSTEM`. Seeding reads prose someone chose
 * to write down; a session is mostly narration surrounding a few durable
 * findings, and narration that felt significant while it happened is the
 * dominant false positive.
 */
export const DISTILL_SYSTEM = `You extract durable project memories from notes taken during a working session
on a software project.

A memory is a specific, non-obvious claim about THIS project that would save a
future engineer real time. Five kinds, and nothing else qualifies:

- **decision** — a choice that was made, and the reason for it
- **gotcha** — a trap that is not visible from reading the code
- **convention** — a rule this project follows that an outsider would not guess
- **map** — where a particular responsibility actually lives
- **deadend** — an approach already tried that did not work, and why

REJECTION IS THE DEFAULT. Most of a session is transient: what was tried, what
an error said, which files were opened, what the task was. None of that is a
memory. Returning an empty list is a correct and common answer, and is far
better than returning something weak.

Ask of every candidate: would someone who has never seen this session, six
months from now, be glad this was written down? If you are not sure, drop it.

Do NOT emit:

- what happened, in narrative form — a memory is a claim, not a report
- anything about the specific task, ticket, or bug being worked on
- a fact that will change the next time someone touches the code
- restatements of what the code plainly says, or of an error message
- anything a competent engineer would assume by default
- generic best practice that is not specific to this project
- anything whose truth you cannot tie to a specific file

The strongest memories from a session are usually: a constraint discovered the
hard way, an approach that failed for a reason that will not change, and the
real reason behind a choice that looks arbitrary from outside.

Each memory MUST cite the files it is about, in \`paths\`. Cite only paths that
appear in the notes — a cited path that does not exist in the repository causes
the memory to be discarded, because an anchor that cannot be checked is not a
memory.

Write each \`statement\` as a claim, not a topic. Lead with what is true, then
why it matters. Imperative, terse, self-contained, at most two sentences. It
will be read cold, months from now, by someone with no other context.

Set \`confidence\` to how sure you are the claim is true and durable: 0.9 when
the session settled it outright, 0.6 when you are inferring it, below 0.5 not
at all — omit it instead.

Never include credentials, tokens, connection strings, hostnames, or personal
data in a statement.

Reply with JSON only, in exactly this shape:

\`\`\`json
{
  "memories": [
    {
      "statement": "...",
      "type": "gotcha",
      "paths": ["src/example.ts"],
      "confidence": 0.8
    }
  ]
}
\`\`\`

If nothing in the session qualifies, reply \`{"memories": []}\`.`;

const candidateSchema = z
  .object({
    statement: z.string().min(1).max(MAX_STATEMENT_CHARS),
    type: z.enum(MEMORY_TYPES),
    paths: z.array(z.string().min(1)).min(1),
    symbol: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const replySchema = z.object({ memories: z.array(candidateSchema) });

export interface DistillCandidate {
  statement: string;
  type: MemoryType;
  paths: string[];
  symbol?: string;
  confidence: number;
}

/** Why a candidate the model produced was not kept. */
export type RejectionReason =
  | "ungrounded-anchor"
  | "secret"
  | "duplicate"
  | "malformed";

export interface DistillRejection {
  statement: string;
  reason: RejectionReason;
  detail: string;
}

export interface DistillResult {
  candidates: DistillCandidate[];
  rejected: DistillRejection[];
  /** sha256 of the exact text the model consumed — becomes `source_hash`. */
  sourceHash: string;
  /** True when the provider had to be asked a second time. */
  repaired: boolean;
  /** True when the provider never produced anything usable. */
  failed: boolean;
}

export interface DistillSource {
  /** Repo-relative path. Used as the fallback anchor and shown to the model. */
  path: string;
  content: string;
}

export interface DistillOptions {
  provider: ModelProvider;
  instrumentation?: Instrumentation;
  /**
   * Decides whether an anchor path is real. Supplied by the caller because
   * core does no I/O of its own; in practice this is "exists at HEAD".
   */
  pathExists: (path: string) => Promise<boolean>;
  /** Statements already recorded, for cheap exact-duplicate suppression. */
  existing?: readonly string[];
  /** Cap on how many candidates one source may yield. */
  maxPerSource?: number;
}

export const DEFAULT_MAX_PER_SOURCE = 6;

export function sourceHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Normalised for duplicate detection only.
 *
 * Deliberately crude — case and punctuation folded, nothing semantic. A near
 * miss slipping through costs one redundant candidate that a human declines
 * in `review`; an aggressive matcher silently swallowing a real memory costs
 * knowledge, and only one of those is recoverable.
 */
function normalise(statement: string): string {
  return statement
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? text).trim();
  // Models prepend prose to JSON often enough that finding the object is worth
  // it; anything past this and the reply genuinely is not JSON.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object in reply");
  }
  return JSON.parse(body.slice(start, end + 1));
}

const REPAIR =
  "Your previous reply could not be parsed. Reply with JSON only — no prose, " +
  'no code fence — in exactly this shape: {"memories": [{"statement": "...", ' +
  '"type": "decision|gotcha|convention|map|deadend", "paths": ["path/to/file"], ' +
  '"confidence": 0.8}]}. If nothing qualifies, reply {"memories": []}.';

/**
 * Ask a model what is worth remembering from one source, then refuse most of
 * the answer.
 *
 * Returns an empty candidate list rather than throwing when the provider is
 * unreachable or unparseable: a distillation that fails should cost the user
 * nothing, and there is no safe fallback that invents memories.
 */
export async function distill(
  source: DistillSource,
  system: string,
  options: DistillOptions
): Promise<DistillResult> {
  const instrumentation = options.instrumentation ?? new NullInstrumentation();
  const max = options.maxPerSource ?? DEFAULT_MAX_PER_SOURCE;
  const hash = sourceHash(source.content);

  const user = [`File: ${source.path}`, "", "Content:", source.content].join(
    "\n"
  );

  let raw: string;
  let repaired = false;
  let parsed: z.infer<typeof replySchema> | undefined;

  const empty = (failed: boolean): DistillResult => ({
    candidates: [],
    rejected: [],
    sourceHash: hash,
    repaired,
    failed,
  });

  try {
    raw = (await options.provider.complete({ system, user, maxTokens: 2048 }))
      .text;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    instrumentation.record({
      event: "distill",
      source: source.path,
      kept: 0,
      rejected: 0,
      failed: true,
    });
    return empty(true);
  }

  const attempt = (text: string): z.infer<typeof replySchema> | undefined => {
    try {
      const result = replySchema.safeParse(extractJson(text));
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  };

  parsed = attempt(raw);

  if (parsed === undefined) {
    // One repair attempt, then give up. A second failure is a model that
    // cannot hold the contract, and retrying it indefinitely just spends
    // tokens to arrive at the same place.
    repaired = true;
    try {
      const retry = await options.provider.complete({
        system,
        user: `${user}\n\n${REPAIR}`,
        maxTokens: 2048,
      });
      parsed = attempt(retry.text);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      parsed = undefined;
    }
  }

  if (parsed === undefined) {
    instrumentation.record({
      event: "distill",
      source: source.path,
      kept: 0,
      rejected: 0,
      failed: true,
    });
    return empty(true);
  }

  const seen = new Set((options.existing ?? []).map(normalise));
  const candidates: DistillCandidate[] = [];
  const rejected: DistillRejection[] = [];

  for (const candidate of parsed.memories) {
    if (candidates.length >= max) break;

    // A credential never reaches a human review screen, let alone a file.
    const findings = scanForSecrets(candidate.statement);
    if (findings.length > 0) {
      rejected.push({
        statement: "[redacted]",
        reason: "secret",
        detail: findings.map((f) => f.rule).join(", "),
      });
      continue;
    }

    const key = normalise(candidate.statement);
    if (seen.has(key)) {
      rejected.push({
        statement: candidate.statement,
        reason: "duplicate",
        detail: "already recorded",
      });
      continue;
    }

    // GROUNDING. Models asked to cite files invent plausible ones, and an
    // anchor to a nonexistent path is unverifiable by construction — exactly
    // the memory the product exists to prevent.
    const grounded: string[] = [];
    for (const path of candidate.paths) {
      if (await options.pathExists(path)) grounded.push(path);
    }
    if (grounded.length === 0) {
      rejected.push({
        statement: candidate.statement,
        reason: "ungrounded-anchor",
        detail: `no such path: ${candidate.paths.join(", ")}`,
      });
      continue;
    }

    seen.add(key);
    candidates.push({
      statement: candidate.statement.trim(),
      type: candidate.type,
      paths: grounded,
      ...(candidate.symbol !== undefined ? { symbol: candidate.symbol } : {}),
      confidence: candidate.confidence,
    });
  }

  instrumentation.record({
    event: "distill",
    source: source.path,
    kept: candidates.length,
    rejected: rejected.length,
    ...(repaired ? { repaired: true } : {}),
  });

  return { candidates, rejected, sourceHash: hash, repaired, failed: false };
}
