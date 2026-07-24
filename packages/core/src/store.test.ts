import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { computeMemoryId, type MemoryInput } from "@membook/spec";
import { MemoryStore } from "./store.js";
import { Membook } from "./membook.js";
import { repoPaths } from "./paths.js";
import { MemoryNotFoundError, WriteBlockedError } from "./errors.js";
import type { WriteGuard } from "./guard.js";
import { CORPUS, memoryFor, seeded, tempRepo } from "./test-helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await tempRepo());
});

afterEach(async () => {
  await cleanup();
});

/**
 * INVARIANT — the store-level sibling of the spec's byte-exact round-trip.
 *
 * Write through the store, read through the store, and the bytes must be
 * unchanged. The schema tests guarantee serialization is a fixed point; this
 * guarantees the CRUD layer does not introduce drift underneath them —
 * trailing newlines, encoding, the boring things that break fixed points.
 */
describe("INVARIANT: store round-trip is byte-exact", () => {
  it.each(CORPUS.map((s, i) => [i, s] as const))(
    "corpus[%i] survives write → read unchanged",
    async (_i, spec) => {
      const store = new MemoryStore(repoPaths(root));
      const { frontmatter, body } = memoryFor(spec);
      const written = await store.write(frontmatter, body);

      const onDisk = await readFile(written.path, "utf8");
      expect(onDisk).toBe(written.text);

      const read = await store.read(written.id);
      expect(read.text).toBe(written.text);
      expect(read.memfile).toEqual(written.memfile);
    },
  );

  it("rewriting an unchanged memory produces identical bytes", async () => {
    const store = new MemoryStore(repoPaths(root));
    const { frontmatter, body } = memoryFor(CORPUS[0]!);
    const first = await store.write(frontmatter, body);
    const second = await store.write(first.memfile.frontmatter, first.memfile.body);
    expect(second.text).toBe(first.text);
  });

  it("survives a body with awkward whitespace", async () => {
    const store = new MemoryStore(repoPaths(root));
    const body = "A statement.\n\n  Indented follow-up.\n\ttab line\n";
    const { frontmatter } = memoryFor({ body });
    const written = await store.write(frontmatter, body);
    const read = await store.read(written.id);
    expect(read.text).toBe(written.text);
  });

  it("survives non-ASCII content", async () => {
    const store = new MemoryStore(repoPaths(root));
    const body = "Le café déploie une résumé — naïve façade, 日本語, emoji 🔐.";
    const { frontmatter } = memoryFor({ body });
    const written = await store.write(frontmatter, body);
    const read = await store.read(written.id);
    expect(read.text).toBe(written.text);
    expect(read.memfile.body).toBe(body);
  });
});

describe("store CRUD", () => {
  it("lists files in sorted order, not filesystem order", async () => {
    const store = new MemoryStore(repoPaths(root));
    for (const spec of CORPUS) {
      const { frontmatter, body } = memoryFor(spec);
      await store.write(frontmatter, body);
    }
    const files = await store.listFiles();
    expect(files).toEqual([...files].sort());
  });

  it("ignores files that are not memories", async () => {
    const paths = repoPaths(root);
    const store = new MemoryStore(paths);
    await mkdir(paths.memories, { recursive: true });
    await writeFile(join(paths.memories, "README.md"), "not a memory", "utf8");
    await writeFile(join(paths.memories, "notes.txt"), "nor this", "utf8");
    expect(await store.listFiles()).toEqual([]);
  });

  it("returns an empty list when the store has never been written to", async () => {
    expect(await new MemoryStore(repoPaths(root)).listFiles()).toEqual([]);
  });

  it("throws a named error reading a missing memory", async () => {
    const store = new MemoryStore(repoPaths(root));
    await expect(store.read("m-0000")).rejects.toThrow(MemoryNotFoundError);
  });

  it("throws a named error deleting a missing memory", async () => {
    const store = new MemoryStore(repoPaths(root));
    await expect(store.delete("m-0000")).rejects.toThrow(MemoryNotFoundError);
  });

  it("allocates a colliding id at the next rung of the ladder", async () => {
    const store = new MemoryStore(repoPaths(root));
    const body = CORPUS[0]!.body;
    const short = computeMemoryId(body, 4);

    const { frontmatter } = memoryFor({ body });
    await store.write(frontmatter, body);

    // Same content, different memory: the short id is taken, so it extends.
    expect(await store.allocateId(body)).toBe(computeMemoryId(body, 8));
    // ...but re-resolving the SAME memory's id returns it unchanged.
    expect(await store.allocateId(body, short)).toBe(short);
  });
});

describe("write guard seam", () => {
  const blocking: WriteGuard = {
    name: "test-scanner",
    inspect: (candidate) =>
      candidate.text.includes("AKIA")
        ? [{ rule: "aws-access-key", message: "AWS key detected in statement" }]
        : [],
  };

  it("blocks the write and leaves nothing on disk", async () => {
    const paths = repoPaths(root);
    const store = new MemoryStore(paths, { guards: [blocking] });
    const body = "The key is AKIAIOSFODNN7EXAMPLE, do not commit it.";
    const { frontmatter } = memoryFor({ body });

    await expect(store.write(frontmatter, body)).rejects.toThrow(WriteBlockedError);
    await expect(readdir(paths.memories)).rejects.toThrow();
  });

  it("names the guard and every finding", async () => {
    const store = new MemoryStore(repoPaths(root), { guards: [blocking] });
    const body = "The key is AKIAIOSFODNN7EXAMPLE.";
    const { frontmatter } = memoryFor({ body });
    try {
      await store.write(frontmatter, body);
      expect.unreachable("should have thrown");
    } catch (error) {
      const err = error as WriteBlockedError;
      expect(err.guard).toBe("test-scanner");
      expect(err.findings[0]!.rule).toBe("aws-access-key");
      expect(err.message).toContain("Nothing was written");
    }
  });

  it("lets clean content through", async () => {
    const store = new MemoryStore(repoPaths(root), { guards: [blocking] });
    const { frontmatter, body } = memoryFor(CORPUS[0]!);
    await expect(store.write(frontmatter, body)).resolves.toBeDefined();
  });

  it("supports an async guard", async () => {
    const asyncGuard: WriteGuard = {
      name: "async-scanner",
      inspect: async () => [{ rule: "async", message: "blocked asynchronously" }],
    };
    const store = new MemoryStore(repoPaths(root), { guards: [asyncGuard] });
    const { frontmatter, body } = memoryFor(CORPUS[0]!);
    await expect(store.write(frontmatter, body)).rejects.toThrow(WriteBlockedError);
  });
});

describe("write path validates against the wire schema", () => {
  it("refuses a Date timestamp, keeping the tolerance read-side", async () => {
    const store = new MemoryStore(repoPaths(root));
    const { frontmatter, body } = memoryFor(CORPUS[0]!);
    const withDate = { ...frontmatter, created: new Date() } as unknown as MemoryInput;
    await expect(store.write(withDate, body)).rejects.toThrow(/expected string/);
  });

  it("refuses an anchorless memory", async () => {
    const store = new MemoryStore(repoPaths(root));
    const { frontmatter, body } = memoryFor(CORPUS[0]!);
    await expect(store.write({ ...frontmatter, anchors: [] }, body)).rejects.toThrow(
      /at least one anchor/,
    );
  });
});

describe("file-first write ordering", () => {
  it("indexes what was written, and status agrees with disk", async () => {
    const membook = await seeded(root);
    const report = await membook.status();
    expect(report.onDisk).toBe(CORPUS.length);
    expect(report.indexed).toBe(CORPUS.length);
    expect(report.quarantined).toEqual([]);
  });

  it("a stale index is healable, because the files are the truth", async () => {
    const membook = await seeded(root);
    // Simulate a crash after the file landed but before the index updated.
    const { frontmatter, body } = memoryFor({
      body: "Orphaned by a crash between file write and index update.",
    });
    await membook.store.write(frontmatter, body);

    const before = await membook.status();
    expect(before.onDisk).toBe(CORPUS.length + 1);
    expect(before.indexed).toBe(CORPUS.length);
    expect(await membook.search("orphaned crash")).toHaveLength(0);

    await membook.reindex();
    expect(await membook.search("orphaned crash")).toHaveLength(1);
  });

  it("forget removes the file and the index row together", async () => {
    const membook = await seeded(root);
    const id = (await membook.store.listIds())[0]!;
    await membook.forget(id);
    expect(await membook.store.has(id)).toBe(false);
    const report = await membook.status();
    expect(report.indexed).toBe(CORPUS.length - 1);
    expect(report.onDisk).toBe(CORPUS.length - 1);
  });

  it("rewriting a memory does not duplicate it in the index", async () => {
    const membook = await seeded(root);
    const { frontmatter, body } = memoryFor(CORPUS[0]!);
    await membook.remember(frontmatter, body);
    const report = await membook.status();
    expect(report.indexed).toBe(CORPUS.length);
  });
});

describe("Membook facade", () => {
  it("reports status by memory status", async () => {
    const membook = await seeded(root);
    const report = await membook.status();
    expect(report.byStatus["verified"]).toBe(2);
    expect(report.byStatus["stale"]).toBe(1);
    expect(report.byStatus["unverified"]).toBe(2);
  });
});
