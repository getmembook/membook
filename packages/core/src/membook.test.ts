import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { Membook } from "./membook.js";
import { WriteBlockedError } from "./errors.js";
import { SecretScanGuard } from "./secret-scan.js";
import { FAKE_SECRETS } from "./fake-secrets.js";
import { CORPUS, memoryFor, tempRepo } from "./test-helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await tempRepo());
});

afterEach(async () => {
  await cleanup();
});

/**
 * `rememberMany` exists so batch callers — seeding, corpus replay in tests —
 * pay for one index open instead of one per memory. It must be a pure
 * optimization: anything observable about the result has to match a loop of
 * `remember` calls exactly, or the two paths will drift apart silently.
 */
describe("rememberMany", () => {
  it("is indistinguishable from one remember() per memory", async () => {
    const looped = new Membook(root);
    for (const spec of CORPUS) {
      const { frontmatter, body } = memoryFor(spec);
      await looped.remember(frontmatter, body);
    }

    const other = await tempRepo();
    try {
      const batched = new Membook(other.root);
      await batched.rememberMany(CORPUS.map(memoryFor));

      const [a, b] = await Promise.all([
        looped.search("sqlite index"),
        batched.search("sqlite index"),
      ]);
      // Scores included: identical rowid assignment is part of the contract,
      // because BM25 tie-breaking depends on it.
      expect(b).toEqual(a);

      const [sa, sb] = await Promise.all([looped.status(), batched.status()]);
      expect(sb.indexed).toBe(sa.indexed);
      expect(sb.byStatus).toEqual(sa.byStatus);
    } finally {
      await other.cleanup();
    }
  });

  it("returns the stored memories in input order", async () => {
    const membook = new Membook(root);
    const stored = await membook.rememberMany(CORPUS.map(memoryFor));
    expect(stored.map((s) => s.id)).toEqual(
      CORPUS.map((spec) => memoryFor(spec).frontmatter.id)
    );
  });

  it("upserts rather than duplicating when a batch is replayed", async () => {
    const membook = new Membook(root);
    await membook.rememberMany(CORPUS.map(memoryFor));
    await membook.rememberMany(CORPUS.map(memoryFor));
    const status = await membook.status();
    expect(status.indexed).toBe(CORPUS.length);
    expect(status.onDisk).toBe(CORPUS.length);
  });

  it("indexes what landed before a blocked write, then rethrows", async () => {
    const membook = new Membook(root, { guards: [new SecretScanGuard()] });
    const clean = memoryFor({ body: "A perfectly ordinary durable fact." });
    const blocked = memoryFor({
      body: `Deploy with AWS_SECRET=${FAKE_SECRETS.awsKey} in the env.`,
    });
    const never = memoryFor({ body: "Behind the blocked write in the batch." });

    await expect(membook.rememberMany([clean, blocked, never])).rejects.toThrow(
      WriteBlockedError
    );

    // The file that landed is indexed; the blocked one and everything after
    // it never reached disk, so they must not be in the index either.
    expect(await membook.store.listIds()).toEqual([clean.frontmatter.id]);
    const status = await membook.status();
    expect(status.indexed).toBe(1);
  });

  it("does not create an index for an empty batch", async () => {
    const membook = new Membook(root);
    await expect(membook.rememberMany([])).resolves.toEqual([]);
    expect(existsSync(membook.paths.indexFile)).toBe(false);
  });
});
