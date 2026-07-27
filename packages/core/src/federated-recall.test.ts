import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Membook } from "./membook.js";
import { MemoryStore } from "./store.js";
import { repoPaths } from "./paths.js";
import { workspaceFixture, type WorkspaceFixture } from "./git-fixture.js";
import { workspaceCacheDir } from "./federated-recall.js";
import { memoryFor, seeded, tempRepo } from "./test-helpers.js";
import type { ResolvedWorkspace } from "./workspace.js";

let root: string;
let cleanupRoot: () => Promise<void>;
let ws: WorkspaceFixture;
let workspace: ResolvedWorkspace;
let membook: Membook;

const gateway = () => ws.members["gateway"]!;

beforeEach(async () => {
  process.env["MEMBOOK_HOME"] = await mkdtemp(join(tmpdir(), "membook-fed-"));
  ({ root, cleanup: cleanupRoot } = await tempRepo());
  membook = await seeded(root);
  ws = await workspaceFixture(["gateway"]);
  await gateway().commitFile("config/limits.yaml", "requests: 100\n");
  const gatewayStore = new MemoryStore(repoPaths(gateway().root));
  await gatewayStore.write(
    memoryFor({
      body: "Gateway rate limits live in config/limits.yaml, per tenant.",
      type: "map",
      paths: ["config/limits.yaml"],
    }).frontmatter,
    "Gateway rate limits live in config/limits.yaml, per tenant."
  );
  workspace = await ws.resolved();
});

afterEach(async () => {
  await cleanupRoot();
  await ws.cleanup();
  const home = process.env["MEMBOOK_HOME"];
  delete process.env["MEMBOOK_HOME"];
  if (home) await rm(home, { recursive: true, force: true });
});

describe("federated recall", () => {
  it("serves a neighbour's memory with its provenance visible", async () => {
    const result = await membook.recall("gateway rate limits per tenant", {
      workspace,
    });
    const remote = result.hits.find((h) => h.member === "gateway");
    expect(remote).toBeDefined();
    expect(remote!.body).toContain("rate limits");
    // The local corpus has nothing relevant, and relevance still gates:
    // federation must not drag irrelevant local hits in alongside.
    expect(result.hits.every((h) => h.member === "gateway")).toBe(true);
  });

  it("never lets a remote hit outrank an equally-relevant local one", async () => {
    const body = "Rate limiting policy verbatim in both repositories.";
    await membook.remember(
      memoryFor({ body, paths: ["src/limits.ts"] }).frontmatter,
      body
    );
    await new MemoryStore(repoPaths(gateway().root)).write(
      memoryFor({ body, paths: ["config/limits.yaml"] }).frontmatter,
      body
    );

    const result = await membook.recall(
      "rate limiting policy verbatim repositories",
      { workspace }
    );
    const localIndex = result.hits.findIndex((h) => h.member === undefined);
    const remoteIndex = result.hits.findIndex((h) => h.member === "gateway");
    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(remoteIndex).toBeGreaterThan(localIndex);
  });

  it("builds the neighbour's index in the cache, never in their tree", async () => {
    await membook.recall("gateway rate limits", { workspace });

    const cache = await readdir(workspaceCacheDir("gateway"));
    expect(cache.some((f) => f.endsWith(".db"))).toBe(true);
    // Their tree is untouched: no index dir appeared in the member checkout.
    const memberMembook = await readdir(join(gateway().root, ".membook"));
    expect(memberMembook).not.toContain("index");
  });

  it("rebuilds the cache when the member's HEAD moves", async () => {
    await membook.recall("gateway rate limits", { workspace });
    const before = await readdir(workspaceCacheDir("gateway"));

    await gateway().commitFile("config/limits.yaml", "requests: 50\n");
    const newBody = "Burst credits are configured separately from rate limits.";
    await new MemoryStore(repoPaths(gateway().root)).write(
      memoryFor({ body: newBody, paths: ["config/limits.yaml"] }).frontmatter,
      newBody
    );
    await gateway().commit("burst memory");

    const result = await membook.recall("burst credits configured", {
      workspace: await ws.resolved(),
    });
    expect(result.hits.some((h) => h.body.includes("Burst credits"))).toBe(
      true
    );
    const after = await readdir(workspaceCacheDir("gateway"));
    expect(after).not.toEqual(before);
  });

  it("relevance still gates: an unrelated query serves nothing remote", async () => {
    const result = await membook.recall("kubernetes ingress annotations", {
      workspace,
    });
    expect(result.hits.filter((h) => h.member !== undefined)).toHaveLength(0);
  });

  it("a member with nothing recorded is silence, not an error", async () => {
    const empty = await workspaceFixture(["silent"]);
    await empty.members["silent"]!.commitFile("README.md", "hi\n");
    const resolved = await empty.resolved();

    const result = await membook.recall("gateway rate limits", {
      workspace: resolved,
    });
    expect(result.hits.every((h) => h.member === undefined)).toBe(true);
    await empty.cleanup();
  });
});
