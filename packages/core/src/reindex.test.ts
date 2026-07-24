import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile, rm, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Membook } from "./membook.js";
import { openIndex, readMetadata, INDEX_METADATA } from "./index-db.js";
import { IndexMetadataMismatchError } from "./errors.js";
import { CORPUS, seeded, tempRepo } from "./test-helpers.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await tempRepo());
});

afterEach(async () => {
  await cleanup();
});

const QUERIES = [
  "sqlite",
  "index cache",
  "journal_mode",
  "packages/core/src/index-db.ts",
  "rename detection",
  "quarantine",
  "anchors",
];

/**
 * THE ACCEPTANCE GATE.
 *
 * Delete the database, rebuild it from the files, and retrieval must be
 * identical — not merely similar. This is what "the database is a cache"
 * has to mean operationally: if a rebuild could change results, the index
 * would be carrying state that exists nowhere else, and the files would no
 * longer be the truth.
 */
describe("GATE: delete DB → reindex → identical retrieval", () => {
  it("reproduces every query result exactly", async () => {
    const membook = await seeded(root);

    const before = [];
    for (const query of QUERIES) before.push(await membook.search(query));

    await rm(membook.paths.indexFile, { force: true });
    const result = await membook.reindex();
    expect(result.indexed).toBe(CORPUS.length);
    expect(result.quarantined).toHaveLength(0);

    const after = [];
    for (const query of QUERIES) after.push(await membook.search(query));

    expect(after).toEqual(before);
  });

  it("is stable across repeated rebuilds", async () => {
    const membook = await seeded(root);
    await membook.reindex();
    const first = await membook.search("sqlite index");
    await membook.reindex();
    const second = await membook.search("sqlite index");
    expect(second).toEqual(first);
  });

  it("rebuilds byte-identically from the same files", async () => {
    const membook = await seeded(root);
    await membook.reindex();
    const a = await readFile(membook.paths.indexFile);
    await membook.reindex();
    const b = await readFile(membook.paths.indexFile);
    expect(b.equals(a)).toBe(true);
  });

  it("does not depend on the order files were written", async () => {
    const membook = await seeded(root);
    await membook.reindex();
    const expected = await membook.search("sqlite index cache");

    // Rebuild from the same files in a fresh repo, written in reverse order.
    const other = await tempRepo();
    try {
      const second = new Membook(other.root);
      await mkdir(second.paths.memories, { recursive: true });
      const files = await readdir(membook.paths.memories);
      for (const file of [...files].reverse()) {
        await writeFile(
          join(second.paths.memories, file),
          await readFile(join(membook.paths.memories, file), "utf8"),
          "utf8",
        );
      }
      await second.reindex();
      expect(await second.search("sqlite index cache")).toEqual(expected);
    } finally {
      await other.cleanup();
    }
  });
});

describe("malformed files", () => {
  it("continues the rebuild, quarantines the file, and reports it", async () => {
    const membook = await seeded(root);
    const files = await readdir(membook.paths.memories);
    const victim = files.sort()[0]!;
    await writeFile(
      join(membook.paths.memories, victim),
      "---\nmemfile: 1\nstatus: nonsense\n---\n\nBroken.\n",
      "utf8",
    );

    const result = await membook.reindex();

    // The other memories still indexed — one corrupt file must not cost them.
    expect(result.indexed).toBe(CORPUS.length - 1);
    expect(result.quarantined).toHaveLength(1);
    expect(result.quarantined[0]!.file).toBe(victim);
    expect(result.quarantined[0]!.issues.length).toBeGreaterThan(0);
  });

  it("writes a quarantine report but leaves the file in place", async () => {
    const membook = await seeded(root);
    const victim = (await readdir(membook.paths.memories)).sort()[0]!;
    const path = join(membook.paths.memories, victim);
    await writeFile(path, "---\nmemfile: 1\n---\n\nBroken.\n", "utf8");

    await membook.reindex();

    // Quarantine is gitignored: moving a committed memory there would delete
    // it from the working tree. The file stays; a report is written.
    expect(await readFile(path, "utf8")).toContain("Broken.");
    const reports = await readdir(membook.paths.quarantine);
    expect(reports).toContain(`${victim}.json`);
  });

  it("clears stale quarantine reports once a file is repaired", async () => {
    const membook = await seeded(root);
    const victim = (await readdir(membook.paths.memories)).sort()[0]!;
    const path = join(membook.paths.memories, victim);
    const original = await readFile(path, "utf8");

    await writeFile(path, "---\nmemfile: 1\n---\n\nBroken.\n", "utf8");
    await membook.reindex();
    expect(await readdir(membook.paths.quarantine)).toHaveLength(1);

    await writeFile(path, original, "utf8");
    const result = await membook.reindex();
    expect(result.quarantined).toHaveLength(0);
    await expect(readdir(membook.paths.quarantine)).rejects.toThrow();
  });
});

describe("pinned index metadata", () => {
  it("stamps every pinned assumption", async () => {
    const membook = await seeded(root);
    const db = openIndex(membook.paths.indexFile);
    try {
      expect(readMetadata(db)).toEqual({ ...INDEX_METADATA });
    } finally {
      db.close();
    }
  });

  it.each(["tokenizer", "spec_version", "schema_version", "embedding_model", "embedding_dims"])(
    "fails loudly when %s drifts, rather than mixing assumptions",
    async (key) => {
      const membook = await seeded(root);
      const db = openIndex(membook.paths.indexFile);
      db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("drifted", key);
      db.close();

      expect(() => openIndex(membook.paths.indexFile)).toThrow(IndexMetadataMismatchError);
      expect(() => openIndex(membook.paths.indexFile)).toThrow(/membook reindex/);
    },
  );

  it("names every drifted key in the error", async () => {
    const membook = await seeded(root);
    const db = openIndex(membook.paths.indexFile);
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("x", "tokenizer");
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("y", "embedding_model");
    db.close();

    try {
      openIndex(membook.paths.indexFile);
      expect.unreachable("should have thrown");
    } catch (error) {
      const err = error as IndexMetadataMismatchError;
      expect(err.mismatches.map((m) => m.key).sort()).toEqual([
        "embedding_model",
        "tokenizer",
      ]);
    }
  });

  it("recovers by rebuilding, since the index is disposable", async () => {
    const membook = await seeded(root);
    const db = openIndex(membook.paths.indexFile);
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("drifted", "tokenizer");
    db.close();

    expect(() => openIndex(membook.paths.indexFile)).toThrow(IndexMetadataMismatchError);
    await expect(membook.reindex()).resolves.toMatchObject({ indexed: CORPUS.length });
    await expect(membook.search("sqlite")).resolves.not.toHaveLength(0);
  });
});
