import { createHash } from "node:crypto";

/**
 * Content-addressed short id: `m-` + leading hex of sha256(content).
 * Computed once at creation time from the distilled statement; it is NOT
 * re-derived on later edits (memories evolve via PR review or supersedes,
 * not by renaming files). Collision handling (extending `length`) is the
 * store's responsibility.
 */
export function computeMemoryId(content: string, length = 4): string {
  if (length < 4 || length > 12) {
    throw new RangeError("memory id hex length must be between 4 and 12");
  }
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return `m-${digest.slice(0, length)}`;
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
