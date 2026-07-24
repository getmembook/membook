import type { Memory } from "@membook/spec";
import type { WriteGuardFinding } from "./errors.js";

/** Everything a guard gets to see before a memory reaches disk. */
export interface WriteCandidate {
  /** Validated frontmatter. */
  frontmatter: Memory;
  /** The human statement. */
  body: string;
  /** The exact bytes that would be written, frontmatter included. */
  text: string;
  /** Target filename, e.g. `m-4f2a.mem.md`. */
  file: string;
}

/**
 * THE WRITE-PATH SEAM.
 *
 * Every write passes through the configured guards before anything touches
 * disk. A guard returning findings blocks the write entirely.
 *
 * This exists now, wired into the real call path, so the launch-blocking
 * secret scanner (build step 6) is an implementation swap rather than a
 * change to any caller. A leaked credential in a committed memory file is a
 * product-killing failure, and the seam it lands in should not be invented
 * under deadline pressure.
 */
export interface WriteGuard {
  readonly name: string;
  inspect(
    candidate: WriteCandidate,
  ): WriteGuardFinding[] | Promise<WriteGuardFinding[]>;
}

/**
 * The default guard until step 6: passes everything, and is honest about it.
 * Deliberately NOT named something that implies protection.
 */
export class NoopWriteGuard implements WriteGuard {
  readonly name = "noop";

  inspect(): WriteGuardFinding[] {
    return [];
  }
}

/** Runs guards in order; the first to report findings blocks the write. */
export async function runGuards(
  guards: readonly WriteGuard[],
  candidate: WriteCandidate,
): Promise<{ guard: string; findings: WriteGuardFinding[] } | null> {
  for (const guard of guards) {
    const findings = await guard.inspect(candidate);
    if (findings.length > 0) return { guard: guard.name, findings };
  }
  return null;
}
