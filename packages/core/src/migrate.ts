import {
  MEMFILE_SPEC_VERSION,
  serializeMemfile,
  type MemoryInput,
} from "@membook/spec";
import type { MemoryStore, ReadAllResult } from "./store.js";
import type { QuarantineRecord } from "./errors.js";

/**
 * THE MIGRATION IS A DIFF A HUMAN READS, NEVER A SIDE EFFECT.
 *
 * Files are the truth and they are committed, so a version migration must be
 * a reviewable change: `membook migrate` rewrites the store in one explicit
 * pass that lands as one commit, and nothing else ever rewrites a file merely
 * for having read it. Mixed-version stores are legal indefinitely — `status`
 * reports the spread, `migrate` closes it, and nobody is forced.
 *
 * The rewrite itself is almost nothing, by design: every supported version
 * parses by WIDENING into the current shape, so migrating a file is parse →
 * re-emit at the current version. There is no upgrade chain to maintain,
 * because the per-version schemas already are one.
 *
 * The same pass also restores canonical form to files a hand has drifted —
 * reordered keys, an offset timestamp, an unquoted date. Canonical
 * serialization is what keeps every FUTURE rewrite of a file a clean diff,
 * so closing formatting drift is the same promise as closing version drift,
 * kept by the same rewrite.
 *
 * What migrate cannot read, it does not touch: malformed files stay in place
 * and are reported, and a file from a newer Membook is skipped with its
 * version named — it needs a newer tool, not a rewrite by an older one.
 */

export interface MigrateEntry {
  id: string;
  file: string;
  /** The memfile version the file declared on disk. */
  from: number;
  to: number;
  /**
   * `older-version` when the file predates the current spec version;
   * `non-canonical` when the version is current but the bytes are not the
   * canonical serialization.
   */
  reason: "older-version" | "non-canonical";
}

export interface MigrateReport {
  /** Memories that parsed and were examined. */
  examined: number;
  alreadyCanonical: number;
  rewritten: MigrateEntry[];
  quarantined: QuarantineRecord[];
  needsNewerMembook: ReadAllResult["needsNewerMembook"];
  dryRun: boolean;
}

export interface MigrateOptions {
  /** Report what would be rewritten, write nothing. */
  dryRun?: boolean;
}

export async function migrateStore(
  store: MemoryStore,
  options: MigrateOptions = {}
): Promise<MigrateReport> {
  const dryRun = options.dryRun ?? false;
  const { memories, quarantined, needsNewerMembook } = await store.readAll();

  const rewritten: MigrateEntry[] = [];
  let alreadyCanonical = 0;

  for (const memory of memories) {
    const { frontmatter, body, version } = memory.memfile;
    const current: MemoryInput = {
      ...frontmatter,
      memfile: MEMFILE_SPEC_VERSION,
    };
    const canonical = serializeMemfile(current, body, memory.file);
    if (canonical === memory.text) {
      alreadyCanonical += 1;
      continue;
    }
    rewritten.push({
      id: memory.id,
      file: memory.file,
      from: version,
      to: MEMFILE_SPEC_VERSION,
      reason:
        version < MEMFILE_SPEC_VERSION ? "older-version" : "non-canonical",
    });
    if (!dryRun) await store.write(current, body);
  }

  return {
    examined: memories.length,
    alreadyCanonical,
    rewritten,
    quarantined,
    needsNewerMembook,
    dryRun,
  };
}
