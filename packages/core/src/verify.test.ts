import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeMemoryId, type MemoryInput } from "@membook/spec";
import { Membook } from "./membook.js";
import { GitFixture } from "./git-fixture.js";
import type { AnchorRechecker } from "./recheck.js";

let repo: GitFixture;
let membook: Membook;

beforeEach(async () => {
  repo = await GitFixture.create();
  membook = new Membook(repo.root);
});

afterEach(async () => {
  await repo.cleanup();
});

/** Seed a memory anchored to `paths` as of `commit`. */
async function remember(
  body: string,
  commit: string,
  paths: string[],
  status: MemoryInput["status"] = "verified"
): Promise<string> {
  const id = computeMemoryId(body);
  await membook.remember(
    {
      memfile: 2,
      id,
      type: "gotcha",
      status,
      scope: "repo",
      confidence: 0.9,
      created: "2026-07-21T16:42:00Z",
      ...(status === "unverified" ? {} : { verified: "2026-07-21T16:42:00Z" }),
      anchors: paths.map((path) => ({ path, commit })),
      provenance: {
        origin: "authored",
        author: "agent",
        session: "sess-test",
        agent: "claude-code",
        model: "claude-opus-4-8",
      },
    },
    body
  );
  return id;
}

async function statusOf(id: string): Promise<string> {
  return (await membook.store.read(id)).memfile.frontmatter.status;
}

describe("anchor transitions", () => {
  it("untouched anchor re-verifies for free", async () => {
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    await repo.commitFile("src/other.ts", "export const b = 2;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);

    const report = await membook.verify();

    expect(await statusOf(id)).toBe("verified");
    const verdict = [...report.changed, ...report.unchanged].find(
      (v) => v.id === id
    )!;
    expect(verdict.outcomes[0]!.kind).toBe("untouched");
    expect(verdict.rechecked).toBe(false);
  });

  it("advances the anchor commit to HEAD when it verifies", async () => {
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    await repo.commitFile("src/other.ts", "export const b = 2;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);

    await membook.verify();

    const anchor = (await membook.store.read(id)).memfile.frontmatter
      .anchors[0]!;
    expect(anchor.commit).toBe(await repo.head());
    expect(anchor.commit).not.toBe(base);
  });

  it("modified anchor goes stale", async () => {
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);
    await repo.edit("src/auth.ts", "export const a = 99; // rewritten\n");

    const report = await membook.verify();

    expect(await statusOf(id)).toBe("stale");
    const verdict = report.changed.find((v) => v.id === id)!;
    expect(verdict.outcomes[0]!.kind).toBe("modified");
    expect(verdict.rechecked).toBe(true);
  });

  it("does NOT advance the anchor commit when it goes stale", async () => {
    // `commit` means "the SHA this was last proven against". Advancing it on a
    // failed check would erase the baseline a later re-check needs.
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);
    await repo.edit("src/auth.ts", "export const a = 99;\n");

    await membook.verify();

    expect(
      (await membook.store.read(id)).memfile.frontmatter.anchors[0]!.commit
    ).toBe(base);
  });

  it("renamed anchor follows the file and rewrites the path", async () => {
    const base = await repo.commitFile(
      "src/auth.ts",
      "export function refresh() { return 1; }\n"
    );
    const id = await remember("Auth refresh lives here.", base, [
      "src/auth.ts",
    ]);
    await repo.rename("src/auth.ts", "src/security/auth.ts");

    const report = await membook.verify();

    const verdict = report.changed.find((v) => v.id === id)!;
    expect(verdict.outcomes[0]!.kind).toBe("renamed");
    expect(verdict.outcomes[0]!.renamedTo).toBe("src/security/auth.ts");

    // The path is rewritten even though the memory is stale: an anchor
    // pointing at a path that no longer exists is worse than a stale one.
    const anchor = (await membook.store.read(id)).memfile.frontmatter
      .anchors[0]!;
    expect(anchor.path).toBe("src/security/auth.ts");
    expect(await statusOf(id)).toBe("stale");
  });

  it("deleted anchor invalidates the memory", async () => {
    const base = await repo.commitFile(
      "src/legacy.ts",
      "export const old = 1;\n"
    );
    await repo.commitFile("src/keep.ts", "export const keep = 1;\n");
    const id = await remember("Legacy path does the thing.", base, [
      "src/legacy.ts",
    ]);
    await repo.remove("src/legacy.ts");

    const report = await membook.verify();

    expect(await statusOf(id)).toBe("invalidated");
    expect(report.changed.find((v) => v.id === id)!.outcomes[0]!.kind).toBe(
      "deleted"
    );
  });

  it("distinguishes a rename-then-delete from a plain delete", async () => {
    // The diff reports only a deletion at the original path; `log --follow`
    // is what separates "moved" from "gone".
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth thing.", base, ["src/auth.ts"]);
    await repo.rename("src/auth.ts", "src/moved.ts");
    await repo.edit(
      "src/moved.ts",
      "export const a = 1;\nexport const b = 2;\n"
    );

    const report = await membook.verify();
    const verdict = report.changed.find((v) => v.id === id)!;

    expect(verdict.outcomes[0]!.kind).toBe("renamed");
    expect(await statusOf(id)).not.toBe("invalidated");
  });

  it("a revert restores the file, so the anchor is untouched again", async () => {
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);
    await repo.edit("src/auth.ts", "export const a = 99;\n");
    await repo.revertLast();

    const report = await membook.verify();

    // Content is byte-identical to the anchored commit, so git reports no
    // change across the range at all.
    const verdict = [...report.changed, ...report.unchanged].find(
      (v) => v.id === id
    )!;
    expect(verdict.outcomes[0]!.kind).toBe("untouched");
    expect(await statusOf(id)).toBe("verified");
  });

  it("reports an unknown base commit rather than guessing", async () => {
    await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const orphan = "0".repeat(39) + "1";
    const id = await remember(
      "Anchored to a commit this repo never had.",
      orphan,
      ["src/auth.ts"]
    );

    const report = await membook.verify();
    const verdict = report.changed.find((v) => v.id === id)!;

    expect(verdict.outcomes[0]!.kind).toBe("unknown-base");
    expect(await statusOf(id)).toBe("unverified");
    expect(verdict.reason).toMatch(/history rewritten|not in this repository/);
  });
});

describe("broken anchors", () => {
  it("refuses to verify a path that did not exist at its own commit", async () => {
    // The anchor claims "this path, as of this commit" — but the file was
    // only added later, so it never described anything there. Calling that
    // untouched would verify a memory against nothing.
    const base = await repo.commitFile("src/first.ts", "export const a = 1;\n");
    await repo.commitFile("src/later.ts", "export const b = 2;\n");
    const id = await remember("About a file added after the anchor.", base, [
      "src/later.ts",
    ]);

    const report = await membook.verify();
    const verdict = report.changed.find((v) => v.id === id)!;

    expect(verdict.outcomes[0]!.kind).toBe("missing-at-base");
    expect(await statusOf(id)).toBe("unverified");
    expect(verdict.reason).toMatch(/did not exist at its own commit/);
  });

  it("treats a path absent from HEAD as deleted even when the diff is quiet", async () => {
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth thing.", base, ["src/nonexistent.ts"]);

    await membook.verify();
    expect(await statusOf(id)).toBe("invalidated");
  });
});

describe("multi-anchor memories", () => {
  it("takes the worst outcome across anchors", async () => {
    await repo.commitFile("src/a.ts", "export const a = 1;\n");
    const base = await repo.commitFile("src/b.ts", "export const b = 2;\n");
    const id = await remember("Spans two files.", base, [
      "src/a.ts",
      "src/b.ts",
    ]);
    await repo.remove("src/b.ts");

    await membook.verify();

    // a.ts is untouched, but b.ts is gone: the memory is only as good as its
    // weakest anchor.
    expect(await statusOf(id)).toBe("invalidated");
  });

  it("a single modified anchor is enough to go stale", async () => {
    await repo.commitFile("src/a.ts", "export const a = 1;\n");
    const base = await repo.commitFile("src/b.ts", "export const b = 2;\n");
    const id = await remember("Spans two files.", base, [
      "src/a.ts",
      "src/b.ts",
    ]);
    await repo.edit("src/b.ts", "export const b = 99;\n");

    expect((await membook.verify()).changed.find((v) => v.id === id)!.to).toBe(
      "stale"
    );
  });
});

/**
 * The rule that keeps verification honest: absence of further change cannot
 * retroactively confirm a claim that was never confirmed.
 */
describe("INVARIANT: staleness is not cleared by the absence of change", () => {
  it("a stale memory stays stale however long nothing changes", async () => {
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);

    await repo.edit("src/auth.ts", "export const a = 99;\n");
    await membook.verify();
    expect(await statusOf(id)).toBe("stale");

    // Many commits later, touching nothing the memory is anchored to.
    await repo.commitFile("docs/readme.md", "# hi\n");
    await repo.commitFile("docs/more.md", "# more\n");
    await membook.verify();

    expect(await statusOf(id)).toBe("stale");
  });

  it("only a re-check can restore it", async () => {
    const confirming: AnchorRechecker = {
      name: "always-confirms",
      recheck: () => ({
        verdict: "verified",
        reason: "checked and still true",
      }),
    };

    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);
    await repo.edit("src/auth.ts", "export const a = 99;\n");

    await membook.verify();
    expect(await statusOf(id)).toBe("stale");

    await repo.edit("src/auth.ts", "export const a = 100;\n");
    await membook.verify({ rechecker: confirming });

    expect(await statusOf(id)).toBe("verified");
  });

  it("an invalidated memory is not resurrected either", async () => {
    await repo.commitFile("src/gone.ts", "export const x = 1;\n");
    const base = await repo.commitFile("src/keep.ts", "export const k = 1;\n");
    const id = await remember("About a file that gets deleted.", base, [
      "src/keep.ts",
    ]);

    // Force it invalidated, then let the repo move on without touching it.
    await repo.remove("src/gone.ts");
    const stored = await membook.store.read(id);
    await membook.remember(
      { ...stored.memfile.frontmatter, status: "invalidated" },
      stored.memfile.body
    );

    await membook.verify();
    expect(await statusOf(id)).toBe("invalidated");
  });
});

describe("the re-check seam", () => {
  it("defaults to conservative: never confirms without a checker", async () => {
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);
    await repo.edit("src/auth.ts", "export const a = 99;\n");

    const report = await membook.verify();

    expect(await statusOf(id)).toBe("stale");
    expect(report.changed.find((v) => v.id === id)!.reason).toMatch(
      /no re-checker is configured/
    );
  });

  it("passes the touched anchors and the memory body to the checker", async () => {
    const seen: string[] = [];
    const spy: AnchorRechecker = {
      name: "spy",
      recheck: (request) => {
        seen.push(request.body, ...request.touched.map((t) => t.anchor.path));
        return { verdict: "stale", reason: "spied" };
      },
    };

    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    await remember("Auth uses a token.", base, ["src/auth.ts"]);
    await repo.edit("src/auth.ts", "export const a = 99;\n");

    await membook.verify({ rechecker: spy });

    expect(seen).toContain("Auth uses a token.");
    expect(seen).toContain("src/auth.ts");
  });

  it("lets a checker invalidate outright", async () => {
    const killer: AnchorRechecker = {
      name: "killer",
      recheck: () => ({
        verdict: "invalidated",
        reason: "contradicted by the code",
      }),
    };

    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);
    await repo.edit("src/auth.ts", "export const a = 99;\n");

    await membook.verify({ rechecker: killer });
    expect(await statusOf(id)).toBe("invalidated");
  });
});

describe("dry run", () => {
  it("reports the same verdicts without writing anything", async () => {
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const id = await remember("Auth uses a token.", base, ["src/auth.ts"]);
    await repo.edit("src/auth.ts", "export const a = 99;\n");

    const dry = await membook.verify({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.changed.find((v) => v.id === id)!.to).toBe("stale");
    expect(await statusOf(id)).toBe("verified");

    const wet = await membook.verify();
    expect(wet.changed.find((v) => v.id === id)!.to).toBe("stale");
    expect(await statusOf(id)).toBe("stale");
  });
});

describe("efficiency", () => {
  it("diffs once per distinct anchor commit, not once per memory", async () => {
    const base = await repo.commitFile("src/a.ts", "export const a = 1;\n");
    for (let i = 0; i < 5; i++) {
      await remember(`Memory number ${i} about the same baseline.`, base, [
        "src/a.ts",
      ]);
    }
    await repo.commitFile("src/b.ts", "export const b = 2;\n");

    const report = await membook.verify();
    expect(report.checked).toBe(5);
    expect(report.byStatus.verified).toBe(5);
  });
});

describe("the signature demo", () => {
  it("stores a gotcha, renames the file, and reports it stale", async () => {
    // The end-to-end story: an agent records something, the code moves, and
    // the next session is told the memory can no longer be trusted as-is.
    const base = await repo.commitFile(
      "src/index-db.ts",
      "export function openIndex() { /* WAL */ }\n"
    );
    const id = await remember(
      "Set PRAGMA journal_mode WAL before opening the index, or concurrent sessions deadlock.",
      base,
      ["src/index-db.ts"]
    );

    expect((await membook.verify()).byStatus.verified).toBe(1);

    await repo.rename("src/index-db.ts", "src/db/index.ts");

    const report = await membook.verify();

    expect(report.byStatus.stale).toBe(1);
    expect(await statusOf(id)).toBe("stale");

    // The anchor followed the file, so the memory still points at real code.
    const anchor = (await membook.store.read(id)).memfile.frontmatter
      .anchors[0]!;
    expect(anchor.path).toBe("src/db/index.ts");

    // And retrieval withholds it from a caller that wants only verified
    // memories — while still reporting that something was held back, so the
    // agent knows the silence is not an absence of knowledge.
    const fresh = await membook.recall("journal_mode WAL deadlock", {
      statuses: ["verified"],
    });
    expect(fresh.hits).toHaveLength(0);
    expect(fresh.withheld.byStatus["stale"]).toBe(1);

    const all = await membook.recall("journal_mode WAL deadlock");
    expect(all.hits).toHaveLength(1);
    expect(all.hits[0]!.status).toBe("stale");
  });
});

describe("cross-repo anchors, without a workspace", () => {
  // An unresolvable member blocks confirmation, never conviction: the local
  // anchor's drift is evidence the pass actually saw, so the memory goes
  // honestly stale even though the cross-repo half could not be checked.
  it("lets local drift convict while the member stays unresolvable", async () => {
    const base = await repo.commitFile("src/auth.ts", "export const a = 1;\n");
    const body = "The gateway limits config is the contract we consume.";
    const id = computeMemoryId(body);
    await membook.remember(
      {
        memfile: 2,
        id,
        type: "map",
        status: "unverified",
        scope: "repo",
        confidence: 0.9,
        created: "2026-07-25T10:00:00Z",
        anchors: [
          { path: "src/auth.ts", commit: base },
          {
            kind: "xgit",
            repo: "platform-gateway",
            path: "config/limits.yaml",
            commit: base,
          },
        ],
        provenance: { origin: "authored", author: "human" },
      },
      body
    );
    // Touch the local anchor: the conservative re-checker will demote.
    await repo.edit("src/auth.ts", "export const a = 2;\n");
    const report = await membook.verify();

    expect(await statusOf(id)).toBe("stale");
    const verdict = report.changed.find((v) => v.id === id)!;
    expect(verdict.rechecked).toBe(true);
    expect(verdict.outcomes.map((o) => [o.kind, o.member ?? null])).toEqual([
      ["modified", null],
      ["unresolvable", "platform-gateway"],
    ]);
    expect(
      verdict.outcomes.find((o) => o.kind === "unresolvable")!.reason
    ).toMatch(/no workspace manifest/);
  });
});
