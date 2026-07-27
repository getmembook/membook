import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { IndexDb } from "./index-db.js";
import { openIndex } from "./index-db.js";
import { indexMemory } from "./reindex.js";
import { MemoryStore } from "./store.js";
import { repoPaths } from "./paths.js";
import { headSha, isGitRepository } from "./git.js";
import { userPaths } from "./user-store.js";
import {
  recall as recallFromIndex,
  type RecallHit,
  type RecallOptions,
  type RecallResult,
} from "./recall.js";
import type { ResolvedWorkspace } from "./workspace.js";

/**
 * FEDERATED RECALL (v0.2 §7, §10): one query, every member's book.
 *
 * The hard rule first: Membook NEVER writes inside a checkout it did not
 * init — not an index, not a byte. Polluting a neighbour's tree is both rude
 * and a false-comfort trap. But `recall` needs an FTS index, and a neighbour
 * who has never run Membook does not have one.
 *
 * The resolution is remembering what the index IS: a disposable derived
 * cache — and caches live in cache directories. Neighbour indexes build
 * under `~/.membook/workspace-cache/<member>/`, keyed by the member's name
 * and indexed HEAD, and rebuild when the member's HEAD moves. Same index
 * code, same retrieval path, different location. Their tree is untouched,
 * and "read-only" is literally true rather than load-bearing prose.
 */

export interface FederatedMemberResult {
  member: string;
  served: number;
  /** Set when the member could not be searched, with the reason. */
  skipped?: string;
}

export interface FederatedRecallResult extends RecallResult {
  /** Per-member accounting, so silence from a member is attributable. */
  members: FederatedMemberResult[];
}

/**
 * A remote hit must never outrank an equally-relevant local one — the local
 * repo is what the agent is standing in — but like every modulation, this
 * cannot rescue a floor failure: it multiplies, it does not add.
 */
export const CROSS_REPO_WEIGHT = 0.85;

export function workspaceCacheDir(member: string): string {
  return join(userPaths().root, "workspace-cache", member);
}

/**
 * Open (building if needed) the cache index for one member checkout.
 *
 * Keyed by indexed HEAD: a cache built at another commit is deleted and
 * rebuilt, because an index that half-remembers an older tree retrieves
 * confidently and wrongly. First recall against a large neighbour pays a
 * build; that is acceptable and reported by the caller.
 */
async function openMemberIndex(
  member: string,
  checkout: string
): Promise<{ db: IndexDb; built: boolean } | { error: string }> {
  const store = new MemoryStore(repoPaths(checkout));
  const files = await store.listFiles();
  if (files.length === 0) {
    return { error: "no memories recorded" };
  }

  const head = await headSha(checkout);
  const cacheFile = join(workspaceCacheDir(member), `${head}.db`);

  try {
    const db = openIndex(cacheFile, { create: false });
    return { db, built: false };
  } catch {
    // Stale or absent: clear the member's whole cache dir (old HEADs have no
    // second life) and rebuild from the neighbour's files, read-only.
    await rm(workspaceCacheDir(member), { recursive: true, force: true });
    const db = openIndex(cacheFile);
    try {
      const { memories } = await store.readAll();
      const insertAll = db.transaction(() => {
        memories.forEach((memory, i) => indexMemory(db, memory, i + 1));
      });
      insertAll();
    } catch (error) {
      db.close();
      throw error;
    }
    return { db, built: true };
  }
}

/**
 * Fan a query out across the workspace's resolved members and merge with the
 * local result. Every cross-repo hit carries `member`, so provenance is
 * visible in the payload — an agent must be able to distinguish local
 * knowledge from a neighbour's testimony.
 */
export async function federatedRecall(
  localResult: RecallResult,
  workspace: ResolvedWorkspace,
  query: string,
  options: RecallOptions & { localRepoRoot?: string } = {}
): Promise<FederatedRecallResult> {
  const limit = options.limit ?? 8;
  const members: FederatedMemberResult[] = [];
  const remoteHits: RecallHit[] = [];
  let withheldBelowFloor = localResult.withheld.belowFloor;
  const withheldByStatus = { ...localResult.withheld.byStatus };

  for (const member of workspace.members) {
    if (member.state !== "resolved") {
      members.push({ member: member.name, served: 0, skipped: member.reason });
      continue;
    }
    if (!(await isGitRepository(member.path))) {
      members.push({
        member: member.name,
        served: 0,
        skipped: `${member.path} is not a git repository`,
      });
      continue;
    }

    let opened: Awaited<ReturnType<typeof openMemberIndex>>;
    try {
      opened = await openMemberIndex(member.name, member.path);
    } catch (error) {
      members.push({
        member: member.name,
        served: 0,
        skipped: (error as Error).message,
      });
      continue;
    }
    if ("error" in opened) {
      members.push({ member: member.name, served: 0, skipped: opened.error });
      continue;
    }

    try {
      const result = recallFromIndex(opened.db, query, {
        ...options,
        // Path proximity is a claim about THIS repo's working set; a
        // neighbour's paths are a different filesystem of meaning.
        contextPaths: [],
      });
      for (const hit of result.hits) {
        remoteHits.push({
          ...hit,
          member: member.name,
          score: hit.score * CROSS_REPO_WEIGHT,
        });
      }
      members.push({ member: member.name, served: result.hits.length });
      withheldBelowFloor += result.withheld.belowFloor;
      for (const [status, n] of Object.entries(result.withheld.byStatus)) {
        withheldByStatus[status] = (withheldByStatus[status] ?? 0) + n;
      }
    } finally {
      opened.db.close();
    }
  }

  const merged = [...localResult.hits, ...remoteHits].sort(
    (a, b) =>
      b.score - a.score ||
      // Local before remote on a dead tie, then id — deterministic always.
      Number(a.member !== undefined) - Number(b.member !== undefined) ||
      a.id.localeCompare(b.id)
  );

  const hits = merged.slice(0, limit);
  withheldBelowFloor += merged.length - hits.length;

  return {
    hits,
    withheld: { belowFloor: withheldBelowFloor, byStatus: withheldByStatus },
    members,
  };
}

