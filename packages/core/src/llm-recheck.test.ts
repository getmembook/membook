import { describe, expect, it } from "vitest";
import type { Memory } from "@membook/spec";
import { LlmRechecker } from "./llm-recheck.js";
import type { CompletionResult, ModelProvider } from "./provider.js";
import type { RecheckRequest } from "./recheck.js";
import type { Instrumentation, MembookEvent } from "./instrumentation.js";

const COMMIT = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";

const MEMORY: Memory = {
  memfile: 1,
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
        '{"verdict": "restore", "reason": "refreshToken still runs on the request boundary at line 42"}'
      ),
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

  it("invalidates on invalidate", async () => {
    const rechecker = new LlmRechecker({
      provider: providerReplying(
        '{"verdict": "invalidate", "reason": "the timer-based refresh replaced the boundary check"}'
      ),
    });
    expect((await rechecker.recheck(REQUEST)).verdict).toBe("invalidated");
  });

  it("unwraps a fenced JSON reply rather than spending a repair on formatting", async () => {
    const rechecker = new LlmRechecker({
      provider: providerReplying(
        '```json\n{"verdict": "restore", "reason": "still true at line 42"}\n```'
      ),
    });
    const provider = providerReplying("");
    void provider;
    expect((await rechecker.recheck(REQUEST)).verdict).toBe("verified");
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
      '{"verdict": "restore", "reason": "confirmed at line 42"}'
    );
    const rechecker = new LlmRechecker({ provider });
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
        '{"verdict": "restore", "reason": "still true"}'
      ),
      instrumentation: log,
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
      provider: providerReplying('{"verdict": "restore", "reason": "ok"}'),
      instrumentation: log,
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
