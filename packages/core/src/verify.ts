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
import { WorkspaceContext } from "./verify-workspace-context.js";
import type { ResolvedWorkspace } from "./workspace.js";

export type AnchorOutcomeKind =
  | "untouched"
  | "modified"
  | "renamed"
  | "deleted"
  | "unknown-base"
  | "missing-at-base"
  /**
   * The third epistemic state (v0.2 §5): the anchor reaches into a workspace
   * member this machine cannot use — absent, identity refused, or no
   * manifest at all. NOT stale (nothing is known to have changed) and NOT
   * verified (nothing was checked), and never folded into either.
   */
  | "unresolvable";

export interface AnchorOutcome {
  anchor: Anchor;
  kind: AnchorOutcomeKind;
  /** New path, for renames. */
  renamedTo?: string;
  change?: PathChange;
  /** Workspace member the anchor resolves through. Only for xgit anchors. */
  member?: string;
  /**
   * The member checkout's HEAD at classification time — what this anchor
   * advances to when the memory verifies, in place of the local head. Only
   * for xgit anchors that resolved.
   */
  memberHead?: string;
  /** Why the member could not be used. Only for `unresolvable`. */
  reason?: string;
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
  /**
   * Resolved workspace, for xgit anchors. Without one, every cross-repo
   * anchor is honestly `unresolvable` — never an error, never a guess.
   */
  workspace?: ResolvedWorkspace;
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

/**
 * The pass was always a pure function of `(anchor, checkout)` — it diffs an
 * anchor's last-verified commit against HEAD in a working tree, and nothing
 * in it assumes that tree is the current repo. `cwd` and `head` are the
 * working-tree parameter that v0.2 hands it: for a git anchor the local
 * repo, for an xgit anchor the resolved member's checkout. Same diff, same
 * `log --follow`, same transitions.
 */
async function classifyAnchor(
  cwd: string,
  anchor: Anchor,
  head: string,
  diffCache: Map<string, Map<string, PathChange>>
): Promise<AnchorOutcome> {
  const member = anchor.kind === "xgit" ? { member: anchor.repo } : {};
  // Already at HEAD: there is nothing between the anchor and now to diff —
  // but the path still has to be there. An anchor to a path that does not
  // exist is broken even when its commit is current.
  if (anchor.commit === head) {
    return (await pathExistsAt(cwd, head, anchor.path))
      ? { anchor, kind: "untouched", ...member }
      : { anchor, kind: "deleted", ...member };
  }

  if (!(await commitExists(cwd, anchor.commit))) {
    // The baseline is gone — a rewritten history, a force-push, or a shallow
    // clone. We cannot prove anything about this anchor either way.
    return { anchor, kind: "unknown-base", ...member };
  }

  // Keyed by checkout as well as commit: two repositories can in principle
  // both contain a SHA, and a diff from the wrong tree is worse than none.
  const cacheKey = `${cwd}\0${anchor.commit}`;
  let changes = diffCache.get(cacheKey);
  if (!changes) {
    changes = await changesSince(cwd, anchor.commit, head);
    diffCache.set(cacheKey, changes);
  }

  const change = changes.get(anchor.path);
  if (!change) {
    // Absent from the diff usually means untouched — but confirm the path is
    // actually there at HEAD. An anchor resolving to nothing is broken no
    // matter what the range says, and silently calling that "verified" would
    // be the worst possible failure for this pass.
    if (!(await pathExistsAt(cwd, head, anchor.path))) {
      return { anchor, kind: "deleted", ...member };
    }
    return { anchor, kind: "untouched", ...member };
  }

  if (change.kind === "added") {
    // The path did not exist at the anchor's own commit, so the anchor never
    // described anything there. Nothing can be proven against it either way.
    return { anchor, kind: "missing-at-base", change, ...member };
  }

  if (change.kind === "renamed" && change.renamedTo !== undefined) {
    return {
      anchor,
      kind: "renamed",
      renamedTo: change.renamedTo,
      change,
      ...member,
    };
  }

  if (change.kind === "deleted") {
    // A file renamed and then deleted shows up here as a plain deletion, so
    // ask `log --follow` before declaring the memory dead.
    const followed = await followRename(cwd, anchor.commit, anchor.path, head);
    if (followed !== null) {
      return {
        anchor,
        kind: "renamed",
        renamedTo: followed,
        change,
        ...member,
      };
    }
    return { anchor, kind: "deleted", change, ...member };
  }

  return { anchor, kind: "modified", change, ...member };
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
  const workspace = new WorkspaceContext(options.workspace);

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
      rechecker,
      workspace
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
  // With an unresolvable anchor in play, only a real status DEMOTION may
  // touch the file — what the pass did see can still convict. The bookkeeping
  // writes (anchor advancement, rename rewrites on an unchanged status) are
  // withheld: the anchor commit means "last proven against", and a memory the
  // pass could not fully see had nothing proven about it. `verified` cannot
  // be the end state here — verifyMemory never emits it with an unresolvable
  // outcome present — so a status change is always a demotion.
  if (verdict.outcomes.some((o) => o.kind === "unresolvable")) {
    return verdict.to !== verdict.from;
  }
  if (verdict.to !== verdict.from) return true;
  if (needsAnchorRewrite(verdict)) return true;
  return (
    verdict.to === "verified" &&
    verdict.outcomes.some((o) => o.anchor.commit !== (o.memberHead ?? head))
  );
}

function needsAnchorRewrite(verdict: MemoryVerdict): boolean {
  return verdict.outcomes.some((o) => o.kind === "renamed");
}

/** "gone-from-gateway (nothing at /path); limits (identity refused)" */
function describeUnresolvable(unresolvable: AnchorOutcome[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const o of unresolvable) {
    const key = o.member ?? o.anchor.path;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(o.reason ?? `\`${key}\` could not be resolved`);
  }
  return parts.join("; ");
}

async function verifyMemory(
  root: string,
  memory: StoredMemory,
  head: string,
  diffCache: Map<string, Map<string, PathChange>>,
  rechecker: AnchorRechecker,
  workspace: WorkspaceContext
): Promise<MemoryVerdict> {
  const frontmatter = memory.memfile.frontmatter;
  const from = frontmatter.status;

  const outcomes: AnchorOutcome[] = [];
  for (const anchor of frontmatter.anchors) {
    if (anchor.kind === "xgit") {
      const member = await workspace.member(anchor.repo);
      if (!member.usable) {
        outcomes.push({
          anchor,
          kind: "unresolvable",
          member: anchor.repo,
          reason: member.reason,
        });
        continue;
      }
      const outcome = await classifyAnchor(
        member.path,
        anchor,
        member.head,
        diffCache
      );
      outcomes.push({ ...outcome, memberHead: member.head });
      continue;
    }
    outcomes.push(await classifyAnchor(root, anchor, head, diffCache));
  }

  const base = { id: frontmatter.id, file: memory.file, from, outcomes };
  const unresolvable = outcomes.filter((o) => o.kind === "unresolvable");

  // An unresolvable anchor blocks only the POSITIVE end state. What the pass
  // DID see can still convict — a deleted file is deleted whatever a distant
  // member might say — but nothing partial can confirm, so a verdict of
  // `verified` may never emerge from a memory it could not fully check.
  const deleted = outcomes.filter((o) => o.kind === "deleted");
  if (deleted.length > 0) {
    return {
      ...base,
      to: "invalidated",
      rechecked: false,
      reason: `anchored file deleted: ${deleted
        .map((o) => (o.member ? `${o.member}:${o.anchor.path}` : o.anchor.path))
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
    if (result.verdict === "verified" && unresolvable.length > 0) {
      return {
        ...base,
        to: from,
        rechecked: true,
        reason: `${result.reason} — but ${describeUnresolvable(
          unresolvable
        )}, so the memory cannot be confirmed on this machine`,
      };
    }
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

  // Everything checkable is untouched — but if anything was NOT checkable,
  // that is where it ends. Not stale: nothing is known to have changed. Not
  // verified: nothing was checked. The status stays put, the file stays
  // byte-identical, and the reason names the member so `status` can say
  // exactly which repository this machine is missing.
  if (unresolvable.length > 0) {
    return {
      ...base,
      to: from,
      rechecked: false,
      reason: `could not be checked on this machine: ${describeUnresolvable(
        unresolvable
      )}`,
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
    // A cross-repo anchor advances to ITS repository's HEAD — "last proven
    // against" is a claim about the member's history, not this one's.
    const provenAt = outcome?.memberHead ?? head;
    return { ...anchor, path, commit: verified ? provenAt : anchor.commit };
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
