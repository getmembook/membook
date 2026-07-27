import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  idFromFilename,
  memoryFilename,
  resolveMemoryId,
  safeParseMemfile,
  serializeMemfile,
  type Memfile,
  type MemoryInput,
  type UserMemory,
} from "@membook/spec";
import { WriteBlockedError } from "./errors.js";
import { NoopWriteGuard, runGuards, type WriteGuard } from "./guard.js";
import { INDEX_METADATA, type IndexDb } from "./index-db.js";
import { indexMemory } from "./reindex.js";
import {
  recall as recallFromIndex,
  type RecallOptions,
  type RecallResult,
} from "./recall.js";

/**
 * THE USER STORE (v0.2 §8): memories that follow the HUMAN, not a repo.
 *
 * They live in `~/.membook/store/`, join recall in every session, and never
 * enter any committed book — a preference travels with the person, and
 * committing it would put one human's testimony into a shared artifact.
 *
 * There is deliberately NO on-disk index here. A person's preferences number
 * in the dozens, and building the FTS index in memory per recall costs
 * milliseconds — where an on-disk cache would import the entire staleness
 * story (metadata pinning, rebuild commands, mismatch errors) for a corpus
 * that cannot need it. Revisit when someone shows up with a thousand.
 */

export interface UserPaths {
  /** `~/.membook/` */
  root: string;
  /** `~/.membook/store/` — canonical user memories. Never committed. */
  store: string;
}

/**
 * `MEMBOOK_HOME` overrides where the human's store lives — for tests that
 * must not read a developer's real preferences, and for anyone whose home
 * is not where preferences should go.
 */
export function userPaths(
  home: string = process.env["MEMBOOK_HOME"] ?? homedir()
): UserPaths {
  const root = join(home, ".membook");
  return { root, store: join(root, "store") };
}

export interface UserMemfile extends Memfile {
  frontmatter: UserMemory;
}

export interface StoredUserMemory {
  id: string;
  file: string;
  path: string;
  memfile: UserMemfile;
}

export interface UserReadResult {
  memories: StoredUserMemory[];
  /** Unreadable or wrongly-scoped files, reported rather than served. */
  rejected: Array<{ file: string; issues: string[] }>;
}

export interface UserRememberInput {
  statement: string;
  type: UserMemory["type"];
  confidence?: number;
  now?: () => Date;
}

export interface UserStoreOptions {
  guards?: readonly WriteGuard[];
}

export class UserStore {
  readonly paths: UserPaths;
  private readonly guards: readonly WriteGuard[];

  constructor(paths: UserPaths = userPaths(), options: UserStoreOptions = {}) {
    this.paths = paths;
    this.guards = options.guards ?? [new NoopWriteGuard()];
  }

  private async listFiles(): Promise<string[]> {
    try {
      return (await readdir(this.paths.store))
        .filter((f) => idFromFilename(f) !== null)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async readAll(): Promise<UserReadResult> {
    const memories: StoredUserMemory[] = [];
    const rejected: UserReadResult["rejected"] = [];

    for (const file of await this.listFiles()) {
      const path = join(this.paths.store, file);
      const parsed = safeParseMemfile(await readFile(path, "utf8"), file);
      if (!parsed.ok) {
        rejected.push({ file, issues: parsed.error.issues });
        continue;
      }
      if (parsed.memfile.frontmatter.scope !== "user") {
        // The mirror of the repo store's gate: anchored knowledge in the
        // user store is repo knowledge that lost its way home.
        rejected.push({
          file,
          issues: [
            `scope: \`${parsed.memfile.frontmatter.scope}\` memories belong in a repository's .membook/memories, not in the user store`,
          ],
        });
        continue;
      }
      memories.push({
        id: idFromFilename(file)!,
        file,
        path,
        memfile: parsed.memfile as UserMemfile,
      });
    }
    return { memories, rejected };
  }

  /** Record a preference: authored by the human, no anchors, no lifecycle. */
  async remember(input: UserRememberInput): Promise<StoredUserMemory> {
    const now = input.now ?? (() => new Date());
    const taken = new Set((await this.readAll()).memories.map((m) => m.id));
    const id = resolveMemoryId(input.statement, (candidate) =>
      taken.has(candidate)
    );

    const frontmatter: MemoryInput = {
      memfile: 2,
      id,
      type: input.type,
      scope: "user",
      confidence: input.confidence ?? 0.9,
      created: `${now().toISOString().slice(0, 19)}Z`,
      provenance: { origin: "authored", author: "human" },
    };

    const file = memoryFilename(id);
    const text = serializeMemfile(frontmatter, input.statement, file);
    const parsed = safeParseMemfile(text, file);
    if (!parsed.ok) throw parsed.error;

    const blocked = await runGuards(this.guards, {
      frontmatter: parsed.memfile.frontmatter,
      body: parsed.memfile.body,
      text,
      file,
    });
    if (blocked) throw new WriteBlockedError(blocked.guard, blocked.findings);

    await mkdir(this.paths.store, { recursive: true });
    const path = join(this.paths.store, file);
    await writeFile(path, text, "utf8");
    return { id, file, path, memfile: parsed.memfile as UserMemfile };
  }

  /**
   * Recall over the user corpus: the SAME ranking code as the repo index,
   * against a throwaway in-memory FTS build. Same scoring honesty, none of
   * the cache-staleness machinery.
   */
  async recall(
    query: string,
    options: RecallOptions = {}
  ): Promise<RecallResult> {
    const { memories } = await this.readAll();
    if (memories.length === 0) {
      return { hits: [], withheld: { belowFloor: 0, byStatus: {} } };
    }

    const db: IndexDb = new Database(":memory:");
    try {
      db.exec(`
CREATE TABLE memories (
  id TEXT PRIMARY KEY, file TEXT NOT NULL, type TEXT NOT NULL,
  status TEXT, scope TEXT NOT NULL, confidence REAL NOT NULL,
  created TEXT NOT NULL, verified TEXT, body TEXT NOT NULL,
  frontmatter TEXT NOT NULL
) STRICT;
CREATE TABLE anchors (
  memory_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  path TEXT NOT NULL, symbol TEXT, commit_sha TEXT NOT NULL,
  PRIMARY KEY (memory_id, seq)
) STRICT;
CREATE VIRTUAL TABLE memories_fts USING fts5(
  body, content='', tokenize="${INDEX_METADATA.tokenizer}"
);
`);
      memories.forEach((memory, i) => indexMemory(db, memory, i + 1));
      return recallFromIndex(db, query, options);
    } finally {
      db.close();
    }
  }
}
