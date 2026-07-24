import type { MemoryStatus, MemoryType } from "@membook/spec";
import type { IndexDb } from "./index-db.js";
import { toMatchQuery, type MatchMode } from "./search.js";

/**
 * RETRIEVAL PRECISION IS THE BINDING CONSTRAINT.
 *
 * Writing a memory is cheap — break-even reuse sits around 3–6%, so we write
 * generously. Serving the WRONG memory is not cheap: contaminated context
 * inflates per-step error rates several-fold, so a weak match handed to an
 * agent costs more than no match at all.
 *
 * Every knob below therefore biases toward returning less.
 */
export const RANKING = {
  /**
   * Relevance GATES; everything else only modulates.
   *
   * These are multiplicative boosts on top of relevance, never additive
   * terms beside it. Added, a fresh-but-irrelevant memory collects a
   * respectable score from recency alone and clears the floor on the
   * strength of having been written recently — which is exactly the wrong
   * thing to put in an agent's context. Multiplied, nothing that fails on
   * relevance can be rescued by any other signal.
   */
  boostProximity: 0.4,
  boostRecency: 0.25,

  /** Drop anything scoring below this fraction of the best hit. */
  floorRatio: 0.25,

  /** Half-life for recency decay. */
  recencyHalfLifeDays: 90,

  /**
   * How much a memory's status is trusted. `stale` is not zero — a stale
   * memory is often still the best pointer available — but it must never
   * outrank a verified one on relevance alone.
   */
  statusWeight: {
    verified: 1,
    unverified: 0.75,
    stale: 0.35,
    invalidated: 0,
  } satisfies Record<MemoryStatus, number>,
} as const;

export interface RecallAnchor {
  path: string;
  symbol?: string;
}

/**
 * Query terms, lowercased, for coverage scoring.
 *
 * BM25 alone is a poor precision signal here: under OR matching, a memory
 * that hits ONE rare term of a four-term query can outscore its actual
 * relevance, and a small corpus makes IDF degenerate enough to do it often.
 * Coverage asks the blunter question — how much of what was asked does this
 * memory actually speak to?
 */
export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((t) => t.length > 1)
    ),
  ];
}

export function termCoverage(body: string, terms: readonly string[]): number {
  if (terms.length === 0) return 1;
  const haystack = body.toLowerCase();
  return terms.filter((t) => haystack.includes(t)).length / terms.length;
}

export interface RecallHit {
  id: string;
  file: string;
  type: MemoryType;
  status: MemoryStatus;
  confidence: number;
  body: string;
  anchors: RecallAnchor[];
  score: number;
  signals: {
    relevance: number;
    coverage: number;
    proximity: number;
    recency: number;
    statusWeight: number;
  };
}

export interface RecallOptions {
  limit?: number;
  mode?: MatchMode;
  /** Statuses eligible to be returned. Invalidated is never eligible. */
  statuses?: readonly MemoryStatus[];
  /** Files the agent is currently touching, for path-proximity ranking. */
  contextPaths?: readonly string[];
  /** Overrides the relative floor. */
  floorRatio?: number;
  /** Injected for deterministic tests. */
  now?: Date;
}

export interface RecallResult {
  hits: RecallHit[];
  /** Matched the query but were filtered out, so callers can say so. */
  withheld: { belowFloor: number; byStatus: Record<string, number> };
}

/**
 * Path affinity between an anchor and a file the agent is working on.
 *
 * Deliberately crude: exact file, then same directory, then shared ancestry.
 * A memory anchored to the file being edited is far more likely to matter
 * than one anchored three packages away.
 */
export function pathAffinity(anchorPath: string, contextPath: string): number {
  if (anchorPath === contextPath) return 1;

  const a = anchorPath.split("/");
  const b = contextPath.split("/");
  if (a.slice(0, -1).join("/") === b.slice(0, -1).join("/")) return 0.7;

  let shared = 0;
  while (
    shared < a.length - 1 &&
    shared < b.length - 1 &&
    a[shared] === b[shared]
  ) {
    shared += 1;
  }
  if (shared === 0) return 0;
  return Math.min(0.5, (shared / Math.max(a.length, b.length)) * 0.9);
}

function recencyScore(timestamp: string | null, now: Date): number {
  if (!timestamp) return 0;
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return 0;
  const ageDays = Math.max(0, (now.getTime() - then) / 86_400_000);
  return Math.pow(0.5, ageDays / RANKING.recencyHalfLifeDays);
}

interface Row {
  id: string;
  file: string;
  type: MemoryType;
  status: MemoryStatus;
  confidence: number;
  body: string;
  created: string;
  verified: string | null;
  rank: number;
}

/**
 * Hybrid retrieval: BM25 relevance, re-ranked by path proximity, recency and
 * verification status, then floored and capped.
 *
 * Vector similarity joins this blend in a later version; the index metadata
 * already pins `embedding_model` so enabling it forces a clean rebuild.
 */
export function recall(
  db: IndexDb,
  query: string,
  options: RecallOptions = {}
): RecallResult {
  const match = toMatchQuery(query, options.mode ?? "any");
  const withheld = { belowFloor: 0, byStatus: {} as Record<string, number> };
  if (match.length === 0) return { hits: [], withheld };

  const limit = options.limit ?? 8;
  const floorRatio = options.floorRatio ?? RANKING.floorRatio;
  const now = options.now ?? new Date();
  const contextPaths = options.contextPaths ?? [];
  const eligible = (
    options.statuses ?? ["verified", "unverified", "stale"]
  ).filter((s): s is MemoryStatus => s !== "invalidated");
  if (eligible.length === 0) return { hits: [], withheld };

  // Over-fetch so re-ranking has candidates to promote, then cap after.
  const rows = db
    .prepare(
      `SELECT m.id, m.file, m.type, m.status, m.confidence, m.body,
              m.created, m.verified, bm25(memories_fts) AS rank
       FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?
       ORDER BY rank ASC, m.id ASC
       LIMIT ?`
    )
    .all(match, Math.max(limit * 5, 40)) as Row[];

  if (rows.length === 0) return { hits: [], withheld };

  const anchorStmt = db.prepare(
    "SELECT path, symbol FROM anchors WHERE memory_id = ? ORDER BY seq"
  );

  // bm25 is negative-is-better; normalize against the strongest match so the
  // floor is expressed as "a quarter as relevant as the best", not a raw
  // score whose scale shifts with corpus size.
  const best = Math.min(...rows.map((r) => r.rank));
  const scale = best === 0 ? 1 : Math.abs(best);

  const terms = queryTerms(query);
  const scored: RecallHit[] = [];
  for (const row of rows) {
    if (!eligible.includes(row.status)) {
      withheld.byStatus[row.status] = (withheld.byStatus[row.status] ?? 0) + 1;
      continue;
    }

    const anchors = anchorStmt.all(row.id) as Array<{
      path: string;
      symbol: string | null;
    }>;

    // Coverage scales relevance rather than sitting beside it: a memory that
    // answers a quarter of the question is a quarter as relevant, however
    // strongly BM25 weighted the one term it happened to match.
    const coverage = termCoverage(row.body, terms);
    const relevance = Math.min(1, Math.abs(row.rank) / scale) * coverage;
    const proximity = contextPaths.length
      ? Math.max(
          0,
          ...anchors.flatMap((a) =>
            contextPaths.map((c) => pathAffinity(a.path, c))
          )
        )
      : 0;
    const recency = recencyScore(row.verified ?? row.created, now);
    const statusWeight = RANKING.statusWeight[row.status];

    const score =
      relevance *
      (1 +
        proximity * RANKING.boostProximity +
        recency * RANKING.boostRecency) *
      statusWeight;

    scored.push({
      id: row.id,
      file: row.file,
      type: row.type,
      status: row.status,
      confidence: row.confidence,
      body: row.body,
      anchors: anchors.map((a) => ({
        path: a.path,
        ...(a.symbol !== null ? { symbol: a.symbol } : {}),
      })),
      score,
      signals: { relevance, coverage, proximity, recency, statusWeight },
    });
  }

  if (scored.length === 0) return { hits: [], withheld };

  // Ties break by id so the same corpus always ranks the same way.
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const top = scored[0]!.score;
  const floor = top * floorRatio;
  const kept: RecallHit[] = [];
  for (const hit of scored) {
    if (hit.score <= 0 || hit.score < floor) {
      withheld.belowFloor += 1;
      continue;
    }
    if (kept.length < limit) kept.push(hit);
    else withheld.belowFloor += 1;
  }

  return { hits: kept, withheld };
}
