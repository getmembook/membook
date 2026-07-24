import type { MemoryStatus, MemoryType } from "@membook/spec";
import type { IndexDb } from "./index-db.js";

export interface SearchHit {
  id: string;
  file: string;
  type: MemoryType;
  status: MemoryStatus;
  /** BM25 relevance; lower is better in SQLite, negated here so higher wins. */
  score: number;
}

/**
 * `any` ranks partial matches (BM25 decides); `all` requires every term.
 *
 * `any` is the default because BM25's entire job is ordering partial
 * matches, and an all-terms query degrades to returning nothing — which
 * hands the agent no memory at all rather than an imperfect one. Precision
 * is enforced downstream by ranking, the response cap, and status filters,
 * not by making the query brittle.
 */
export type MatchMode = "any" | "all";

export interface SearchOptions {
  limit?: number;
  mode?: MatchMode;
  /** Restrict to these statuses. Retrieval precision is the binding
   * constraint — a stale memory served as fact is the failure mode. */
  statuses?: readonly MemoryStatus[];
}

/**
 * Escape a user query into an FTS5 MATCH expression.
 *
 * Raw punctuation is a syntax error in FTS5 — a query like `packages/core`
 * throws rather than returning nothing, which would turn any path-shaped
 * search into a crash. Each whitespace-separated term is quoted, so
 * `packages/core` becomes the phrase "packages core" and matches adjacency.
 *
 * Quoting also neutralizes FTS5 operators, so a user searching for the word
 * `AND` searches for the word rather than injecting an operator.
 */
export function toMatchQuery(query: string, mode: MatchMode = "any"): string {
  const terms = query
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"`);
  return terms.join(mode === "all" ? " " : " OR ");
}

/**
 * BM25 keyword search.
 *
 * Ordering is deterministic: ties on score break by id, so the same corpus
 * always produces the same ranking regardless of insertion history.
 */
export function search(
  db: IndexDb,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const match = toMatchQuery(query, options.mode ?? "any");
  if (match.length === 0) return [];

  const limit = options.limit ?? 20;
  const statuses = options.statuses;
  const statusFilter = statuses?.length
    ? ` AND m.status IN (${statuses.map(() => "?").join(", ")})`
    : "";

  const rows = db
    .prepare(
      `SELECT m.id AS id, m.file AS file, m.type AS type, m.status AS status,
              bm25(memories_fts) AS rank
       FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?${statusFilter}
       ORDER BY rank ASC, m.id ASC
       LIMIT ?`,
    )
    .all(match, ...(statuses ?? []), limit) as Array<{
    id: string;
    file: string;
    type: MemoryType;
    status: MemoryStatus;
    rank: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    file: row.file,
    type: row.type,
    status: row.status,
    score: -row.rank,
  }));
}
