import type { MemoryInput } from "@membook/spec";
import { repoPaths, type RepoPaths } from "./paths.js";
import {
  MemoryStore,
  type StoredMemory,
  type MemoryStoreOptions,
} from "./store.js";
import { openIndex, type IndexDb } from "./index-db.js";
import {
  indexMemory,
  removeFromIndex,
  reindex,
  type ReindexResult,
} from "./reindex.js";
import { search, type SearchHit, type SearchOptions } from "./search.js";
import { verifyPass, type VerifyOptions, type VerifyReport } from "./verify.js";
import { recall, type RecallOptions, type RecallResult } from "./recall.js";
import { compileBook, writeBook, type BookReport } from "./book.js";
import { WriteBlockedError, type QuarantineRecord } from "./errors.js";
import {
  FileInstrumentation,
  NullInstrumentation,
  type Instrumentation,
} from "./instrumentation.js";

export interface MembookOptions extends MemoryStoreOptions {
  /**
   * Local event log. Off unless asked for: writing files nobody requested is
   * not the default a local-first tool should ship.
   */
  instrumentation?: Instrumentation | boolean;
}

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
  readonly instrumentation: Instrumentation;

  constructor(root: string, options: MembookOptions = {}) {
    this.paths = repoPaths(root);
    this.store = new MemoryStore(this.paths, options);
    this.instrumentation =
      options.instrumentation === true
        ? new FileInstrumentation(this.paths.telemetry)
        : options.instrumentation === false ||
          options.instrumentation === undefined
        ? new NullInstrumentation()
        : options.instrumentation;
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
  async remember(
    frontmatter: MemoryInput,
    body: string
  ): Promise<StoredMemory> {
    let stored: StoredMemory;
    try {
      stored = await this.store.write(frontmatter, body);
    } catch (error) {
      // A blocked write is the single most important thing to log: it is the
      // scanner earning its keep, and the number nobody can otherwise see.
      if (error instanceof WriteBlockedError) {
        this.instrumentation.record({
          event: "write_blocked",
          guard: error.guard,
          rules: error.findings.map((f) => f.rule),
        });
      }
      throw error;
    }

    this.instrumentation.record({
      event: "remember",
      id: stored.id,
      type: stored.memfile.frontmatter.type,
      anchors: stored.memfile.frontmatter.anchors.length,
    });

    const db = this.open();
    try {
      const existing = db
        .prepare("SELECT rowid FROM memories WHERE id = ?")
        .get(stored.id) as { rowid: number } | undefined;
      if (existing) removeFromIndex(db, stored.id);
      const nextRowid =
        existing?.rowid ??
        (
          db
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS max FROM memories")
            .get() as {
            max: number;
          }
        ).max + 1;
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

  /** Raw index query: BM25 relevance only, no re-ranking and no floor. */
  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<SearchHit[]> {
    const db = this.open();
    try {
      return search(db, query, options);
    } finally {
      db.close();
    }
  }

  /**
   * What an agent actually receives: hybrid-ranked, floored, and capped.
   *
   * Deliberately distinct from `search`. A raw index query is fine for a
   * human at a CLI who can discard a bad row; an agent cannot, and a weak
   * match in its context is worse than no match at all.
   */
  async recall(
    query: string,
    options: RecallOptions = {}
  ): Promise<RecallResult> {
    const db = this.open();
    try {
      const result = recall(db, query, options);
      this.instrumentation.record({
        event: "recall",
        query_terms: query.trim().split(/\s+/).filter(Boolean).length,
        served: result.hits.length,
        withheld_below_floor: result.withheld.belowFloor,
        withheld_by_status: result.withheld.byStatus,
        top_score: result.hits[0]?.score ?? null,
        context_paths: options.contextPaths?.length ?? 0,
      });
      return result;
    } finally {
      db.close();
    }
  }

  /** Rebuild the index from the files. */
  async reindex(): Promise<ReindexResult> {
    return reindex(this.paths, this.store);
  }

  /**
   * Diff every anchor against HEAD and update memory statuses.
   *
   * Reindexes afterwards when anything changed: the pass writes through the
   * store, which is file-only by design, so the index would otherwise keep
   * serving the statuses that a status-filtered `recall` depends on.
   */
  async verify(options: VerifyOptions = {}): Promise<VerifyReport> {
    const report = await verifyPass(this.paths.root, this.store, options);
    for (const v of report.changed) {
      this.instrumentation.record({
        event: "verify",
        id: v.id,
        from: v.from,
        to: v.to,
        rechecked: v.rechecked,
        outcomes: v.outcomes.map((o) => o.kind),
      });
    }
    if (!report.dryRun && report.changed.length > 0) await this.reindex();
    return report;
  }

  /** Compile the boot pack without writing it. */
  async compileBook(options: { now?: Date } = {}): Promise<BookReport> {
    return compileBook(this.store, options);
  }

  /** Compile the boot pack and write `MEMBOOK.md`. */
  async writeBook(options: { now?: Date } = {}): Promise<BookReport> {
    const report = await writeBook(this.paths, this.store, options);
    this.instrumentation.record({
      event: "book",
      carried: report.entries.length,
      omitted: report.omitted,
      excluded: report.excluded,
      tokens: report.tokens,
    });
    return report;
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
