import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeMemoryId, type MemoryInput } from "@membook/spec";
import { Membook } from "./membook.js";
import { pathAffinity, RANKING } from "./recall.js";
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
  paths: string[];
  status?: MemoryInput["status"];
  created?: string;
  verified?: string;
}): Promise<string> {
  const id = computeMemoryId(spec.body);
  const status = spec.status ?? "verified";
  await membook.remember(
    {
      memfile: 1,
      id,
      type: "gotcha",
      status,
      scope: "repo",
      confidence: 0.9,
      created: spec.created ?? "2026-07-01T00:00:00Z",
      ...(status === "unverified"
        ? {}
        : {
            verified: spec.verified ?? spec.created ?? "2026-07-20T00:00:00Z",
          }),
      anchors: spec.paths.map((path) => ({ path, commit: COMMIT })),
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

describe("path affinity", () => {
  it("scores an exact file match highest", () => {
    expect(pathAffinity("src/auth.ts", "src/auth.ts")).toBe(1);
  });

  it("scores a sibling in the same directory below an exact match", () => {
    const sibling = pathAffinity("src/auth.ts", "src/session.ts");
    expect(sibling).toBeGreaterThan(0);
    expect(sibling).toBeLessThan(1);
  });

  it("scores shared ancestry below a sibling", () => {
    const sibling = pathAffinity("src/a/auth.ts", "src/a/session.ts");
    const cousin = pathAffinity("src/a/auth.ts", "src/b/deep/other.ts");
    expect(cousin).toBeLessThan(sibling);
  });

  it("scores unrelated trees at zero", () => {
    expect(pathAffinity("packages/core/src/a.ts", "docs/readme.md")).toBe(0);
  });
});

describe("the relevance floor", () => {
  it("withholds weak matches instead of padding the response", async () => {
    await seed({
      body: "SQLite index lives under .membook and is a disposable cache.",
      paths: ["src/index-db.ts"],
    });
    await seed({
      body: "Completely unrelated statement about deployment pipelines.",
      paths: ["src/deploy.ts"],
    });

    // "index" hits the first strongly; "deployment" drags the second in
    // weakly under OR matching. Only the strong match should survive.
    const result = await membook.recall("sqlite index cache deployment", {
      now: NOW,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.body).toMatch(/SQLite index/);
    expect(result.withheld.belowFloor).toBe(1);
  });

  it("respects an explicit cap", async () => {
    for (let i = 0; i < 6; i++) {
      await seed({
        body: `Indexing rule number ${i} about sqlite.`,
        paths: ["a.ts"],
      });
    }
    const result = await membook.recall("sqlite indexing rule", {
      limit: 2,
      now: NOW,
    });
    expect(result.hits).toHaveLength(2);
    expect(result.withheld.belowFloor).toBeGreaterThan(0);
  });

  it("returns nothing for a query that matches nothing", async () => {
    await seed({ body: "SQLite index cache.", paths: ["a.ts"] });
    const result = await membook.recall("kubernetes helm chart", { now: NOW });
    expect(result.hits).toEqual([]);
  });
});

describe("status weighting", () => {
  it("never returns invalidated memories, even when asked", async () => {
    await seed({
      body: "Invalidated claim about sqlite indexes.",
      paths: ["a.ts"],
      status: "invalidated",
    });
    const result = await membook.recall("sqlite indexes", {
      statuses: ["invalidated", "verified"],
      now: NOW,
    });
    expect(result.hits).toEqual([]);
  });

  it("ranks a verified memory above an equally relevant stale one", async () => {
    await seed({
      body: "Use WAL mode when opening the sqlite index.",
      paths: ["a.ts"],
      status: "verified",
    });
    await seed({
      body: "Use WAL mode when opening the sqlite index cache.",
      paths: ["b.ts"],
      status: "stale",
    });

    const result = await membook.recall("WAL mode sqlite index", {
      now: NOW,
      floorRatio: 0,
    });
    expect(result.hits[0]!.status).toBe("verified");
  });

  it("reports what it withheld, so silence is distinguishable from absence", async () => {
    await seed({
      body: "Stale claim about the sqlite index.",
      paths: ["a.ts"],
      status: "stale",
    });
    const result = await membook.recall("sqlite index", {
      statuses: ["verified"],
      now: NOW,
    });
    expect(result.hits).toEqual([]);
    expect(result.withheld.byStatus["stale"]).toBe(1);
  });
});

describe("path proximity", () => {
  it("promotes the memory anchored to the file being edited", async () => {
    await seed({
      body: "Retry logic must back off exponentially in the client.",
      paths: ["src/client.ts"],
    });
    await seed({
      body: "Retry logic must back off exponentially in the worker.",
      paths: ["src/worker.ts"],
    });

    const editingWorker = await membook.recall("retry back off exponentially", {
      contextPaths: ["src/worker.ts"],
      now: NOW,
      floorRatio: 0,
    });
    expect(editingWorker.hits[0]!.anchors[0]!.path).toBe("src/worker.ts");

    const editingClient = await membook.recall("retry back off exponentially", {
      contextPaths: ["src/client.ts"],
      now: NOW,
      floorRatio: 0,
    });
    expect(editingClient.hits[0]!.anchors[0]!.path).toBe("src/client.ts");
  });

  it("records proximity as a visible signal", async () => {
    await seed({ body: "Client retry rules.", paths: ["src/client.ts"] });
    const result = await membook.recall("client retry rules", {
      contextPaths: ["src/client.ts"],
      now: NOW,
    });
    expect(result.hits[0]!.signals.proximity).toBe(1);
  });

  it("leaves ordering to relevance when no context paths are given", async () => {
    await seed({ body: "Retry in the client.", paths: ["src/client.ts"] });
    const result = await membook.recall("retry client", { now: NOW });
    expect(result.hits[0]!.signals.proximity).toBe(0);
  });
});

describe("recency", () => {
  it("prefers the more recently verified of two equal memories", async () => {
    await seed({
      body: "Token refresh happens on the boundary in module one.",
      paths: ["a.ts"],
      verified: "2026-01-01T00:00:00Z",
    });
    await seed({
      body: "Token refresh happens on the boundary in module two.",
      paths: ["b.ts"],
      verified: "2026-07-23T00:00:00Z",
    });

    const result = await membook.recall("token refresh boundary module", {
      now: NOW,
      floorRatio: 0,
    });
    expect(result.hits[0]!.body).toMatch(/module two/);
    expect(result.hits[0]!.signals.recency).toBeGreaterThan(
      result.hits[1]!.signals.recency
    );
  });

  it("decays by the configured half-life", async () => {
    await seed({
      body: "Half life check for sqlite.",
      paths: ["a.ts"],
      verified: "2026-04-25T12:00:00Z", // ~90 days before NOW
    });
    const result = await membook.recall("half life check sqlite", { now: NOW });
    expect(result.hits[0]!.signals.recency).toBeCloseTo(0.5, 1);
  });
});

describe("determinism", () => {
  it("ranks identically across repeated calls", async () => {
    for (let i = 0; i < 4; i++) {
      await seed({
        body: `Sqlite indexing note ${i}.`,
        paths: [`src/f${i}.ts`],
      });
    }
    const a = await membook.recall("sqlite indexing note", { now: NOW });
    const b = await membook.recall("sqlite indexing note", { now: NOW });
    expect(b.hits.map((h) => h.id)).toEqual(a.hits.map((h) => h.id));
  });

  it("survives a reindex unchanged", async () => {
    for (let i = 0; i < 4; i++) {
      await seed({
        body: `Sqlite indexing note ${i}.`,
        paths: [`src/f${i}.ts`],
      });
    }
    const before = await membook.recall("sqlite indexing note", { now: NOW });
    await membook.reindex();
    const after = await membook.recall("sqlite indexing note", { now: NOW });
    expect(after).toEqual(before);
  });
});

/**
 * The property that makes the floor mean anything: relevance gates. No
 * combination of freshness, proximity or verified status can rescue a memory
 * that does not answer the question.
 */
describe("INVARIANT: relevance gates, other signals only modulate", () => {
  it("a fresh, perfectly-anchored, verified but irrelevant memory is withheld", async () => {
    await seed({
      body: "Kubernetes ingress requires an annotation for sticky sessions.",
      paths: ["src/auth.ts"],
      verified: "2026-07-24T11:00:00Z", // an hour old
    });

    const result = await membook.recall("sqlite index tokenizer", {
      contextPaths: ["src/auth.ts"], // maximum proximity
      now: NOW,
    });

    expect(result.hits).toEqual([]);
  });

  it("declares boosts as multipliers, so zero relevance is zero score", () => {
    expect(RANKING.boostProximity).toBeGreaterThan(0);
    expect(RANKING.boostRecency).toBeGreaterThan(0);
    expect(RANKING.boostRecency).toBeLessThan(1);
  });
});
