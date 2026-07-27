import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Membook } from "./membook.js";
import { MemoryStore } from "./store.js";
import { repoPaths } from "./paths.js";
import { SecretScanGuard } from "./secret-scan.js";
import { FAKE_SECRETS } from "./fake-secrets.js";
import { UserStore, userPaths } from "./user-store.js";
import { memoryFor, seeded, tempRepo } from "./test-helpers.js";

let home: string;
let store: UserStore;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "membook-home-"));
  store = new UserStore(userPaths(home));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("the user store", () => {
  it("writes a preference with no anchors, status or verified", async () => {
    const stored = await store.remember({
      statement: "Prefer explicit return types on exported functions.",
      type: "convention",
    });
    const text = await readFile(stored.path, "utf8");
    expect(text).toContain("scope: user");
    expect(text).not.toContain("anchors:");
    expect(text).not.toContain("status:");
    expect(text).not.toContain("verified:");
    expect(stored.memfile.frontmatter.provenance).toEqual({
      origin: "authored",
      author: "human",
    });
  });

  it("recalls a preference, served plainly", async () => {
    await store.remember({
      statement: "Prefer pnpm over npm for every JavaScript project.",
      type: "convention",
    });
    await store.remember({
      statement: "Meetings before ten in the morning are a hard no.",
      type: "convention",
    });

    const result = await store.recall("should I use pnpm or npm here");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.scope).toBe("user");
    expect(result.hits[0]!.status).toBeNull();
    expect(result.hits[0]!.body).toContain("pnpm");
  });

  it("stays silent when nothing is relevant", async () => {
    await store.remember({
      statement: "Prefer pnpm over npm for every JavaScript project.",
      type: "convention",
    });
    const result = await store.recall("kubernetes ingress annotations");
    expect(result.hits).toHaveLength(0);
  });

  // The mirror of the repo store's gate: anchored knowledge in the user
  // store is repo knowledge that lost its way home.
  it("rejects an anchored memory that wandered into the user store", async () => {
    const { frontmatter } = memoryFor({ body: "Repo knowledge." });
    await mkdir(userPaths(home).store, { recursive: true });
    const { serializeMemfile } = await import("@membook/spec");
    await writeFile(
      join(userPaths(home).store, `${frontmatter.id}.mem.md`),
      serializeMemfile(frontmatter, "Repo knowledge."),
      "utf8"
    );

    const { memories, rejected } = await store.readAll();
    expect(memories).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.issues[0]).toMatch(/belong in a repository/);
  });

  it("blocks a secret from being remembered about the human too", async () => {
    const guarded = new UserStore(userPaths(home), {
      guards: [new SecretScanGuard()],
    });
    await expect(
      guarded.remember({
        statement: `My deploy key is ${FAKE_SECRETS.awsKey}.`,
        type: "convention",
      })
    ).rejects.toThrow(/blocked/i);
  });
});

describe("the repo store's scope gate", () => {
  it("quarantines a user-scope file found in a repository store", async () => {
    const { root, cleanup } = await tempRepo();
    try {
      const repoStore = new MemoryStore(repoPaths(root));
      const { serializeMemfile } = await import("@membook/spec");
      await mkdir(repoPaths(root).memories, { recursive: true });
      await writeFile(
        join(repoPaths(root).memories, "m-abcd.mem.md"),
        serializeMemfile(
          {
            memfile: 2,
            id: "m-abcd",
            type: "convention",
            scope: "user",
            confidence: 0.9,
            created: "2026-07-26T09:00:00Z",
            provenance: { origin: "authored", author: "human" },
          },
          "A preference committed to the wrong home."
        ),
        "utf8"
      );

      const { memories, quarantined } = await repoStore.readAll();
      expect(memories).toHaveLength(0);
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]!.issues[0]).toMatch(/~\/.membook\/store/);
    } finally {
      await cleanup();
    }
  });
});

describe("recall fan-in", () => {
  it("folds user memories into every recall, provenance visible", async () => {
    const { root, cleanup } = await tempRepo();
    try {
      const membook = await seeded(root);
      await store.remember({
        statement: "Prefer the SQLite CLI over GUI browsers for index checks.",
        type: "convention",
      });

      const withUser = new Membook(root, { userStore: store });
      const result = await withUser.recall("sqlite index disposable cache");

      const scopes = new Set(result.hits.map((h) => h.scope));
      expect(scopes.has("repo")).toBe(true);
      expect(scopes.has("user")).toBe(true);
      const user = result.hits.find((h) => h.scope === "user")!;
      expect(user.status).toBeNull();

      // And without the user store attached, the same query serves only
      // repo knowledge — the engine never reaches for a home it wasn't given.
      const withoutUser = await membook.recall("sqlite index disposable cache");
      expect(withoutUser.hits.every((h) => h.scope !== "user")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("keeps the merged response under the cap", async () => {
    const { root, cleanup } = await tempRepo();
    try {
      await seeded(root);
      await store.remember({
        statement: "Prefer the SQLite CLI for index checks.",
        type: "convention",
      });
      const membook = new Membook(root, { userStore: store });
      const result = await membook.recall("sqlite index disposable cache", {
        limit: 1,
      });
      expect(result.hits).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
