/** A memory file that failed validation, kept out of the index but never lost. */
export interface QuarantineRecord {
  file: string;
  issues: string[];
  quarantined_at: string;
}

/**
 * Raised when the index on disk was built under different assumptions than
 * the running code — a different spec version, FTS5 tokenizer, or embedding
 * model. Never repair in place: mixing tokenizations or embedding spaces
 * produces an index that looks fine and retrieves badly.
 */
export class IndexMetadataMismatchError extends Error {
  readonly mismatches: Array<{ key: string; found: string; expected: string }>;

  constructor(mismatches: Array<{ key: string; found: string; expected: string }>) {
    super(
      [
        "Index metadata does not match this build:",
        ...mismatches.map(
          (m) => `  - ${m.key}: index has ${m.found}, code expects ${m.expected}`,
        ),
        "",
        "The index is a disposable cache. Rebuild it: membook reindex --force",
      ].join("\n"),
    );
    this.name = "IndexMetadataMismatchError";
    this.mismatches = mismatches;
  }
}

/** Raised when a write guard rejects content before it reaches disk. */
export class WriteBlockedError extends Error {
  readonly findings: WriteGuardFinding[];
  readonly guard: string;

  constructor(guard: string, findings: WriteGuardFinding[]) {
    super(
      [
        `Write blocked by ${guard}:`,
        ...findings.map((f) => `  - [${f.rule}] ${f.message}`),
        "",
        "Nothing was written.",
      ].join("\n"),
    );
    this.name = "WriteBlockedError";
    this.guard = guard;
    this.findings = findings;
  }
}

export interface WriteGuardFinding {
  rule: string;
  message: string;
}

/** Raised when a memory id is requested that the store does not hold. */
export class MemoryNotFoundError extends Error {
  readonly id: string;

  constructor(id: string) {
    super(`No memory with id ${id}`);
    this.name = "MemoryNotFoundError";
    this.id = id;
  }
}
