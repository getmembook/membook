import type { Anchor, MemoryStatus } from "@membook/spec";
import type { MemoryStore, StoredMemory } from "./store.js";
import {
  changesSince,
  commitExists,
  followRename,
  headSha,
  pathExistsAt,
  type PathChange,
} from "./git.js";
import {
  ConservativeRechecker,
  type AnchorRechecker,
  type TouchedAnchor,
} from "./recheck.js";

export type AnchorOutcomeKind =
  | "untouched"
  | "modified"
  | "renamed"
  | "deleted"
  | "unknown-base"
  | "missing-at-base";

export interface AnchorOutcome {
  anchor: Anchor;
  kind: AnchorOutcomeKind;
  /** New path, for renames. */
  renamedTo?: string;
  change?: PathChange;
}

export interface MemoryVerdict {
  id: string;
  file: string;
  from: MemoryStatus;
  to: MemoryStatus;
  reason: string;
  outcomes: AnchorOutcome[];
  /** True when a re-checker was consulted rather than a free re-verify. */
  rechecked: boolean;
}

export interface VerifyReport {
  head: string;
  checked: number;
  changed: MemoryVerdict[];
  unchanged: MemoryVerdict[];
  byStatus: Record<MemoryStatus, number>;
  dryRun: boolean;
}

export interface VerifyOptions {
  /** Report without writing anything back. */
  dryRun?: boolean;
  rechecker?: AnchorRechecker;
}

/** Worst-wins ordering. A memory is only as good as its weakest anchor. */
const SEVERITY: Record<MemoryStatus, number> = {
  invalidated: 3,
  stale: 2,
  unverified: 1,
  verified: 0,
};

function worst(a: MemoryStatus, b: MemoryStatus): MemoryStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

async function classifyAnchor(
  root: string,
  anchor: Anchor,
  head: string,
  diffCache: Map<string, Map<string, PathChange>>
): Promise<AnchorOutcome> {
  // Already at HEAD: there is nothing between the anchor and now to diff —
  // but the path still has to be there. An anchor to a path that does not
  // exist is broken even when its commit is current.
  if (anchor.commit === head) {
    return (await pathExistsAt(root, head, anchor.path))
      ? { anchor, kind: "untouched" }
      : { anchor, kind: "deleted" };
  }

  if (!(await commitExists(root, anchor.commit))) {
    // The baseline is gone — a rewritten history, a force-push, or a shallow
    // clone. We cannot prove anything about this anchor either way.
    return { anchor, kind: "unknown-base" };
  }

  let changes = diffCache.get(anchor.commit);
  if (!changes) {
    changes = await changesSince(root, anchor.commit, head);
    diffCache.set(anchor.commit, changes);
  }

  const change = changes.get(anchor.path);
  if (!change) {
    // Absent from the diff usually means untouched — but confirm the path is
    // actually there at HEAD. An anchor resolving to nothing is broken no
    // matter what the range says, and silently calling that "verified" would
    // be the worst possible failure for this pass.
    if (!(await pathExistsAt(root, head, anchor.path))) {
      return { anchor, kind: "deleted" };
    }
    return { anchor, kind: "untouched" };
  }

  if (change.kind === "added") {
    // The path did not exist at the anchor's own commit, so the anchor never
    // described anything there. Nothing can be proven against it either way.
    return { anchor, kind: "missing-at-base", change };
  }

  if (change.kind === "renamed" && change.renamedTo !== undefined) {
    return { anchor, kind: "renamed", renamedTo: change.renamedTo, change };
  }

  if (change.kind === "deleted") {
    // A file renamed and then deleted shows up here as a plain deletion, so
    // ask `log --follow` before declaring the memory dead.
    const followed = await followRename(root, anchor.commit, anchor.path, head);
    if (followed !== null) {
      return { anchor, kind: "renamed", renamedTo: followed, change };
    }
    return { anchor, kind: "deleted", change };
  }

  return { anchor, kind: "modified", change };
}

/**
 * THE VERIFY PASS.
 *
 * For each memory, diff every anchor's commit against HEAD:
 *
 *   untouched  → re-verify for free
 *   modified   → one targeted re-check
 *   renamed    → follow the file, then re-check
 *   deleted    → invalidated; the thing it describes is gone
 *
 * Diffs are cached per distinct anchor commit, so a hundred memories sharing
 * a baseline cost one `git diff`.
 */
export async function verifyPass(
  root: string,
  store: MemoryStore,
  options: VerifyOptions = {}
): Promise<VerifyReport> {
  const dryRun = options.dryRun ?? false;
  const rechecker = options.rechecker ?? new ConservativeRechecker();
  const head = await headSha(root);

  const { memories } = await store.readAll();
  const diffCache = new Map<string, Map<string, PathChange>>();
  const changed: MemoryVerdict[] = [];
  const unchanged: MemoryVerdict[] = [];
  const byStatus: Record<MemoryStatus, number> = {
    unverified: 0,
    verified: 0,
    stale: 0,
    invalidated: 0,
  };

  for (const memory of memories) {
    const verdict = await verifyMemory(
      root,
      memory,
      head,
      diffCache,
      rechecker
    );
    byStatus[verdict.to] += 1;

    // A memory that was already verified and still is must STILL be written:
    // its anchors advance to HEAD, and that is what makes the next pass cheap.
    // Bucketing on status alone would silently skip the advance.
    if (!dryRun && mutates(verdict, head)) {
      await applyVerdict(store, memory, verdict, head);
    }

    if (verdict.to === verdict.from) unchanged.push(verdict);
    else changed.push(verdict);
  }

  return {
    head,
    checked: memories.length,
    changed,
    unchanged,
    byStatus,
    dryRun,
  };
}

/** Whether this verdict would actually change anything on disk. */
function mutates(verdict: MemoryVerdict, head: string): boolean {
  if (verdict.to !== verdict.from) return true;
  if (needsAnchorRewrite(verdict)) return true;
  return (
    verdict.to === "verified" &&
    verdict.outcomes.some((o) => o.anchor.commit !== head)
  );
}

function needsAnchorRewrite(verdict: MemoryVerdict): boolean {
  return verdict.outcomes.some((o) => o.kind === "renamed");
}

async function verifyMemory(
  root: string,
  memory: StoredMemory,
  head: string,
  diffCache: Map<string, Map<string, PathChange>>,
  rechecker: AnchorRechecker
): Promise<MemoryVerdict> {
  const frontmatter = memory.memfile.frontmatter;
  const from = frontmatter.status;

  // Cross-repo anchors need the workspace resolver and the member's own
  // checkout — that machinery is v0.2 step 3. Until it lands, a memory
  // carrying one is left EXACTLY as it is and says why: verifying only its
  // local anchors would report partial coverage as a full verdict, which is
  // the lie-by-aggregation this pass exists to prevent.
  if (frontmatter.anchors.some((a) => a.kind === "xgit")) {
    return {
      id: frontmatter.id,
      file: memory.file,
      from,
      to: from,
      outcomes: [],
      rechecked: false,
      reason:
        "carries a cross-repo (xgit) anchor, which this pass cannot check yet — workspace verification lands in v0.2",
    };
  }

  const outcomes: AnchorOutcome[] = [];
  for (const anchor of frontmatter.anchors) {
    outcomes.push(await classifyAnchor(root, anchor, head, diffCache));
  }

  const base = { id: frontmatter.id, file: memory.file, from, outcomes };

  const deleted = outcomes.filter((o) => o.kind === "deleted");
  if (deleted.length > 0) {
    return {
      ...base,
      to: "invalidated",
      rechecked: false,
      reason: `anchored file deleted: ${deleted
        .map((o) => o.anchor.path)
        .join(", ")}`,
    };
  }

  const touched = outcomes.filter(
    (o) => o.kind === "modified" || o.kind === "renamed"
  );

  if (touched.length > 0) {
    const result = await rechecker.recheck({
      memory: frontmatter,
      body: memory.memfile.body,
      touched: touched.map(
        (o) => ({ anchor: o.anchor, change: o.change } as TouchedAnchor)
      ),
    });
    return {
      ...base,
      to: result.verdict,
      rechecked: true,
      reason: result.reason,
    };
  }

  const missing = outcomes.filter((o) => o.kind === "missing-at-base");
  if (missing.length > 0) {
    return {
      ...base,
      to: "unverified",
      rechecked: false,
      reason: `anchored path did not exist at its own commit (${missing
        .map((o) => o.anchor.path)
        .join(", ")}) — the anchor never described anything there`,
    };
  }

  const unknown = outcomes.filter((o) => o.kind === "unknown-base");
  if (unknown.length > 0) {
    return {
      ...base,
      to: worst(
        "unverified",
        from === "invalidated" ? "invalidated" : "unverified"
      ),
      rechecked: false,
      reason: `anchor commit not in this repository (${unknown
        .map((o) => o.anchor.commit.slice(0, 7))
        .join(
          ", "
        )}) — history rewritten or shallow clone, so nothing can be proven`,
    };
  }

  // Every anchor is untouched. That earns a free re-verify — but ONLY if the
  // memory was not already failing. "Nothing changed since the last check"
  // means nothing when the last check came back stale: absence of new change
  // cannot retroactively confirm a claim that was never confirmed. Restoring
  // a stale memory takes a real re-check.
  if (from === "stale" || from === "invalidated") {
    return {
      ...base,
      to: from,
      rechecked: false,
      reason: `anchors untouched, but a ${from} memory is only restored by a re-check, not by the absence of further change`,
    };
  }

  return {
    ...base,
    to: "verified",
    rechecked: false,
    reason: "all anchored paths untouched since the last verified commit",
  };
}

/**
 * Persist a verdict.
 *
 * Anchor commits advance to HEAD only when the memory actually verified, so
 * `commit` keeps meaning "the SHA this was last proven against". Renamed
 * paths are rewritten regardless, because leaving an anchor pointing at a
 * path that no longer exists is strictly worse than a stale one that resolves.
 */
async function applyVerdict(
  store: MemoryStore,
  memory: StoredMemory,
  verdict: MemoryVerdict,
  head: string
): Promise<void> {
  const frontmatter = memory.memfile.frontmatter;
  const now = `${new Date().toISOString().slice(0, 19)}Z`;
  const verified = verdict.to === "verified";

  const anchors = frontmatter.anchors.map((anchor, i) => {
    const outcome = verdict.outcomes[i];
    const path =
      outcome?.kind === "renamed" && outcome.renamedTo !== undefined
        ? outcome.renamedTo
        : anchor.path;
    return { ...anchor, path, commit: verified ? head : anchor.commit };
  });

  await store.write(
    {
      ...frontmatter,
      status: verdict.to,
      anchors,
      ...(verified ? { verified: now } : {}),
    },
    memory.memfile.body
  );
}
