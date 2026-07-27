import { describe, expect, it } from "vitest";
import type { Memory } from "@membook/spec";
import { LlmRechecker } from "./llm-recheck.js";
import type { CompletionResult, ModelProvider } from "./provider.js";
import type { RecheckRequest } from "./recheck.js";
import type { Instrumentation, MembookEvent } from "./instrumentation.js";

const COMMIT = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";

const MEMORY: Memory = {
  memfile: 2,
  id: "m-4f2a",
  type: "gotcha",
  status: "verified",
  scope: "repo",
  confidence: 0.9,
  created: "2026-07-01T00:00:00Z",
  verified: "2026-07-20T00:00:00Z",
  anchors: [{ kind: "git", path: "src/auth.ts", commit: COMMIT }],
  provenance: {
    origin: "authored",
    author: "agent",
    session: "s",
    agent: "claude-code",
    model: "claude-opus-4-8",
  },
};

const ANCHORED_CODE =
  "export function refreshToken() { return onRequestBoundary(); }";

const REQUEST: RecheckRequest = {
  memory: MEMORY,
  body: "Auth tokens refresh on the request boundary.",
  touched: [
    {
      anchor: MEMORY.anchors[0]!,
      change: { kind: "modified", path: "src/auth.ts" },
    },
  ],
};

/** A provider that replies with whatever the test dictates. */
function providerReplying(...replies: Array<string | Error>): ModelProvider & {
  calls: number;
} {
  let calls = 0;
  return {
    name: "fake",
    model: "test",
    get calls() {
      return calls;
    },
    async complete(): Promise<CompletionResult> {
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls += 1;
      if (reply instanceof Error) throw reply;
      return { text: reply ?? "", inputTokens: 10, outputTokens: 5 };
    },
  };
}

function recorder(): Instrumentation & { events: MembookEvent[] } {
  const events: MembookEvent[] = [];
  return { events, record: (e) => void events.push(e) };
}

/**
 * The re-checker's dangerous failure is the FALSE RESTORE: laundering a stale
 * memory into a verified one. Every path that is not an explicit, well-formed
 * restore must leave the memory stale.
 */
describe("INVARIANT: nothing but an explicit verdict can restore a memory", () => {
  const nonAnswers: Array<[string, string | Error]> = [
    ["unparseable prose", "I think it's probably still fine, honestly."],
    ["empty reply", ""],
    ["malformed JSON", '{"verdict": "restore"'],
    ["wrong shape", '{"result": "ok"}'],
    ["unknown verdict", '{"verdict": "probably-fine", "reason": "vibes"}'],
    ["missing reason", '{"verdict": "restore"}'],
    ["provider error", new Error("connection refused")],
    ["provider 500", new Error("anthropic returned 500")],
  ];

  it.each(nonAnswers)("stays stale on %s", async (_label, reply) => {
    const rechecker = new LlmRechecker({
      provider: providerReplying(reply, reply),
    });
    const result = await rechecker.recheck(REQUEST);
    expect(result.verdict).toBe("stale");
  });

  it("explains that it stayed stale rather than being assumed true", async () => {
    const rechecker = new LlmRechecker({
      provider: providerReplying(new Error("connection refused")),
    });
    const result = await rechecker.recheck(REQUEST);
    expect(result.reason).toMatch(/rather than being assumed true/);
  });

  it("does not restore even when the model insists in prose", async () => {
    const rechecker = new LlmRechecker({
      provider: providerReplying(
        "RESTORE! The memory is definitely still true, verified, correct.",
        "Still restore, I am certain."
      ),
    });
    expect((await rechecker.recheck(REQUEST)).verdict).toBe("stale");
  });
});

describe("well-formed verdicts", () => {
  it("restores on an explicit restore", async () => {
    const rechecker = new LlmRechecker({
      provider: providerReplying(
        '{"verdict": "restore", "reason": "refreshToken still runs on the request boundary", "evidence": "return onRequestBoundary();"}'
      ),
      readAnchor: async () => ANCHORED_CODE,
    });
    const result = await rechecker.recheck(REQUEST);
    expect(result.verdict).toBe("verified");
    expect(result.reason).toContain("request boundary");
  });

  it("keeps it stale on still-stale", async () => {
    const rechecker = new LlmRechecker({
      provider: providerReplying(
        '{"verdict": "still-stale", "reason": "the refresh path moved and I cannot confirm the timing"}'
      ),
    });
    expect((await rechecker.recheck(REQUEST)).verdict).toBe("stale");
  });

  /**
   * A model's `invalidate` lands as STALE, not invalidated.
   *
   * Measured on this repo's own memories: the first live invalidate verdict
   * was a 3B destroying "publish with pnpm, never npm" — still true — because
   * a version number changed in the anchored package.json. Restore requires
   * grounded evidence precisely so a rubber-stamp cannot assert falsehoods;
   * letting the same model destroy truths on its bare word was the identical
   * hole in the other direction. `invalidated` is now reachable only through
   * deterministic evidence (anchored file deleted) or a human in review.
   */
  it("demotes a model invalidate to stale — models may not destroy", async () => {
    const rechecker = new LlmRechecker({
      provider: providerReplying(
        '{"verdict": "invalidate", "reason": "the timer-based refresh replaced the boundary check"}'
      ),
    });
    expect((await rechecker.recheck(REQUEST)).verdict).toBe("stale");
  });

  it("unwraps a fenced JSON reply rather than spending a repair on formatting", async () => {
    const rechecker = new LlmRechecker({
      provider: providerReplying(
        '```json\n{"verdict": "restore", "reason": "still true", "evidence": "return onRequestBoundary();"}\n```'
      ),
      readAnchor: async () => ANCHORED_CODE,
    });
    const provider = providerReplying("");
    void provider;
    expect((await rechecker.recheck(REQUEST)).verdict).toBe("verified");
  });
});

/**
 * THE GROUNDING INVARIANT.
 *
 * A restore is the only verdict that grants trust back, so it is the only one
 * that can launder staleness. The first live re-check returned three restores
 * whose stated reasons cited a different memory's subject, argued for caution,
 * and were factually wrong — right verdicts only because the memories happened
 * to be true. A model that restores for bad reasons will restore FALSE
 * memories for bad reasons too.
 *
 * So the citation is checked against the file rather than believed. A
 * rubber-stamping model can no longer restore; it can only fail to.
 */
describe("INVARIANT: a restore must cite evidence that really exists", () => {
  const CODE =
    "export function refreshToken() {\n  return onRequestBoundary();\n}\n";
  const grounded = (verdict: string, evidence?: string): ModelProvider => ({
    name: "fake",
    model: "test",
    async complete() {
      return {
        text: JSON.stringify({
          verdict,
          reason: "some reason",
          ...(evidence !== undefined ? { evidence } : {}),
        }),
        inputTokens: null,
        outputTokens: null,
      };
    },
  });

  const withCode = (provider: ModelProvider, log?: Instrumentation) =>
    new LlmRechecker({
      provider,
      readAnchor: async () => CODE,
      ...(log ? { instrumentation: log } : {}),
    });

  it("accepts a restore whose evidence appears in the code", async () => {
    const r = await withCode(
      grounded("restore", "return onRequestBoundary();")
    ).recheck(REQUEST);
    expect(r.verdict).toBe("verified");
  });

  it("rejects a restore whose evidence is not in the code", async () => {
    const r = await withCode(
      grounded("restore", "return setTimeout(refresh, 300000);")
    ).recheck(REQUEST);
    expect(r.verdict).toBe("stale");
    expect(r.reason).toMatch(/cited evidence does not appear/);
  });

  it("rejects a restore that cites no evidence at all", async () => {
    const r = await withCode(grounded("restore")).recheck(REQUEST);
    expect(r.verdict).toBe("stale");
    expect(r.reason).toMatch(/no verbatim evidence/);
  });

  // The actual 3B failure: plausible prose about a real symbol from a
  // different file, which no amount of reading the reason would catch.
  it("rejects the rubber-stamp that started this", async () => {
    const r = await withCode(
      grounded(
        "restore",
        "`gitAnchorSchema` was modified, and now requires `commitSha`"
      )
    ).recheck(REQUEST);
    expect(r.verdict).toBe("stale");
  });

  it("rejects a trivially short quote that proves nothing", async () => {
    const r = await withCode(grounded("restore", "}")).recheck(REQUEST);
    expect(r.verdict).toBe("stale");
  });

  it("tolerates reformatted whitespace in an honest quote", async () => {
    const r = await withCode(
      grounded("restore", "export   function\n   refreshToken()   {")
    ).recheck(REQUEST);
    expect(r.verdict).toBe("verified");
  });

  it("cannot restore when nothing can read the code to check against", async () => {
    // No readAnchor: the citation is unverifiable, and an unverifiable claim
    // is not a verified one.
    const r = await new LlmRechecker({
      provider: grounded("restore", "return onRequestBoundary();"),
    }).recheck(REQUEST);
    expect(r.verdict).toBe("stale");
  });

  it("needs no evidence for the verdicts that cannot destroy or assert", async () => {
    expect(
      (await withCode(grounded("still-stale")).recheck(REQUEST)).verdict
    ).toBe("stale");
    // Even WITH plausible evidence attached, invalidate lands as stale: there
    // is no string a model can produce that proves a memory false the way a
    // verbatim quote proves code present.
    expect(
      (await withCode(grounded("invalidate")).recheck(REQUEST)).verdict
    ).toBe("stale");
  });
});

describe("grounding telemetry", () => {
  const CODE = "export function refreshToken() {}\n";

  it("records reason_grounded true on an accepted restore", async () => {
    const log = recorder();
    await new LlmRechecker({
      provider: providerReplying(
        '{"verdict":"restore","reason":"still true","evidence":"export function refreshToken()"}'
      ),
      instrumentation: log,
      readAnchor: async () => CODE,
    }).recheck(REQUEST);
    expect(log.events[0]).toMatchObject({
      verdict: "verified",
      reason_grounded: true,
    });
  });

  it("records reason_grounded false when a restore is rejected", async () => {
    const log = recorder();
    await new LlmRechecker({
      provider: providerReplying(
        '{"verdict":"restore","reason":"trust me","evidence":"nothing like this exists"}'
      ),
      instrumentation: log,
      readAnchor: async () => CODE,
    }).recheck(REQUEST);
    // Logged as what actually happened, not as what was asked for.
    expect(log.events[0]).toMatchObject({
      verdict: "stale",
      reason_grounded: false,
    });
  });
});

describe("the repair attempt", () => {
  it("asks exactly once more, then gives up", async () => {
    const provider = providerReplying(
      "nonsense",
      "still nonsense",
      "more nonsense"
    );
    const rechecker = new LlmRechecker({ provider });
    await rechecker.recheck(REQUEST);
    expect(provider.calls).toBe(2);
  });

  it("accepts a repaired reply", async () => {
    const provider = providerReplying(
      "Sure, I think so.",
      '{"verdict": "restore", "reason": "confirmed", "evidence": "return onRequestBoundary();"}'
    );
    const rechecker = new LlmRechecker({
      provider,
      readAnchor: async () => ANCHORED_CODE,
    });
    expect((await rechecker.recheck(REQUEST)).verdict).toBe("verified");
  });

  it("does not re-argue the substance, only the shape", async () => {
    let secondPrompt = "";
    let calls = 0;
    const provider: ModelProvider = {
      name: "fake",
      model: "test",
      async complete(request) {
        calls += 1;
        if (calls === 2) secondPrompt = request.user;
        return { text: "nope", inputTokens: null, outputTokens: null };
      },
    };
    await new LlmRechecker({ provider }).recheck(REQUEST);
    expect(secondPrompt).toContain("not valid JSON");
    // Re-arguing would invite the model to talk itself into a restore.
    expect(secondPrompt).not.toMatch(/reconsider|are you sure|think again/i);
  });
});

describe("instrumentation", () => {
  it("logs every verdict, so accuracy is measurable later", async () => {
    const log = recorder();
    const rechecker = new LlmRechecker({
      provider: providerReplying(
        '{"verdict": "restore", "reason": "still true", "evidence": "return onRequestBoundary();"}'
      ),
      instrumentation: log,
      readAnchor: async () => ANCHORED_CODE,
    });
    await rechecker.recheck(REQUEST);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]).toMatchObject({
      event: "recheck",
      id: "m-4f2a",
      verdict: "verified",
    });
  });

  it("marks a failed re-check as failed, not as a real verdict", async () => {
    const log = recorder();
    await new LlmRechecker({
      provider: providerReplying(new Error("down")),
      instrumentation: log,
    }).recheck(REQUEST);
    expect(log.events[0]).toMatchObject({ event: "recheck", failed: true });
  });

  it("records that a repair was needed", async () => {
    const log = recorder();
    await new LlmRechecker({
      provider: providerReplying(
        "nope",
        '{"verdict": "still-stale", "reason": "cannot confirm"}'
      ),
      instrumentation: log,
    }).recheck(REQUEST);
    expect(log.events[0]).toMatchObject({ repaired: true });
  });

  it("attributes the verdict to a named checker", async () => {
    const log = recorder();
    await new LlmRechecker({
      provider: providerReplying(
        '{"verdict": "restore", "reason": "ok", "evidence": "return onRequestBoundary();"}'
      ),
      instrumentation: log,
      readAnchor: async () => ANCHORED_CODE,
    }).recheck(REQUEST);
    expect((log.events[0] as { checker: string }).checker).toBe(
      "llm:fake:test"
    );
  });
});

describe("the prompt", () => {
  it("carries the statement, the anchors and what changed", async () => {
    let prompt = "";
    const provider: ModelProvider = {
      name: "fake",
      model: "test",
      async complete(request) {
        prompt = request.user;
        return {
          text: '{"verdict": "still-stale", "reason": "x"}',
          inputTokens: null,
          outputTokens: null,
        };
      },
    };
    await new LlmRechecker({ provider }).recheck(REQUEST);
    expect(prompt).toContain("Auth tokens refresh on the request boundary.");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("modified");
  });

  it("instructs the model that absence of contradiction is not evidence", async () => {
    let system = "";
    const provider: ModelProvider = {
      name: "fake",
      model: "test",
      async complete(request) {
        system = request.system;
        return {
          text: '{"verdict": "still-stale", "reason": "x"}',
          inputTokens: null,
          outputTokens: null,
        };
      },
    };
    await new LlmRechecker({ provider }).recheck(REQUEST);
    expect(system).toMatch(/Absence of\s+contradiction is not evidence/);
    expect(system).toMatch(/skeptic, not a judge/);
  });

  it("includes current file content when a reader is supplied", async () => {
    let prompt = "";
    const provider: ModelProvider = {
      name: "fake",
      model: "test",
      async complete(request) {
        prompt = request.user;
        return {
          text: '{"verdict": "still-stale", "reason": "x"}',
          inputTokens: null,
          outputTokens: null,
        };
      },
    };
    await new LlmRechecker({
      provider,
      readAnchor: async () => "export function refreshToken() {}",
      readDiff: async () => "- old line\n+ new line",
    }).recheck(REQUEST);
    expect(prompt).toContain("export function refreshToken");
    expect(prompt).toContain("+ new line");
  });
});
