import type { MemoryScope, MemoryStatus, MemoryType } from "@membook/spec";
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

  /**
   * Absolute floor for context nobody asked for.
   *
   * Measured against three memories and eleven queries, once coverage counted
   * whole words: a strong match scores ~1.25, a genuinely relevant question
   * lands between 0.62 and 0.94, and every unrelated query scores exactly 0.
   * The gap between "relevant" and "noise" is therefore wide and empty, and
   * this sits in the middle of it — low enough to keep the weakest real match,
   * high enough that nothing else survives.
   *
   * The value is not delicate; the DECISION is. Silence is the correct and
   * common answer for a surface that fires on every prompt, so when this is
   * wrong it should be wrong toward saying nothing.
   */
  pushFloor: 0.4,

  /**
   * Matched terms needed before relevance is trusted in full.
   *
   * Two, because one common word landing inside a memory is a coincidence and
   * two independent terms is the smallest thing that is not.
   */
  evidenceFullAt: 2,

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
 * Words carrying no signal about what is being asked.
 *
 * Kept deliberately short — only words that are nearly always noise. An
 * aggressive list would silently drop real query terms, and unlike a missed
 * stopword that costs precision, a dropped content word costs the answer.
 *
 * They matter because coverage is a RATIO: with stopwords counted, a memory
 * matching only `the` in a five-word question scores the same 20% coverage as
 * one matching a genuinely rare term.
 */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "that",
  "this",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "doing",
  "have",
  "has",
  "had",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "about",
  "as",
  "from",
  "into",
  "it",
  "its",
  "we",
  "you",
  "your",
  "our",
  "my",
  "me",
  "us",
  "he",
  "she",
  "they",
  "them",
  "i",
  "what",
  "which",
  "who",
  "whom",
  "when",
  "where",
  "why",
  "how",
  "can",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "must",
  "not",
  "no",
  "so",
  "up",
  "out",
  "over",
  "under",
  "again",
  "here",
  "there",
  "all",
  "any",
  "some",
  "please",
  "just",
  "now",
  "get",
  "got",
  "make",
  "made",
  "let",
  "lets",
]);

/**
 * Query terms, lowercased and stripped of stopwords, for coverage scoring.
 *
 * BM25 alone is a poor precision signal here: under OR matching, a memory
 * that hits ONE rare term of a four-term query can outscore its actual
 * relevance, and a small corpus makes IDF degenerate enough to do it often.
 * Coverage asks the blunter question — how much of what was asked does this
 * memory actually speak to?
 */
export function queryTerms(query: string): string[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((t) => t.length > 1)
    ),
  ];
  const content = terms.filter((t) => !STOPWORDS.has(t));
  // A query made entirely of stopwords keeps them: dividing by zero terms
  // would report perfect coverage for everything, which is worse than noise.
  return content.length > 0 ? content : terms;
}

/**
 * WHOLE WORDS ONLY.
 *
 * Substring matching looks equivalent and is not: `me` matches inside `timer`,
 * `is` inside `sessions`, `on` inside `boundary`. Measured, that gave three
 * completely unrelated queries — a haiku request, a weather question, a CSS
 * refactor — the *same* non-zero coverage against a memory about auth tokens.
 *
 * That is invisible while the floor is relative, because the best of several
 * bad hits still wins. It stops being invisible the moment anything decides
 * "is this good enough to show unasked", which is what a hook does on every
 * prompt.
 *
 * KNOWN LIMITATION: no stemming, so `idempotency` does not match a memory
 * saying `idempotent` — measured, that query scores 0. Substring matching did
 * not solve this either (the query term is the longer word), so this is a
 * pre-existing gap rather than a regression. Left for the dogfood period to
 * judge: stemming trades a real miss against a class of false positives, and
 * that trade should be made on logged misses, not on taste.
 */
/** How many distinct query terms the body actually contains. */
export function matchedTerms(body: string, terms: readonly string[]): number {
  const words = new Set(
    body
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter(Boolean)
  );
  return terms.filter(
    (t) =>
      words.has(t) ||
      // Path-ish terms still match as substrings: a query for `auth.ts` should
      // hit a memory naming `src/auth.ts`, and word splitting alone will not.
      (t.includes("/") || t.includes(".")
        ? body.toLowerCase().includes(t)
        : false)
  ).length;
}

export function termCoverage(body: string, terms: readonly string[]): number {
  if (terms.length === 0) return 1;
  return matchedTerms(body, terms) / terms.length;
}

/**
 * ONE MATCHED WORD IS NOT EVIDENCE, WHATEVER THE RATIO SAYS.
 *
 * Coverage is a ratio, so a one-term query scores 0 or 1 with nothing in
 * between. Measured against 61 real prompts from this repo's own sessions,
 * "WHat is next" reduced to the single term `next`, found it in "the next
 * person" inside a memory about gitleaks, and scored 1.25 — the maximum, and
 * the highest-ranked result in the entire replay.
 *
 * Stopword filtering made this worse rather than better: stripping `what` and
 * `is` shrank the denominator to one common word, so the vaguest questions
 * became the most confident matches. The fix that improved precision on long
 * queries degraded it on short ones, which is only visible against real
 * traffic — the eleven queries this was originally tuned on were all specific.
 *
 * Damping by how much evidence exists, rather than by what fraction of a tiny
 * query it represents, restores the intended meaning: two independent term
 * matches is weak-but-real, one is a coincidence.
 */
export function evidenceFactor(matched: number): number {
  return Math.min(1, matched / RANKING.evidenceFullAt);
}

export interface RecallHit {
  id: string;
  file: string;
  type: MemoryType;
  /** Null for user-scope memories: no lifecycle exists to report. */
  status: MemoryStatus | null;
  scope: MemoryScope;
  /**
   * Workspace member this hit came from; absent for local hits. Provenance
   * must be visible in the payload — an agent has to be able to tell local
   * knowledge from a neighbour's testimony.
   */
  member?: string;
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
  /**
   * An ABSOLUTE score floor, applied alongside the relative one.
   *
   * The relative floor answers "which of these is best". It cannot answer "is
   * any of these good enough", because the top hit always clears a fraction of
   * itself — so with a relative floor alone, a query matching nothing well
   * still returns its least-bad match.
   *
   * That is the right behaviour when an agent ASKED: it wants the best
   * available answer and can discard it. It is the wrong behaviour for
   * anything that injects context unasked, where the reader cannot tell where
   * a line came from and cannot discount it. Push surfaces set this.
   */
  minScore?: number;
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
  status: MemoryStatus | null;
  scope: MemoryScope;
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
      `SELECT m.id, m.file, m.type, m.status, m.scope, m.confidence, m.body,
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
    // User-scope rows have no status to gate on: recall serves them plainly
    // (v0.2 §8) — relevance still gates, like everything else.
    if (row.status !== null && !eligible.includes(row.status)) {
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
    const matched = matchedTerms(row.body, terms);
    const coverage = terms.length === 0 ? 1 : matched / terms.length;
    // Evidence damps the ratio: a one-term query cannot reach full relevance
    // on a single common word, however perfect its coverage looks.
    const relevance =
      Math.min(1, Math.abs(row.rank) / scale) *
      coverage *
      evidenceFactor(matched);
    const proximity = contextPaths.length
      ? Math.max(
          0,
          ...anchors.flatMap((a) =>
            contextPaths.map((c) => pathAffinity(a.path, c))
          )
        )
      : 0;
    const recency = recencyScore(row.verified ?? row.created, now);
    // A user memory carries no verification signal either way; weighting it
    // below verified would claim a doubt nobody holds, above would claim a
    // check nobody ran. Full weight, gated by relevance alone.
    const statusWeight =
      row.status === null ? 1 : RANKING.statusWeight[row.status];

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
      scope: row.scope,
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
  const floor = Math.max(top * floorRatio, options.minScore ?? 0);
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
