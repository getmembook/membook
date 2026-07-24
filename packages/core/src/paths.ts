import { join } from "node:path";

/**
 * Repository layout. Only `memories/` is canonical and committed; everything
 * else under `.membook/` is derived, gitignored, and safe to delete.
 */
export interface RepoPaths {
  /** Repository root. */
  root: string;
  /** `.membook/` */
  membook: string;
  /** `.membook/memories/` — CANONICAL. The truth. Committed. */
  memories: string;
  /** `.membook/index/` — disposable cache. Gitignored. */
  index: string;
  /** `.membook/index/memories.db` */
  indexFile: string;
  /** `.membook/quarantine/` — reports for files that failed validation. */
  quarantine: string;
  /** `MEMBOOK.md` at the repo root — the compiled boot pack. */
  book: string;
}

export function repoPaths(root: string): RepoPaths {
  const membook = join(root, ".membook");
  const index = join(membook, "index");
  return {
    root,
    membook,
    memories: join(membook, "memories"),
    index,
    indexFile: join(index, "memories.db"),
    quarantine: join(membook, "quarantine"),
    book: join(root, "MEMBOOK.md"),
  };
}
