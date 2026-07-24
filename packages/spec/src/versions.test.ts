import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseMemfile, safeParseMemfile } from "./serialize.js";
import { MEMFILE_SPEC_VERSION } from "./schema.js";
import {
  MEMFILE_SCHEMAS,
  SUPPORTED_MEMFILE_VERSIONS,
  UnsupportedMemfileVersionError,
  readDeclaredVersion,
  schemaForVersion,
} from "./versions.js";

const EXAMPLES = join(import.meta.dirname, "../examples");

const v1 = (overrides = "") => `---
memfile: 1
id: m-1234
type: gotcha
status: unverified
scope: repo
confidence: 0.9
created: "2026-07-24T12:00:00Z"
anchors:
  - kind: git
    path: src/auth.ts
    commit: ${"a".repeat(40)}
provenance:
  origin: authored
  author: human
${overrides}---

A durable claim about the auth module.
`;

/**
 * THE PROMISE EXTERNAL IMPLEMENTERS RELY ON.
 *
 * `memfile` is a `z.literal`, so bumping it to 2 would make our own v2 reader
 * reject every v1 file in existence — quarantining every memory in every
 * repository on upgrade. The blast radius of a one-character change is the
 * entire installed base, which is why this machinery exists before anything
 * forces it.
 */
describe("read tolerance", () => {
  it("parses a v1 file", () => {
    const memfile = parseMemfile(v1());
    expect(memfile.frontmatter.memfile).toBe(1);
  });

  it("parses every golden example", async () => {
    const files = (await readdir(EXAMPLES)).filter((f) =>
      f.endsWith(".mem.md")
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const source = await readFile(join(EXAMPLES, f), "utf8");
      expect(() => parseMemfile(source, f)).not.toThrow();
    }
  });

  it("knows every version it can read", () => {
    expect(SUPPORTED_MEMFILE_VERSIONS).toContain(MEMFILE_SPEC_VERSION);
    expect(MEMFILE_SCHEMAS.map((s) => s.version)).toEqual(
      SUPPORTED_MEMFILE_VERSIONS
    );
  });

  // Registry entries describe files that already exist in the world. Editing
  // one retroactively invalidates memories in repositories we will never see,
  // so versions may only be appended.
  it("keeps the registry ordered oldest-first", () => {
    const versions = MEMFILE_SCHEMAS.map((s) => s.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });
});

/**
 * "This file is broken, repair it" and "your tool is old, upgrade it" are
 * opposite instructions. Reporting the second as the first sends someone to
 * hand-edit a file that is perfectly valid — which is how a forward-compatible
 * format earns a reputation for corrupting data.
 */
describe("a file from the future", () => {
  const future = v1().replace(
    "memfile: 1",
    `memfile: ${MEMFILE_SPEC_VERSION + 1}`
  );

  it("is refused with a version error, not a validation error", () => {
    expect(() => parseMemfile(future, "m-1234.mem.md")).toThrow(
      UnsupportedMemfileVersionError
    );
  });

  it("says the tool is old, not that the file is damaged", () => {
    try {
      parseMemfile(future);
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/newer Membook/i);
      expect(message).toMatch(/upgrade/i);
      expect(message).toMatch(/must not be edited by hand/i);
    }
  });

  it("reports which version it found and which it supports", () => {
    try {
      parseMemfile(future);
      expect.unreachable("should have thrown");
    } catch (error) {
      const e = error as UnsupportedMemfileVersionError;
      expect(e.found).toBe(MEMFILE_SPEC_VERSION + 1);
      expect(e.supported).toBe(MEMFILE_SPEC_VERSION);
    }
  });

  /**
   * A future file must NOT be quarantined as malformed by a bulk read: it is
   * not damaged, and quarantining it would present an upgrade problem as data
   * corruption. It propagates so the caller can report it as what it is.
   */
  it("is not swallowed by the non-throwing parse", () => {
    expect(() => safeParseMemfile(future)).toThrow(
      UnsupportedMemfileVersionError
    );
  });
});

describe("version dispatch", () => {
  it("reads the declared version out of raw frontmatter", () => {
    expect(readDeclaredVersion({ memfile: 1 })).toBe(1);
    expect(readDeclaredVersion({ memfile: 7 })).toBe(7);
  });

  // Absent or non-numeric is a MALFORMED file, not a version problem — the
  // caller reports it through validation so the message stays accurate.
  it("returns null when there is no usable version", () => {
    expect(readDeclaredVersion({})).toBeNull();
    expect(readDeclaredVersion({ memfile: "1" })).toBeNull();
    expect(readDeclaredVersion({ memfile: 1.5 })).toBeNull();
    expect(readDeclaredVersion(null)).toBeNull();
    expect(readDeclaredVersion("not an object")).toBeNull();
  });

  it("resolves a known version to its schema", () => {
    expect(schemaForVersion(1).version).toBe(1);
  });

  it("throws the version error for anything newer", () => {
    expect(() => schemaForVersion(MEMFILE_SPEC_VERSION + 1)).toThrow(
      UnsupportedMemfileVersionError
    );
  });

  it("still validates a file that declares a known version badly", () => {
    const broken = v1().replace("type: gotcha", "type: hunch");
    expect(() => parseMemfile(broken)).toThrow(/type/);
  });
});
