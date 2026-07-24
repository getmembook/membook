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
  })
  .strict();

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
      'Reply with JSON only: {"verdict": "restore" | "still-stale" | "invalidate", "reason": "<one sentence citing the specific code or change that decided it>"}'
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
            '{"verdict": "restore" | "still-stale" | "invalidate", "reason": "<one sentence>"}',
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
    this.instrumentation.record({
      event: "recheck",
      id,
      verdict,
      checker: this.name,
      ...(repaired ? { repaired: true } : {}),
    });

    return { verdict, reason: parsed.data.reason };
  }
}
