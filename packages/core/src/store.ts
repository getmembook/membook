import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  idFromFilename,
  memoryFilename,
  parseMemfile,
  resolveMemoryId,
  safeParseMemfile,
  serializeMemfile,
  type Memfile,
  type MemoryInput,
} from "@membook/spec";
import type { RepoPaths } from "./paths.js";
import { MemoryNotFoundError, WriteBlockedError, type QuarantineRecord } from "./errors.js";
import { NoopWriteGuard, runGuards, type WriteGuard } from "./guard.js";

export interface StoredMemory {
  id: string;
  file: string;
  path: string;
  memfile: Memfile;
  /** The exact bytes on disk. */
  text: string;
}

export interface ReadAllResult {
  memories: StoredMemory[];
  quarantined: QuarantineRecord[];
}

export interface MemoryStoreOptions {
  guards?: readonly WriteGuard[];
}

/**
 * File CRUD over `.membook/memories/`.
 *
 * Files are the truth. This layer never consults the index, so it remains
 * correct even when the index is missing, stale, or mid-rebuild.
 */
export class MemoryStore {
  readonly paths: RepoPaths;
  private readonly guards: readonly WriteGuard[];

  constructor(paths: RepoPaths, options: MemoryStoreOptions = {}) {
    this.paths = paths;
    this.guards = options.guards ?? [new NoopWriteGuard()];
  }

  /**
   * Memory filenames, lexicographically sorted.
   *
   * Sorted because rebuild determinism depends on stable iteration order:
   * readdir order is filesystem-dependent, and an index built in a different
   * order is a different index.
   */
  async listFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.paths.memories);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries.filter((f) => idFromFilename(f) !== null).sort();
  }

  async listIds(): Promise<string[]> {
    return (await this.listFiles()).map((f) => idFromFilename(f)!);
  }

  async has(id: string): Promise<boolean> {
    return (await this.listIds()).includes(id);
  }

  async read(id: string): Promise<StoredMemory> {
    const file = memoryFilename(id);
    const path = join(this.paths.memories, file);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MemoryNotFoundError(id);
      }
      throw error;
    }
    return { id, file, path, text, memfile: parseMemfile(text, file) };
  }

  /**
   * Read every memory. Malformed files are quarantined and reported, never
   * silently skipped and never allowed to abort the walk — one corrupt file
   * must not cost the rebuild of two hundred good ones.
   */
  async readAll(): Promise<ReadAllResult> {
    const memories: StoredMemory[] = [];
    const quarantined: QuarantineRecord[] = [];

    for (const file of await this.listFiles()) {
      const path = join(this.paths.memories, file);
      const text = await readFile(path, "utf8");
      const parsed = safeParseMemfile(text, file);
      if (!parsed.ok) {
        quarantined.push({
          file,
          issues: parsed.error.issues,
          quarantined_at: `${new Date().toISOString().slice(0, 19)}Z`,
        });
        continue;
      }
      memories.push({ id: idFromFilename(file)!, file, path, text, memfile: parsed.memfile });
    }

    await this.recordQuarantine(quarantined);
    return { memories, quarantined };
  }

  /**
   * Quarantine writes a REPORT, and leaves the offending file where it is.
   *
   * Moving the file would be the more literal reading of "quarantine", but
   * `.membook/quarantine/` is gitignored: moving a committed memory there
   * deletes it from the working tree, and the next commit makes that
   * permanent. A malformed memory is a file to repair, not to destroy.
   */
  private async recordQuarantine(records: QuarantineRecord[]): Promise<void> {
    await rm(this.paths.quarantine, { recursive: true, force: true });
    if (records.length === 0) return;
    await mkdir(this.paths.quarantine, { recursive: true });
    for (const record of records) {
      await writeFile(
        join(this.paths.quarantine, `${record.file}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8",
      );
    }
  }

  /**
   * Allocate an id for new content, honouring the spec's collision ladder.
   */
  async allocateId(body: string, ownedBy?: string): Promise<string> {
    const taken = new Set(await this.listIds());
    if (ownedBy !== undefined) taken.delete(ownedBy);
    return resolveMemoryId(body, (id) => taken.has(id));
  }

  /**
   * Serialize, guard, and write a memory.
   *
   * Validation happens inside `serializeMemfile`, against the WIRE schema —
   * the reader's tolerance for YAML-coerced Dates never applies here, so a
   * Date cannot reach disk through this path.
   */
  async write(frontmatter: MemoryInput, body: string): Promise<StoredMemory> {
    const file = memoryFilename(frontmatter.id);
    const text = serializeMemfile(frontmatter, body, file);
    const memfile = parseMemfile(text, file);

    const blocked = await runGuards(this.guards, {
      frontmatter: memfile.frontmatter,
      body: memfile.body,
      text,
      file,
    });
    if (blocked) throw new WriteBlockedError(blocked.guard, blocked.findings);

    await mkdir(this.paths.memories, { recursive: true });
    const path = join(this.paths.memories, file);
    await writeFile(path, text, "utf8");
    return { id: frontmatter.id, file, path, text, memfile };
  }

  async delete(id: string): Promise<void> {
    const path = join(this.paths.memories, memoryFilename(id));
    try {
      await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MemoryNotFoundError(id);
      }
      throw error;
    }
  }
}
