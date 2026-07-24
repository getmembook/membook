import { createHash } from "node:crypto";

/**
 * Content-addressed short id: `m-` + leading hex of sha256(content).
 * Computed once at creation time from the distilled statement; it is NOT
 * re-derived on later edits (memories evolve via PR review or supersedes,
 * not by renaming files). Collision handling (extending `length`) is the
 * store's responsibility.
 */
export const MEMORY_ID_LENGTH_LADDER = [4, 8, 12] as const;

export function computeMemoryId(content: string, length = 4): string {
  if (length < 4 || length > 12) {
    throw new RangeError("memory id hex length must be between 4 and 12");
  }
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return `m-${digest.slice(0, length)}`;
}

/**
 * COLLISION RULE — specified, not incidental.
 *
 * 4 hex chars is 16 bits, which is a small space once a repo holds hundreds
 * of memories, so collisions are expected rather than hypothetical. On
 * collision the id extends 4 → 8 → 12 characters. Because a longer id is a
 * prefix-extension of a shorter one, the ladder is deterministic: the same
 * content in the same store always resolves to the same id.
 *
 * `isTaken` must report whether the id belongs to a DIFFERENT memory —
 * re-resolving an existing memory's own id returns it unchanged.
 */
export function resolveMemoryId(
  content: string,
  isTaken: (id: string) => boolean,
): string {
  for (const length of MEMORY_ID_LENGTH_LADDER) {
    const id = computeMemoryId(content, length);
    if (!isTaken(id)) return id;
  }
  throw new Error(
    `unable to allocate a memory id: sha256 collision at ${
      MEMORY_ID_LENGTH_LADDER[MEMORY_ID_LENGTH_LADDER.length - 1]
    } hex characters`,
  );
}

/** Filename for a memory id, e.g. `m-4f2a.mem.md`. */
export function memoryFilename(id: string): string {
  return `${id}.mem.md`;
}

/** Extract the memory id from a `*.mem.md` filename, or null. */
export function idFromFilename(filename: string): string | null {
  const match = /^(m-[0-9a-f]{4,12})\.mem\.md$/.exec(filename);
  return match?.[1] ?? null;
}
