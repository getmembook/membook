import { rm } from "node:fs/promises";
import type { Memory } from "@membook/spec";
import type { IndexDb } from "./index-db.js";
import { openIndex } from "./index-db.js";
import type { MemoryStore, StoredMemory } from "./store.js";
import type { QuarantineRecord } from "./errors.js";
import type { RepoPaths } from "./paths.js";

export interface ReindexResult {
  indexed: number;
  quarantined: QuarantineRecord[];
}

/**
 * Insert one memory into the index. Rowids are assigned from the sorted walk
 * so a rebuild reproduces identical BM25 tie-breaking, not merely an
 * equivalent set of rows.
 */
export function indexMemory(db: IndexDb, memory: StoredMemory, rowid: number): void {
  const fm: Memory = memory.memfile.frontmatter;
  db.prepare(
    `INSERT INTO memories (id, file, type, status, scope, confidence, created, verified, body, frontmatter)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fm.id,
    memory.file,
    fm.type,
    fm.status,
    fm.scope,
    fm.confidence,
    fm.created,
    fm.verified ?? null,
    memory.memfile.body,
    JSON.stringify(fm),
  );

  const anchorStmt = db.prepare(
    `INSERT INTO anchors (memory_id, seq, kind, path, symbol, commit_sha)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  fm.anchors.forEach((anchor, seq) => {
    anchorStmt.run(fm.id, seq, anchor.kind, anchor.path, anchor.symbol ?? null, anchor.commit);
  });

  db.prepare("INSERT INTO memories_fts (rowid, body) VALUES (?, ?)").run(
    rowid,
    memory.memfile.body,
  );
  db.prepare("UPDATE memories SET rowid = ? WHERE id = ?").run(rowid, fm.id);
}

export function removeFromIndex(db: IndexDb, id: string): void {
  const row = db.prepare("SELECT rowid FROM memories WHERE id = ?").get(id) as
    | { rowid: number }
    | undefined;
  if (!row) return;
  db.prepare("INSERT INTO memories_fts (memories_fts, rowid, body) VALUES ('delete', ?, ?)").run(
    row.rowid,
    (db.prepare("SELECT body FROM memories WHERE id = ?").get(id) as { body: string }).body,
  );
  db.prepare("DELETE FROM anchors WHERE memory_id = ?").run(id);
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

/**
 * Rebuild the index from the files, which are the truth.
 *
 * The database file is deleted rather than emptied: a rebuild must not
 * inherit anything from the previous one, including metadata stamped by an
 * older build. This is why the index can be thrown away at any time.
 */
export async function reindex(
  paths: RepoPaths,
  store: MemoryStore,
): Promise<ReindexResult> {
  await rm(paths.indexFile, { force: true });
  await rm(`${paths.indexFile}-wal`, { force: true });
  await rm(`${paths.indexFile}-shm`, { force: true });

  const { memories, quarantined } = await store.readAll();
  const db = openIndex(paths.indexFile);
  try {
    const insertAll = db.transaction((batch: StoredMemory[]) => {
      batch.forEach((memory, i) => indexMemory(db, memory, i + 1));
    });
    insertAll(memories);
  } finally {
    db.close();
  }

  return { indexed: memories.length, quarantined };
}
