import { z } from "zod";
import { formatAnchor } from "@membook/spec";
import type {
  AnchorRechecker,
  RecheckRequest,
  RecheckResult,
  RecheckVerdict,
} from "./recheck.js";
import type { ModelProvider } from "./provider.js";
import type { Instrumentation } from "./instrumentation.js";
import { NullInstrumentation } from "./instrumentation.js";

/**
 * THE RE-CHECKER IS A SKEPTIC, NOT A JUDGE.
 *
 * Its dangerous failure is the FALSE RESTORE — laundering a stale memory into
 * a verified one. `verified` is a claim users act on, so a re-checker that
 * rubber-stamps is worse than none at all: it converts honest uncertainty
 * into confident wrongness.
 *
 * Every path here therefore falls to `still-stale`. Unparseable reply, failed
 * repair, provider down, unknown verdict — all of them leave the memory
 * stale. The only route to `restore` is a well-formed verdict that says so.
 *
 * The prompt lives in `prompts/recheck.md`, versioned and reviewed like code.
 */

export const VERDICTS = ["restore", "still-stale", "invalidate"] as const;

const verdictSchema = z
  .object({
    verdict: z.enum(VERDICTS),
    reason: z.string().min(1),
    /**
     * A verbatim quote from the anchored file at HEAD. Required to restore,
     * and checked against the actual file before the restore is accepted.
     */
    evidence: z.string().optional(),
  })
  .strict();

/**
 * Whitespace-insensitive containment.
 *
 * Models reflow and re-indent what they quote, so an exact match would reject
 * honest citations. Collapsing whitespace on both sides keeps the check about
 * whether the code is really there, not about how it was formatted.
 */
export function quoteAppearsIn(haystack: string, quote: string): boolean {
  const normalise = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = normalise(quote);
  // Too short to mean anything — a model quoting `}` proves nothing.
  if (needle.length < 8) return false;
  return normalise(haystack).includes(needle);
}

/** Maps the model's vocabulary onto memory statuses. */
const TO_STATUS: Record<(typeof VERDICTS)[number], RecheckVerdict> = {
  restore: "verified",
  "still-stale": "stale",
  invalidate: "invalidated",
};

const SYSTEM = [
  "You check whether a recorded project memory is still true after the code it",
  "describes has changed.",
  "",
  "You are a skeptic, not a judge. Returning `restore` for a memory that is no",
  "longer true is far worse than leaving a true memory stale: a restored memory",
  "is presented to engineers as verified fact, while a stale one is merely",
  "re-checked later.",
  "",
  "Restoration requires affirmative evidence in the current code. Absence of",
  "contradiction is not evidence. If the change is ambiguous, if you cannot see",
  "enough to be sure, or if the statement is only partly outdated, the answer is",
  "`still-stale`.",
  "",
  'To restore, you MUST quote verbatim, in an "evidence" field, the exact line',
  "or lines in the CURRENT code that make the statement true. That quotation is",
  "checked against the file: if it does not appear there, the restore is",
  "rejected and the memory stays stale. Do not paraphrase, and do not quote the",
  "memory back at yourself — quote the code.",
  "",
  "Reply with JSON only.",
].join("\n");

export interface LlmRecheckerOptions {
  provider: ModelProvider;
  instrumentation?: Instrumentation;
  /** Supplies the current content of an anchored file, when available. */
  readAnchor?: (path: string) => Promise<string | null>;
  /** Supplies the diff for an anchor since its last-verified commit. */
  readDiff?: (path: string, since: string) => Promise<string | null>;
  /** Characters of file content to include per anchor. */
  maxContextChars?: number;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Models fence JSON often enough that refusing to unwrap it would spend a
  // repair round-trip on formatting rather than substance.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export class LlmRechecker implements AnchorRechecker {
  readonly name: string;
  private readonly provider: ModelProvider;
  private readonly instrumentation: Instrumentation;
  private readonly readAnchor:
    | ((path: string) => Promise<string | null>)
    | undefined;
  private readonly readDiff:
    | ((path: string, since: string) => Promise<string | null>)
    | undefined;
  private readonly maxContextChars: number;

  constructor(options: LlmRecheckerOptions) {
    this.provider = options.provider;
    this.name = `llm:${options.provider.name}:${options.provider.model}`;
    this.instrumentation = options.instrumentation ?? new NullInstrumentation();
    this.readAnchor = options.readAnchor;
    this.readDiff = options.readDiff;
    this.maxContextChars = options.maxContextChars ?? 4000;
  }

  /**
   * Does the cited evidence actually exist in the anchored code at HEAD?
   *
   * Checked across every anchored file, since a memory may span several and
   * the model is not told which one to quote from.
   *
   * With no `readAnchor` configured we cannot check, and an unverifiable
   * claim is not a verified one: no reader means no grounding, which means no
   * restore. That is deliberately strict — the alternative is trusting a
   * citation nobody can confirm, which is the exact failure being fixed.
   */
  private async isGrounded(
    request: RecheckRequest,
    evidence: string | undefined
  ): Promise<boolean> {
    if (evidence === undefined || evidence.trim().length === 0) return false;
    if (!this.readAnchor) return false;

    for (const anchor of request.memory.anchors) {
      const content = await this.readAnchor(anchor.path);
      if (content !== null && quoteAppearsIn(content, evidence)) return true;
    }
    return false;
  }

  private async buildPrompt(request: RecheckRequest): Promise<string> {
    const { memory, body, touched } = request;
    const parts: string[] = [
      `MEMORY (recorded ${memory.created}${
        memory.verified
          ? `, last verified ${memory.verified}`
          : ", never verified"
      }):`,
      body,
      "",
      "IT IS ANCHORED TO:",
      ...memory.anchors.map((a) => `- ${formatAnchor(a)}`),
      "",
      "WHAT CHANGED:",
    ];

    for (const { anchor, change } of touched) {
      parts.push(`- ${anchor.path}: ${change?.kind ?? "changed"}`);
      const diff = await this.readDiff?.(anchor.path, anchor.commit);
      if (diff) parts.push(diff.slice(0, this.maxContextChars));
    }

    if (this.readAnchor) {
      parts.push("", "CURRENT CONTENT:");
      for (const { anchor } of touched) {
        const current = await this.readAnchor(anchor.path);
        if (current !== null) {
          parts.push(
            `--- ${anchor.path} ---`,
            current.slice(0, this.maxContextChars)
          );
        }
      }
    }

    parts.push(
      "",
      'Reply with JSON only: {"verdict": "restore" | "still-stale" | "invalidate", "reason": "<one sentence>", "evidence": "<verbatim quote from the CURRENT content above — required to restore, and checked against the file>"}'
    );
    return parts.join("\n");
  }

  async recheck(request: RecheckRequest): Promise<RecheckResult> {
    const id = request.memory.id;
    const user = await this.buildPrompt(request);

    let repaired = false;
    let raw: string;
    try {
      raw = (await this.provider.complete({ system: SYSTEM, user })).text;
    } catch (error) {
      // Provider unreachable is not evidence of anything. Stay stale.
      this.instrumentation.record({
        event: "recheck",
        id,
        verdict: "stale",
        checker: this.name,
        failed: true,
      });
      return {
        verdict: "stale",
        reason: `re-check could not run (${
          (error as Error).message
        }); the memory stays stale rather than being assumed true`,
      };
    }

    let parsed = verdictSchema.safeParse(extractJson(raw));

    if (!parsed.success) {
      // One repair attempt, asking only for the shape — never re-arguing the
      // substance, which would invite the model to talk itself into a restore.
      repaired = true;
      try {
        const retry = await this.provider.complete({
          system: SYSTEM,
          user: [
            user,
            "",
            "Your previous reply was not valid JSON matching the required shape.",
            "Reply with ONLY this JSON object and nothing else:",
            '{"verdict": "restore" | "still-stale" | "invalidate", "reason": "<one sentence>", "evidence": "<verbatim quote, required to restore>"}',
          ].join("\n"),
        });
        parsed = verdictSchema.safeParse(extractJson(retry.text));
      } catch {
        parsed = verdictSchema.safeParse(null);
      }
    }

    if (!parsed.success) {
      this.instrumentation.record({
        event: "recheck",
        id,
        verdict: "stale",
        checker: this.name,
        repaired: true,
        failed: true,
      });
      return {
        verdict: "stale",
        reason:
          "re-check reply could not be parsed after one repair attempt; the memory stays stale rather than being guessed at",
      };
    }

    const verdict = TO_STATUS[parsed.data.verdict];

    // GROUND THE RESTORE.
    //
    // A restore is the only verdict that grants trust back, so it is the only
    // one that can launder staleness. The first live re-check returned three
    // restores whose stated reasons cited a different memory's subject, argued
    // for caution, and were factually wrong — right verdicts by coincidence,
    // because the memories happened to be true. A model that restores for bad
    // reasons will restore FALSE memories for bad reasons too.
    //
    // So the citation is checked rather than believed: the quoted evidence
    // must actually appear in the anchored file at HEAD. This is the product's
    // own move — verify the claim against reality — turned on its re-checker.
    // Deterministic, model-agnostic, and it fails in the safe direction: a
    // rubber-stamping model can no longer restore, only fail to.
    let grounded: boolean | undefined;
    if (verdict === "verified") {
      grounded = await this.isGrounded(request, parsed.data.evidence);
      if (!grounded) {
        this.instrumentation.record({
          event: "recheck",
          id,
          verdict: "stale",
          checker: this.name,
          reason_grounded: false,
          ...(repaired ? { repaired: true } : {}),
        });
        return {
          verdict: "stale",
          reason: parsed.data.evidence
            ? `restore rejected: the cited evidence does not appear in the anchored code (${JSON.stringify(
                parsed.data.evidence.slice(0, 60)
              )}), so the memory stays stale`
            : "restore rejected: no verbatim evidence was cited from the anchored code, so the memory stays stale",
        };
      }
    }

    this.instrumentation.record({
      event: "recheck",
      id,
      verdict,
      checker: this.name,
      ...(grounded !== undefined ? { reason_grounded: grounded } : {}),
      ...(repaired ? { repaired: true } : {}),
    });

    return { verdict, reason: parsed.data.reason };
  }
}
