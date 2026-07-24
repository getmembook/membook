import type { MemoryInput } from "@membook/spec";
import { repoPaths, type RepoPaths } from "./paths.js";
import { MemoryStore, type StoredMemory, type MemoryStoreOptions } from "./store.js";
import { openIndex, type IndexDb } from "./index-db.js";
import { indexMemory, removeFromIndex, reindex, type ReindexResult } from "./reindex.js";
import { search, type SearchHit, type SearchOptions } from "./search.js";
import type { QuarantineRecord } from "./errors.js";

export interface MembookOptions extends MemoryStoreOptions {}

export interface StatusReport {
  indexed: number;
  onDisk: number;
  quarantined: QuarantineRecord[];
  byStatus: Record<string, number>;
}

/**
 * The engine: files plus a derived index.
 */
export class Membook {
  readonly paths: RepoPaths;
  readonly store: MemoryStore;

  constructor(root: string, options: MembookOptions = {}) {
    this.paths = repoPaths(root);
    this.store = new MemoryStore(this.paths, options);
  }

  private open(): IndexDb {
    return openIndex(this.paths.indexFile);
  }

  /**
   * WRITE ORDERING IS FILE-FIRST, ALWAYS.
   *
   * The file lands, then the index is updated. A crash between the two
   * leaves the index stale — which is by definition healable, because
   * `reindex` rebuilds it from the files. That is the entire crash story,
   * and it is why no two-phase commit lives here: coordination between a
   * source of truth and its own disposable cache would only add failure
   * modes that the existing recovery mechanism does not cover.
   *
   * The reverse order would be genuinely unsafe: an indexed memory with no
   * file is a phantom that `reindex` cannot heal, only forget.
   */
  async remember(frontmatter: MemoryInput, body: string): Promise<StoredMemory> {
    const stored = await this.store.write(frontmatter, body);

    const db = this.open();
    try {
      const existing = db
        .prepare("SELECT rowid FROM memories WHERE id = ?")
        .get(stored.id) as { rowid: number } | undefined;
      if (existing) removeFromIndex(db, stored.id);
      const nextRowid =
        existing?.rowid ??
        ((db.prepare("SELECT COALESCE(MAX(rowid), 0) AS max FROM memories").get() as {
          max: number;
        }).max +
          1);
      indexMemory(db, stored, nextRowid);
    } finally {
      db.close();
    }

    return stored;
  }

  async forget(id: string): Promise<void> {
    await this.store.delete(id);
    const db = this.open();
    try {
      removeFromIndex(db, id);
    } finally {
      db.close();
    }
  }

  async recall(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const db = this.open();
    try {
      return search(db, query, options);
    } finally {
      db.close();
    }
  }

  /** Rebuild the index from the files. */
  async reindex(): Promise<ReindexResult> {
    return reindex(this.paths, this.store);
  }

  async status(): Promise<StatusReport> {
    const { memories, quarantined } = await this.store.readAll();
    const db = this.open();
    try {
      const indexed = (
        db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }
      ).n;
      const byStatus: Record<string, number> = {};
      for (const memory of memories) {
        const status = memory.memfile.frontmatter.status;
        byStatus[status] = (byStatus[status] ?? 0) + 1;
      }
      return { indexed, onDisk: memories.length, quarantined, byStatus };
    } finally {
      db.close();
    }
  }
}
