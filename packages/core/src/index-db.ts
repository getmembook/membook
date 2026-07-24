import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MEMFILE_SPEC_VERSION } from "@membook/spec";
import { IndexMetadataMismatchError } from "./errors.js";

/**
 * PINNED INDEX ASSUMPTIONS.
 *
 * Every value here changes what the index MEANS. If any drifts from what
 * built the file on disk, the index is not repairable in place — old rows
 * and new rows would disagree about tokenization or embedding space, and the
 * result is an index that looks healthy and retrieves badly. Mismatch fails
 * loudly and demands a rebuild, which is cheap: the index is a cache.
 */
export const INDEX_METADATA = {
  /** Bumped when the table layout below changes. */
  schema_version: "1",

  /** Memfile spec version whose fields are projected into columns. */
  spec_version: String(MEMFILE_SPEC_VERSION),

  /**
   * FTS5 tokenizer, recorded verbatim.
   *
   * Deliberately the unicode61 family rather than `tokenchars '_'`: keeping
   * `_` as a separator means `snake_case` still matches as an adjacent-token
   * phrase AND a bare `snake` matches too, so recall strictly improves.
   * `remove_diacritics 2` folds accents.
   *
   * Changing this string is a forced rebuild, which is the point of pinning
   * it — a half-retokenized index is silently bifurcated.
   */
  tokenizer: "unicode61 remove_diacritics 2",

  /**
   * Embedding model and dimensions. Null until vectors land; the transition
   * from null to a model is itself a mismatch, so enabling embeddings forces
   * a clean rebuild rather than leaving unembedded rows invisible to vector
   * search.
   */
  embedding_model: "none",
  embedding_dims: "0",
} as const;

export type IndexMetadata = typeof INDEX_METADATA;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id          TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL,
  scope       TEXT NOT NULL,
  confidence  REAL NOT NULL,
  created     TEXT NOT NULL,
  verified    TEXT,
  body        TEXT NOT NULL,
  frontmatter TEXT NOT NULL
) STRICT;

-- Anchors are a first-class table, not JSON: path-proximity ranking joins
-- against it, and the verify pass groups by commit.
CREATE TABLE IF NOT EXISTS anchors (
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  symbol     TEXT,
  commit_sha TEXT NOT NULL,
  PRIMARY KEY (memory_id, seq)
) STRICT;

CREATE INDEX IF NOT EXISTS anchors_path ON anchors(path);
CREATE INDEX IF NOT EXISTS anchors_commit ON anchors(commit_sha);
CREATE INDEX IF NOT EXISTS memories_status ON memories(status);
`;

function ftsSchema(tokenizer: string): string {
  // `content=''` keeps FTS5 contentless: the body already lives in `memories`,
  // and duplicating it would let the two copies drift.
  return `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  body,
  content='',
  tokenize="${tokenizer}"
);
`;
}

export type IndexDb = Database.Database;

export interface OpenIndexOptions {
  /** Create the file and stamp metadata if absent. */
  create?: boolean;
}

/**
 * Open the index, verifying it was built under this build's assumptions.
 *
 * WAL is set before any other statement runs: `better-sqlite3` is
 * synchronous, and a second stdio MCP session opening the same repo will
 * block on the write lock rather than error if journalling is left default.
 */
export function openIndex(
  file: string,
  options: OpenIndexOptions = {}
): IndexDb {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);

  // EVERY THROW OUT OF HERE MUST CLOSE THE HANDLE FIRST.
  //
  // The metadata-mismatch throws below used to leak it, and the leak was
  // invisible on Linux and macOS because POSIX lets you delete an open file.
  // Windows does not: the leaked handle made the index undeletable, so the
  // `reindex` that metadata drift tells the user to run — which heals by
  // DELETING the file — failed with EBUSY. The error path's own remedy was
  // blocked by the error path. Found via the advisory Windows CI job, which
  // exists for exactly this class of divergence.
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    db.exec(SCHEMA);

    const stored = readMetadata(db);
    if (Object.keys(stored).length === 0) {
      if (options.create === false) {
        throw new IndexMetadataMismatchError([
          { key: "meta", found: "empty", expected: "stamped index metadata" },
        ]);
      }
      db.exec(ftsSchema(INDEX_METADATA.tokenizer));
      writeMetadata(db);
      return db;
    }

    assertMetadataMatches(stored);
    db.exec(ftsSchema(stored["tokenizer"] ?? INDEX_METADATA.tokenizer));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function readMetadata(db: IndexDb): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM meta").all() as Array<{
    key: string;
    value: string;
  }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function writeMetadata(db: IndexDb): void {
  const stmt = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const write = db.transaction(() => {
    for (const [key, value] of Object.entries(INDEX_METADATA))
      stmt.run(key, value);
  });
  write();
}

/** Throws IndexMetadataMismatchError listing every drifted key. */
export function assertMetadataMatches(stored: Record<string, string>): void {
  const mismatches: Array<{ key: string; found: string; expected: string }> =
    [];
  for (const [key, expected] of Object.entries(INDEX_METADATA)) {
    const found = stored[key];
    if (found !== expected) {
      mismatches.push({ key, found: found ?? "(absent)", expected });
    }
  }
  if (mismatches.length > 0) throw new IndexMetadataMismatchError(mismatches);
}
