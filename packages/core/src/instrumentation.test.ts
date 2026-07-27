import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeMemoryId, type MemoryInput,
  type AnchoredMemoryInput,
} from "@membook/spec";
import { Membook } from "./membook.js";
import { FileInstrumentation, NullInstrumentation } from "./instrumentation.js";
import { SecretScanGuard } from "./secret-scan.js";
import { tempRepo } from "./test-helpers.js";
import { FAKE_SECRETS as F } from "./fake-secrets.js";

let root: string;
let cleanup: () => Promise<void>;

const COMMIT = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const NOW = new Date("2026-07-24T12:00:00Z");

beforeEach(async () => {
  ({ root, cleanup } = await tempRepo());
});

afterEach(async () => {
  await cleanup();
});

function memoryFor(body: string): AnchoredMemoryInput {
  return {
    memfile: 2,
    id: computeMemoryId(body),
    type: "gotcha",
    status: "unverified",
    scope: "repo",
    confidence: 0.9,
    created: "2026-07-21T16:42:00Z",
    anchors: [{ path: "src/a.ts", commit: COMMIT }],
    provenance: {
      origin: "authored",
      author: "agent",
      session: "s",
      agent: "claude-code",
      model: "claude-opus-4-8",
    },
  };
}

async function events(
  membook: Membook
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(membook.paths.telemetry, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("off by default", () => {
  it("writes nothing unless asked", async () => {
    const membook = new Membook(root);
    await membook.remember(memoryFor("A fact."), "A fact.");
    await membook.recall("fact");
    expect(existsSync(membook.paths.telemetry)).toBe(false);
    expect(membook.instrumentation).toBeInstanceOf(NullInstrumentation);
  });

  it("enables with a flag", async () => {
    const membook = new Membook(root, { instrumentation: true });
    expect(membook.instrumentation).toBeInstanceOf(FileInstrumentation);
  });
});

describe("recorded events", () => {
  it("logs a remember with its type and anchor count", async () => {
    const membook = new Membook(root, { instrumentation: true });
    await membook.remember(memoryFor("A durable fact."), "A durable fact.");
    const [event] = await events(membook);
    expect(event).toMatchObject({
      event: "remember",
      type: "gotcha",
      anchors: 1,
    });
  });

  it("logs what recall served AND what it withheld", async () => {
    // The withheld count is the number that makes retrieval precision
    // measurable rather than merely asserted.
    const membook = new Membook(root, { instrumentation: true });
    await membook.remember(
      memoryFor("SQLite index lives under .membook as a disposable cache."),
      "SQLite index lives under .membook as a disposable cache."
    );
    await membook.remember(
      memoryFor("Totally unrelated statement about deployment pipelines."),
      "Totally unrelated statement about deployment pipelines."
    );
    await membook.recall("sqlite index cache deployment", { now: NOW });

    const recallEvent = (await events(membook)).find(
      (e) => e["event"] === "recall"
    )!;
    expect(recallEvent["served"]).toBe(1);
    expect(recallEvent["withheld_below_floor"]).toBe(1);
  });

  it("logs a blocked write, which is the scanner earning its keep", async () => {
    const membook = new Membook(root, {
      instrumentation: true,
      guards: [new SecretScanGuard()],
    });
    const body = `Deploy with ${F.awsKey}.`;
    await expect(membook.remember(memoryFor(body), body)).rejects.toThrow();

    const [event] = await events(membook);
    expect(event).toMatchObject({
      event: "write_blocked",
      guard: "secret-scan",
      rules: ["aws-access-key"],
    });
  });

  it("never records the secret itself", async () => {
    const membook = new Membook(root, {
      instrumentation: true,
      guards: [new SecretScanGuard()],
    });
    const body = `Deploy with ${F.awsKey}.`;
    await expect(membook.remember(memoryFor(body), body)).rejects.toThrow();
    expect(await readFile(membook.paths.telemetry, "utf8")).not.toContain(
      F.awsKey
    );
  });

  // `query_terms: 3` cannot answer the question this log exists for —
  // whether a memory would have helped.
  it("records the query as asked", async () => {
    const membook = new Membook(root, { instrumentation: true });
    await membook.recall("how does the dispense queue pin code work", {
      now: NOW,
    });
    const event = (await events(membook)).find((e) => e["event"] === "recall")!;
    expect(event["query"]).toBe("how does the dispense queue pin code work");
  });

  it("redacts a query that trips the scanner", async () => {
    const membook = new Membook(root, { instrumentation: true });
    await membook.recall(`is ${F.awsKey} the right key`, { now: NOW });
    const raw = await readFile(membook.paths.telemetry, "utf8");
    expect(raw).toContain("[redacted]");
    expect(raw).not.toContain(F.awsKey);
  });

  it("logs book compilation counts", async () => {
    const membook = new Membook(root, { instrumentation: true });
    await membook.remember(memoryFor("A fact."), "A fact.");
    await membook.writeBook({ now: NOW });
    const event = (await events(membook)).find((e) => e["event"] === "book")!;
    expect(event).toMatchObject({ carried: 1, omitted: 0, excluded: 0 });
  });

  it("stamps every event with a canonical timestamp", async () => {
    const membook = new Membook(root, { instrumentation: true });
    await membook.remember(memoryFor("A fact."), "A fact.");
    const [event] = await events(membook);
    expect(event!["at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("append-only JSONL", () => {
  it("appends rather than overwriting", async () => {
    const membook = new Membook(root, { instrumentation: true });
    await membook.remember(memoryFor("One."), "One.");
    await membook.remember(memoryFor("Two."), "Two.");
    await membook.remember(memoryFor("Three."), "Three.");
    expect(
      (await events(membook)).filter((e) => e["event"] === "remember")
    ).toHaveLength(3);
  });

  it("writes one parseable JSON object per line", async () => {
    const membook = new Membook(root, { instrumentation: true });
    await membook.remember(memoryFor("A fact."), "A fact.");
    const raw = await readFile(membook.paths.telemetry, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    for (const line of raw.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

/**
 * Telemetry must never be able to break the thing it observes. This is the
 * one place in the codebase where swallowing an error is correct.
 */
describe("INVARIANT: instrumentation cannot break the product", () => {
  it("a failing log does not fail the write", async () => {
    const membook = new Membook(root, {
      // A directory path that cannot be created as a file.
      instrumentation: new FileInstrumentation(
        join(root, "\0invalid", "e.jsonl")
      ),
    });
    await expect(
      membook.remember(memoryFor("A fact."), "A fact.")
    ).resolves.toBeDefined();
  });

  it("the null recorder accepts everything silently", () => {
    const nul = new NullInstrumentation();
    expect(() =>
      nul.record({
        event: "book",
        carried: 1,
        omitted: 0,
        excluded: 0,
        excluded_unresolvable: 0,
        tokens: 10,
      })
    ).not.toThrow();
  });
});

describe("stays local", () => {
  it("writes under .membook/telemetry, which is gitignored", async () => {
    const membook = new Membook(root, { instrumentation: true });
    await membook.remember(memoryFor("A fact."), "A fact.");
    expect(membook.paths.telemetry).toContain(".membook");
    expect(membook.paths.telemetry).toContain("telemetry");
    expect(existsSync(membook.paths.telemetry)).toBe(true);
  });
});
