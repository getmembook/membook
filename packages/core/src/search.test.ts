import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toMatchQuery } from "./search.js";
import { seeded, tempRepo } from "./test-helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await tempRepo());
});

afterEach(async () => {
  await cleanup();
});

describe("query escaping", () => {
  it("quotes each term and ranks partial matches by default", () => {
    expect(toMatchQuery("sqlite index")).toBe('"sqlite" OR "index"');
  });

  it("requires every term in all mode", () => {
    expect(toMatchQuery("sqlite index", "all")).toBe('"sqlite" "index"');
  });

  it("neutralizes punctuation that is FTS5 syntax", () => {
    expect(toMatchQuery("packages/core")).toBe('"packages/core"');
  });

  it("treats operators as words, so they cannot be injected", () => {
    expect(toMatchQuery("a AND b", "all")).toBe('"a" "AND" "b"');
  });

  it("escapes embedded quotes", () => {
    expect(toMatchQuery('say "hi"', "all")).toBe('"say" """hi"""');
  });

  it("collapses empty input", () => {
    expect(toMatchQuery("   ")).toBe("");
  });
});

describe("search", () => {
  it("finds a memory by a path-shaped query rather than throwing", async () => {
    // Raw punctuation is an FTS5 syntax error; unescaped this crashes.
    // Note this searches the STATEMENT: anchor paths live in the anchors
    // table and become a retrieval signal with hybrid ranking, not here.
    const membook = await seeded(root);
    const hits = await membook.search(".membook/index");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("does not throw on any punctuation an agent might paste", async () => {
    const membook = await seeded(root);
    for (const query of [
      "packages/core/src/index-db.ts",
      "git:src/auth.ts#refreshToken@abc",
      "foo(bar) AND *",
      "^caret NEAR/2 tilde~",
      '"unbalanced',
    ]) {
      await expect(membook.search(query)).resolves.toBeDefined();
    }
  });

  it("finds identifiers with underscores, and their parts", async () => {
    const membook = await seeded(root);
    expect(await membook.search("journal_mode")).not.toHaveLength(0);
    // The pinned tokenizer keeps `_` a separator, so a bare part matches too.
    expect(await membook.search("journal")).not.toHaveLength(0);
  });

  it("returns an empty result for an empty query rather than everything", async () => {
    const membook = await seeded(root);
    expect(await membook.search("   ")).toEqual([]);
  });

  it("ranks deterministically across repeated calls", async () => {
    const membook = await seeded(root);
    const a = await membook.search("index");
    const b = await membook.search("index");
    expect(b).toEqual(a);
  });

  it("filters by status, so stale memories can be withheld", async () => {
    const membook = await seeded(root);
    const all = await membook.search("rename detection");
    expect(all.some((h) => h.status === "stale")).toBe(true);

    const fresh = await membook.search("rename detection", {
      statuses: ["verified", "unverified"],
    });
    expect(fresh.some((h) => h.status === "stale")).toBe(false);
  });

  it("honours the limit", async () => {
    const membook = await seeded(root);
    expect((await membook.search("index", { limit: 1 })).length).toBeLessThanOrEqual(1);
  });

  it("returns results in descending score order", async () => {
    const membook = await seeded(root);
    const hits = await membook.search("for rename detection");
    expect(hits.length).toBeGreaterThan(1);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it("ranks the memory matching most terms first", async () => {
    const membook = await seeded(root);
    // Only the deadend carries "rename" and "detection"; another statement
    // shares just "for", so term overlap alone decides the order.
    const hits = await membook.search("for rename detection");
    expect(hits[0]!.type).toBe("deadend");
  });

  it("any mode ranks partial matches instead of returning nothing", async () => {
    const membook = await seeded(root);
    // No single statement carries all of these; `all` would return nothing.
    const hits = await membook.search("rename quarantining anchors");
    expect(hits.length).toBeGreaterThan(1);
    expect(await membook.search("rename quarantining anchors", { mode: "all" })).toEqual(
      [],
    );
  });

  it("all mode narrows to memories carrying every term", async () => {
    const membook = await seeded(root);
    const any = await membook.search("for rename");
    const all = await membook.search("for rename", { mode: "all" });
    expect(all.length).toBeLessThan(any.length);
    expect(all).toHaveLength(1);
  });
});
