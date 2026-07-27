import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeMemoryId,
  type AnchoredMemoryInput,
  type MemoryInput,
  type XgitAnchor,
} from "@membook/spec";
import { Membook } from "./membook.js";
import {
  GitFixture,
  workspaceFixture,
  type WorkspaceFixture,
} from "./git-fixture.js";
import type { ResolvedWorkspace } from "./workspace.js";

/**
 * THE v0.2 SIGNATURE DEMO, as an automated test.
 *
 * A consumer repo remembers something about a producer repo's contract file,
 * anchored cross-repo. The producer changes the file; the consumer's next
 * verify pass flips the memory stale BEFORE an agent writes code against the
 * old shape. Contract-watch, running on nothing but local checkouts and
 * `git pull` as the propagation medium.
 */

let consumer: GitFixture;
let membook: Membook;
let ws: WorkspaceFixture;
let workspace: ResolvedWorkspace;

const producer = () => ws.members["gateway"]!;

beforeEach(async () => {
  consumer = await GitFixture.create();
  membook = new Membook(consumer.root);
  ws = await workspaceFixture(["gateway"]);
  await producer().commitFile("config/limits.yaml", "requests: 100\n");
  workspace = await ws.resolved();
});

afterEach(async () => {
  await consumer.cleanup();
  await ws.cleanup();
});

async function rememberContract(
  status: AnchoredMemoryInput["status"] = "verified"
): Promise<string> {
  const localBase = await consumer.commitFile(
    "src/client.ts",
    "export const limit = 100;\n"
  );
  const producerHead = await producer().head();
  const body =
    "The gateway allows 100 requests; config/limits.yaml is the contract.";
  const id = computeMemoryId(body);
  await membook.remember(
    {
      memfile: 2,
      id,
      type: "gotcha",
      status,
      scope: "repo",
      confidence: 0.9,
      created: "2026-07-25T10:00:00Z",
      ...(status === "unverified" ? {} : { verified: "2026-07-25T10:00:00Z" }),
      anchors: [
        { path: "src/client.ts", commit: localBase },
        {
          kind: "xgit",
          repo: "gateway",
          path: "config/limits.yaml",
          commit: producerHead,
        },
      ],
      provenance: { origin: "authored", author: "human" },
    },
    body
  );
  return id;
}

async function statusOf(id: string): Promise<string> {
  return (await membook.store.read(id)).memfile.frontmatter.status;
}

async function xgitAnchorOf(id: string): Promise<XgitAnchor> {
  const anchors = (await membook.store.read(id)).memfile.frontmatter.anchors;
  return anchors.find((a) => a.kind === "xgit") as XgitAnchor;
}

describe("contract-watch: the two-repo signature demo", () => {
  it("flips the consumer memory stale when the producer changes the contract", async () => {
    const id = await rememberContract();

    // Nothing moved yet: the memory re-verifies, and the cross-repo anchor
    // advances to the PRODUCER's head — proven against that history.
    let report = await membook.verify({ workspace });
    expect(await statusOf(id)).toBe("verified");
    expect((await xgitAnchorOf(id)).commit).toBe(await producer().head());

    // The producer merges a contract change. The consumer has done nothing.
    await producer().edit("config/limits.yaml", "requests: 50\n");

    report = await membook.verify({ workspace });
    expect(await statusOf(id)).toBe("stale");
    const verdict = report.changed.find((v) => v.id === id)!;
    expect(verdict.outcomes.map((o) => [o.kind, o.member ?? null])).toEqual([
      ["untouched", null],
      ["modified", "gateway"],
    ]);
  });

  it("follows a rename in the producer repo", async () => {
    const id = await rememberContract();
    await membook.verify({ workspace });

    await producer().rename("config/limits.yaml", "config/rate-limits.yaml");

    await membook.verify({ workspace });
    expect(await statusOf(id)).toBe("stale");
    // The anchor followed the file across the rename, in the OTHER repo.
    expect((await xgitAnchorOf(id)).path).toBe("config/rate-limits.yaml");
  });

  it("invalidates when the producer deletes the contract outright", async () => {
    const id = await rememberContract();
    await membook.verify({ workspace });

    await producer().remove("config/limits.yaml");

    await membook.verify({ workspace });
    expect(await statusOf(id)).toBe("invalidated");
  });
});

describe("unresolvable: the third epistemic state", () => {
  it("is what a missing member yields — not stale, not verified, file frozen", async () => {
    const id = await rememberContract();
    const before = (await membook.store.read(id)).text;

    // Same manifest, but the checkout is gone from this machine.
    await producer().cleanup();
    const degraded = await ws.resolved();

    const report = await membook.verify({ workspace: degraded });
    expect(await statusOf(id)).toBe("verified");
    expect((await membook.store.read(id)).text).toBe(before);

    const verdict = [...report.changed, ...report.unchanged].find(
      (v) => v.id === id
    )!;
    expect(verdict.to).toBe(verdict.from);
    expect(verdict.reason).toMatch(/could not be checked on this machine/);
    expect(verdict.reason).toMatch(/gateway/);
    expect(
      verdict.outcomes.find((o) => o.kind === "unresolvable")!.member
    ).toBe("gateway");
  });

  it("is what no workspace at all yields, with the reason saying so", async () => {
    const id = await rememberContract();

    const report = await membook.verify();
    expect(await statusOf(id)).toBe("verified");
    const verdict = [...report.changed, ...report.unchanged].find(
      (v) => v.id === id
    )!;
    expect(verdict.reason).toMatch(/no workspace manifest/);
  });

  it("does not block what the pass could still prove: a deleted local anchor convicts", async () => {
    const id = await rememberContract();
    await membook.verify({ workspace });

    await producer().cleanup();
    const degraded = await ws.resolved();
    await consumer.remove("src/client.ts");

    await membook.verify({ workspace: degraded });
    // Partial coverage cannot confirm, but it can convict: the local file
    // this memory describes is gone, whatever the unreachable member says.
    expect(await statusOf(id)).toBe("invalidated");
  });

  it("blocks a re-check restore from reaching verified", async () => {
    const id = await rememberContract("stale");
    await producer().cleanup();
    const degraded = await ws.resolved();
    await consumer.edit("src/client.ts", "export const limit = 99;\n");

    const report = await membook.verify({
      workspace: degraded,
      rechecker: {
        name: "always-restores",
        recheck: () => ({ verdict: "verified", reason: "still holds" }),
      },
    });

    // The re-checker vouched for what it saw — but it could not see gateway.
    expect(await statusOf(id)).toBe("stale");
    const verdict = [...report.changed, ...report.unchanged].find(
      (v) => v.id === id
    )!;
    expect(verdict.rechecked).toBe(true);
    expect(verdict.reason).toMatch(/cannot be confirmed on this machine/);
  });

  it("does not cost the memories that never leave home", async () => {
    const id = await rememberContract();
    const localBody = "Local client code retries twice.";
    const localId = computeMemoryId(localBody);
    await membook.remember(
      {
        memfile: 2,
        id: localId,
        type: "convention",
        status: "unverified",
        scope: "repo",
        confidence: 0.9,
        created: "2026-07-25T10:00:00Z",
        anchors: [{ path: "src/client.ts", commit: await consumer.head() }],
        provenance: { origin: "authored", author: "human" },
      },
      localBody
    );

    await producer().cleanup();
    const degraded = await ws.resolved();
    await membook.verify({ workspace: degraded });

    // The local memory verified normally; only the cross-repo one was frozen.
    expect(await statusOf(localId)).toBe("verified");
    expect(await statusOf(id)).toBe("verified");
  });
});

describe("the book, with members it cannot see", () => {
  it("withholds unresolvable-anchored memories under their own honest count", async () => {
    await rememberContract();

    // With the workspace resolved, the memory is carried.
    const withWorkspace = await membook.compileBook({ workspace });
    expect(withWorkspace.entries).toHaveLength(1);
    expect(withWorkspace.excludedUnresolvable).toBe(0);

    // Without it, the memory is withheld — and the header says why, in its
    // own sentence, never folded into the drifted count.
    const without = await membook.compileBook();
    expect(without.entries).toHaveLength(0);
    expect(without.excludedUnresolvable).toBe(1);
    expect(without.excluded).toBe(0);
    expect(without.content.replace(/\s+/g, " ")).toMatch(
      /could not be checked on this machine because the repository it describes is not present/
    );
  });
});
