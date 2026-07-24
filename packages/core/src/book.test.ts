import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { computeMemoryId, type MemoryInput } from "@membook/spec";
import { Membook } from "./membook.js";
import { BOOK, estimateTokens } from "./book.js";
import { tempRepo } from "./test-helpers.js";

let root: string;
let cleanup: () => Promise<void>;
let membook: Membook;

const COMMIT = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const NOW = new Date("2026-07-24T12:00:00Z");

beforeEach(async () => {
  ({ root, cleanup } = await tempRepo());
  membook = new Membook(root);
});

afterEach(async () => {
  await cleanup();
});

async function seed(spec: {
  body: string;
  type?: MemoryInput["type"];
  status?: MemoryInput["status"];
  confidence?: number;
  paths?: string[];
}): Promise<string> {
  const id = computeMemoryId(spec.body);
  const status = spec.status ?? "verified";
  await membook.remember(
    {
      memfile: 1,
      id,
      type: spec.type ?? "gotcha",
      status,
      scope: "repo",
      confidence: spec.confidence ?? 0.9,
      created: "2026-07-01T00:00:00Z",
      ...(status === "verified" ? { verified: "2026-07-20T00:00:00Z" } : {}),
      anchors: (spec.paths ?? ["src/a.ts"]).map((path) => ({
        path,
        commit: COMMIT,
      })),
      provenance: {
        origin: "authored",
        author: "agent",
        session: "s",
        agent: "claude-code",
        model: "claude-opus-4-8",
      },
    },
    spec.body
  );
  return id;
}

/**
 * The book is committed AND prepended to every session. Unstable output means
 * noisy pull-request diffs on a file nobody edited, and a prompt-cache miss
 * every time an agent starts.
 */
describe("INVARIANT: identical book state yields byte-identical output", () => {
  it("is stable across repeated compilations", async () => {
    for (let i = 0; i < 5; i++) {
      await seed({ body: `Durable fact number ${i} about the system.` });
    }
    const a = await membook.compileBook({ now: NOW });
    const b = await membook.compileBook({ now: NOW });
    expect(b.content).toBe(a.content);
  });

  it("does not depend on the order memories were written", async () => {
    const bodies = [
      "Alpha fact about connection pooling behaviour.",
      "Beta fact about the retry ladder in the client.",
      "Gamma fact about index rebuild determinism.",
    ];
    for (const body of bodies) await seed({ body });
    const forward = await membook.compileBook({ now: NOW });

    const other = await tempRepo();
    try {
      const second = new Membook(other.root);
      const saved = membook;
      membook = second;
      for (const body of [...bodies].reverse()) await seed({ body });
      const reversed = await second.compileBook({ now: NOW });
      membook = saved;
      expect(reversed.content).toBe(forward.content);
    } finally {
      await other.cleanup();
    }
  });

  it("survives a reindex unchanged", async () => {
    await seed({ body: "A fact that must survive an index rebuild." });
    const before = await membook.compileBook({ now: NOW });
    await membook.reindex();
    expect((await membook.compileBook({ now: NOW })).content).toBe(
      before.content
    );
  });
});

describe("the token cap", () => {
  it("never exceeds the cap, however many memories exist", async () => {
    for (let i = 0; i < 60; i++) {
      await seed({
        body: `Memory ${i}: a reasonably wordy statement about subsystem ${i} that takes up a fair amount of room in the compiled book, deliberately.`,
        paths: [`src/mod${i}.ts`],
      });
    }
    const report = await membook.compileBook({ now: NOW });
    expect(report.tokens).toBeLessThanOrEqual(BOOK.maxTokens);
    expect(report.omitted).toBeGreaterThan(0);
  });

  it("keeps scanning past an entry too large to fit", async () => {
    // A single long memory must not shut out the short ones behind it.
    await seed({
      body: `Huge memory. ${"padding ".repeat(900)}`,
      paths: ["src/big.ts"],
    });
    for (let i = 0; i < 3; i++) {
      await seed({
        body: `Short but valuable fact ${i}.`,
        paths: [`src/s${i}.ts`],
      });
    }
    const report = await membook.compileBook({ now: NOW });
    expect(report.entries.length).toBeGreaterThanOrEqual(3);
    expect(report.tokens).toBeLessThanOrEqual(BOOK.maxTokens);
  });

  it("stops early rather than padding to the cap", async () => {
    await seed({ body: "Just one small fact." });
    const report = await membook.compileBook({ now: NOW });
    expect(report.tokens).toBeLessThan(BOOK.maxTokens / 2);
    expect(report.entries).toHaveLength(1);
  });
});

describe("status weights rather than gates", () => {
  it("includes unverified memories, since a young book is honestly all unverified", async () => {
    await seed({
      body: "An unverified but useful fact.",
      status: "unverified",
    });
    const report = await membook.compileBook({ now: NOW });
    expect(report.entries).toHaveLength(1);
    expect(report.content).toContain("(unverified)");
  });

  it("excludes stale memories outright", async () => {
    await seed({ body: "A stale claim about the indexer.", status: "stale" });
    const report = await membook.compileBook({ now: NOW });
    expect(report.entries).toHaveLength(0);
    expect(report.excluded).toBe(1);
  });

  it("excludes invalidated memories outright", async () => {
    await seed({ body: "An invalidated claim.", status: "invalidated" });
    expect((await membook.compileBook({ now: NOW })).entries).toHaveLength(0);
  });

  it("ranks a verified memory above an equivalent unverified one", async () => {
    await seed({ body: "Aaa identical shape fact one.", status: "unverified" });
    await seed({ body: "Bbb identical shape fact two.", status: "verified" });
    const report = await membook.compileBook({ now: NOW });
    expect(report.entries[0]!.status).toBe("verified");
  });
});

describe("value ranking", () => {
  it("prefers a gotcha over a map of equal size", async () => {
    await seed({
      body: "Equal length statement about the system, one.",
      type: "map",
    });
    await seed({
      body: "Equal length statement about the system, two.",
      type: "gotcha",
    });
    const report = await membook.compileBook({ now: NOW });
    expect(report.entries[0]!.type).toBe("gotcha");
  });

  it("prefers a denser memory: same value, fewer tokens", async () => {
    await seed({ body: "Terse and valuable." });
    await seed({
      body: `Verbose and equally valuable. ${"filler words here ".repeat(40)}`,
    });
    const report = await membook.compileBook({ now: NOW });
    expect(report.entries[0]!.body).toBe("Terse and valuable.");
  });

  it("weights by confidence", async () => {
    await seed({ body: "Aaa low confidence claim here.", confidence: 0.2 });
    await seed({ body: "Bbb high confidence claim here.", confidence: 1 });
    const report = await membook.compileBook({ now: NOW });
    expect(report.entries[0]!.body).toMatch(/high confidence/);
  });
});

describe("the header", () => {
  it("marks the file as generated and says how to regenerate it", async () => {
    await seed({ body: "A fact." });
    const { content } = await membook.compileBook({ now: NOW });
    expect(content).toMatch(/^<!-- Generated by Membook\. Do not edit/);
    expect(content).toContain("membook book");
  });

  it("explains itself to a reader who has never heard of Membook", async () => {
    await seed({ body: "A fact." });
    const { content } = await membook.compileBook({ now: NOW });
    // No jargon in the opening: it must read as plain project documentation.
    expect(content).toContain("# Project memory");
    expect(content).toContain("this repository");
    expect(content).not.toContain("boot pack");
  });

  it("states how far to trust unverified entries", async () => {
    await seed({ body: "A fact.", status: "unverified" });
    const { content } = await membook.compileBook({ now: NOW });
    expect(content).toMatch(/not established fact|informed leads/);
  });

  it("says it carries everything when it does", async () => {
    for (let i = 0; i < 3; i++) await seed({ body: `Fact number ${i}.` });
    const { content } = await membook.compileBook({ now: NOW });
    expect(content).toContain("all 3 eligible memories");
  });

  it("admits when it is only carrying the best of a larger set", async () => {
    for (let i = 0; i < 60; i++) {
      await seed({
        body: `Memory ${i}: a wordy statement about subsystem ${i} taking real room in the compiled book.`,
        paths: [`src/m${i}.ts`],
      });
    }
    const { content, omitted } = await membook.compileBook({ now: NOW });
    expect(omitted).toBeGreaterThan(0);
    expect(content).toMatch(/highest-value of \d+ eligible memories/);
  });

  // Conflating these two would teach the reader the opposite lesson: that the
  // missing memories were less useful, rather than no longer trustworthy.
  it("distinguishes withheld-as-drifted from omitted-for-space", async () => {
    await seed({ body: "A live and useful fact about indexing." });
    await seed({ body: "A drifted claim about the indexer.", status: "stale" });
    await seed({ body: "Another drifted claim.", status: "stale" });

    const { content, excluded, omitted } = await membook.compileBook({
      now: NOW,
    });
    expect(excluded).toBe(2);
    expect(omitted).toBe(0);
    expect(content).toContain("2 further memories are withheld");
    expect(content).toMatch(/changed since they were last checked/);
    expect(content).not.toMatch(/highest-value/);
  });

  it("wraps every line, whatever the counts interpolate to", async () => {
    for (let i = 0; i < 3; i++) await seed({ body: `Fact number ${i}.` });
    const { content } = await membook.compileBook({ now: NOW });
    const headerLines = content.split("\n\n### ")[0]!.split("\n");
    for (const line of headerLines) expect(line.length).toBeLessThanOrEqual(80);
  });

  it("is honest about an empty book", async () => {
    const report = await membook.compileBook({ now: NOW });
    expect(report.content).toContain("No memories yet.");
    expect(report.entries).toHaveLength(0);
  });
});

describe("writing the file", () => {
  it("emits MEMBOOK.md at the repository root", async () => {
    await seed({ body: "A durable fact worth carrying between sessions." });
    const report = await membook.writeBook({ now: NOW });
    expect(await readFile(membook.paths.book, "utf8")).toBe(report.content);
    expect(membook.paths.book.endsWith("MEMBOOK.md")).toBe(true);
  });

  it("rewrites byte-identically when nothing changed", async () => {
    await seed({ body: "A durable fact." });
    await membook.writeBook({ now: NOW });
    const first = await readFile(membook.paths.book, "utf8");
    await membook.writeBook({ now: NOW });
    expect(await readFile(membook.paths.book, "utf8")).toBe(first);
  });

  it("carries the anchors, so a reader can check the claim", async () => {
    await seed({ body: "Anchored fact.", paths: ["src/one.ts", "src/two.ts"] });
    const { content } = await membook.writeBook({ now: NOW });
    expect(content).toContain("src/one.ts");
    expect(content).toContain("src/two.ts");
  });
});

describe("token estimation", () => {
  it("is pessimistic, so the budget is not overshot", async () => {
    const text = "a".repeat(360);
    // Real tokenizers average ~4 chars/token; estimating below that keeps the
    // cap honest when the estimate is wrong.
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(360 / 4);
  });
});
