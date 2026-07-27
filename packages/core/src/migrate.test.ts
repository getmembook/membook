import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMFILE_SPEC_VERSION } from "@membook/spec";
import { Membook } from "./membook.js";
import { seeded, tempRepo } from "./test-helpers.js";
import type { MembookEvent } from "./instrumentation.js";

let root: string;
let cleanup: () => Promise<void>;
let membook: Membook;

const memoriesDir = () => join(root, ".membook", "memories");

async function storeBytes(): Promise<Map<string, string>> {
  const bytes = new Map<string, string>();
  for (const file of await readdir(memoriesDir())) {
    bytes.set(file, await readFile(join(memoriesDir(), file), "utf8"));
  }
  return bytes;
}

/**
 * Un-quote the created timestamp: still a valid Memfile — the reader
 * tolerates the YAML date coercion — but no longer the canonical bytes,
 * which is exactly the drift a hand edit introduces.
 */
async function driftFile(file: string): Promise<void> {
  const path = join(memoriesDir(), file);
  const text = await readFile(path, "utf8");
  const drifted = text.replace(/created: "([^"]+)"/, "created: $1");
  expect(drifted).not.toBe(text);
  await writeFile(path, drifted, "utf8");
}

beforeEach(async () => {
  ({ root, cleanup } = await tempRepo());
  membook = await seeded(root);
});

afterEach(async () => {
  await cleanup();
});

describe("migrate", () => {
  it("leaves a canonical store untouched, byte for byte", async () => {
    const before = await storeBytes();
    const report = await membook.migrate();
    expect(report.rewritten).toEqual([]);
    expect(report.examined).toBe(5);
    expect(report.alreadyCanonical).toBe(5);
    expect(await storeBytes()).toEqual(before);
  });

  it("rewrites a hand-drifted file back to canonical form", async () => {
    const canonical = await storeBytes();
    const [file] = [...canonical.keys()];
    await driftFile(file!);

    const report = await membook.migrate();
    expect(report.rewritten).toHaveLength(1);
    expect(report.rewritten[0]).toMatchObject({
      file,
      from: MEMFILE_SPEC_VERSION,
      to: MEMFILE_SPEC_VERSION,
      reason: "non-canonical",
    });
    // The rewrite restores the exact canonical bytes, so migration converges:
    // a second pass finds nothing left to do.
    expect(await storeBytes()).toEqual(canonical);
    expect((await membook.migrate()).rewritten).toEqual([]);
  });

  it("reports under --dry-run and writes nothing", async () => {
    const canonical = await storeBytes();
    const [file] = [...canonical.keys()];
    await driftFile(file!);
    const drifted = await storeBytes();

    const report = await membook.migrate({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.rewritten).toHaveLength(1);
    expect(await storeBytes()).toEqual(drifted);
  });

  it("skips a file from the future and leaves it exactly where it is", async () => {
    const future = [
      "---",
      `memfile: ${MEMFILE_SPEC_VERSION + 1}`,
      "id: m-ffff",
      "---",
      "",
      "Written by a newer Membook than this one.",
      "",
    ].join("\n");
    await writeFile(join(memoriesDir(), "m-ffff.mem.md"), future, "utf8");

    const report = await membook.migrate();
    expect(report.needsNewerMembook).toEqual([
      {
        file: "m-ffff.mem.md",
        found: MEMFILE_SPEC_VERSION + 1,
        supported: MEMFILE_SPEC_VERSION,
      },
    ]);
    expect(report.examined).toBe(5);
    expect(await readFile(join(memoriesDir(), "m-ffff.mem.md"), "utf8")).toBe(
      future
    );
  });

  // The case the machinery was built for, exercisable at last: a file
  // written by the released v0.1, brought forward in one reviewable rewrite.
  it("migrates a real v1 file to the current version", async () => {
    const v1 = [
      "---",
      "memfile: 1",
      "id: m-0001",
      "type: gotcha",
      "status: unverified",
      "scope: repo",
      "confidence: 0.9",
      'created: "2026-07-20T09:00:00Z"',
      "anchors:",
      "  - kind: git",
      "    path: src/auth.ts",
      `    commit: ${"a".repeat(40)}`,
      "provenance:",
      "  origin: authored",
      "  author: human",
      "---",
      "",
      "A claim recorded by the released v0.1.",
      "",
    ].join("\n");
    await writeFile(join(memoriesDir(), "m-0001.mem.md"), v1, "utf8");

    const before = await membook.status();
    expect(before.byVersion).toEqual({ 1: 1, 2: 5 });
    expect(before.belowCurrent).toBe(1);

    const report = await membook.migrate();
    expect(report.rewritten).toEqual([
      {
        id: "m-0001",
        file: "m-0001.mem.md",
        from: 1,
        to: 2,
        reason: "older-version",
      },
    ]);

    const rewritten = await readFile(
      join(memoriesDir(), "m-0001.mem.md"),
      "utf8"
    );
    expect(rewritten).toContain("memfile: 2");
    expect(rewritten).not.toContain("memfile: 1");
    // Only the version moved — the claim, anchors and provenance survive.
    expect(rewritten).toContain("A claim recorded by the released v0.1.");
    expect(rewritten).toContain("path: src/auth.ts");

    const after = await membook.status();
    expect(after.byVersion).toEqual({ 2: 6 });
    expect(after.belowCurrent).toBe(0);
    expect((await membook.migrate()).rewritten).toEqual([]);
  });

  it("reports a malformed file and leaves it in place", async () => {
    const broken = "---\nmemfile: 2\nid: m-dead\n---\n\nMissing everything.\n";
    await writeFile(join(memoriesDir(), "m-dead.mem.md"), broken, "utf8");

    const report = await membook.migrate();
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]!.file).toBe("m-dead.mem.md");
    expect(report.rewritten).toEqual([]);
    expect(await readFile(join(memoriesDir(), "m-dead.mem.md"), "utf8")).toBe(
      broken
    );
  });

  it("records the pass, and the index follows the files", async () => {
    const events: MembookEvent[] = [];
    const instrumented = new Membook(root, {
      instrumentation: { record: (e) => void events.push(e) },
    });

    const [file] = await readdir(memoriesDir());
    await driftFile(file!);
    // A deleted index must come back on its own: migrate writes through the
    // store, which is file-only, so the pass reindexes when anything changed.
    await rm(join(root, ".membook", "index"), { recursive: true, force: true });

    await instrumented.migrate();
    expect(events).toEqual([
      { event: "migrate", examined: 5, rewritten: 1, to: MEMFILE_SPEC_VERSION },
    ]);

    const status = await instrumented.status();
    expect(status.indexed).toBe(status.onDisk);
    expect(status.byVersion).toEqual({ [MEMFILE_SPEC_VERSION]: 5 });
    expect(status.belowCurrent).toBe(0);
  });
});
