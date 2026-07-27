import type { Anchor, AnchoredMemory } from "@membook/spec";
import type { PathChange } from "./git.js";

/** An anchor whose file changed, with what git says happened to it. */
export interface TouchedAnchor {
  anchor: Anchor;
  change: PathChange;
}

export interface RecheckRequest {
  /** Only anchored memories are ever re-checked: a check needs an anchor. */
  memory: AnchoredMemory;
  body: string;
  touched: TouchedAnchor[];
}

/** A recheck can only ever confirm, demote, or kill a memory. */
export type RecheckVerdict = "verified" | "stale" | "invalidated";

export interface RecheckResult {
  verdict: RecheckVerdict;
  /** Why — surfaced in reports so a verdict is never unexplained. */
  reason: string;
}

/**
 * THE RE-CHECK SEAM.
 *
 * When an anchor's file has changed, something must decide whether the memory
 * is still true. That is a single targeted LLM call (build step 6). This port
 * exists now, on the real path, so the model provider drops in without
 * touching the verify pass.
 */
export interface AnchorRechecker {
  readonly name: string;
  recheck(request: RecheckRequest): RecheckResult | Promise<RecheckResult>;
}

/**
 * The default until step 6: never confirms anything.
 *
 * A changed file means the memory is unproven, and the honest report for
 * "nothing has actually checked this" is `stale` — not `verified`. Defaulting
 * the other way would silently mark memories true because no checker was
 * configured, which is precisely the failure this project exists to prevent.
 */
export class ConservativeRechecker implements AnchorRechecker {
  readonly name = "conservative";

  recheck(request: RecheckRequest): RecheckResult {
    const paths = request.touched.map((t) => t.anchor.path).join(", ");
    return {
      verdict: "stale",
      reason: `anchored code changed (${paths}) and no re-checker is configured to confirm the memory still holds`,
    };
  }
}
