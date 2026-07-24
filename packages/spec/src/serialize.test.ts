import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseMemfile,
  safeParseMemfile,
  serializeMemfile,
  serializeMemfileRecord,
} from "./serialize.js";
import { MemfileValidationError } from "./errors.js";
import type { MemoryInput } from "./schema.js";

const EXAMPLES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "examples",
);

const COMMIT = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const SOURCE_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function validMemory(overrides: Partial<MemoryInput> = {}): MemoryInput {
  return {
    memfile: 1,
    id: "m-4f2a",
    type: "gotcha",
    status: "verified",
    scope: "repo",
    confidence: 0.9,
    created: "2026-07-21T16:42:00Z",
    verified: "2026-07-24T08:00:00Z",
    anchors: [{ path: "src/auth.ts", commit: COMMIT }],
    provenance: {
      origin: "distilled",
      session: "sess-1",
      agent: "claude-code",
      model: "claude-opus-4-8",
      source_hash: SOURCE_HASH,
    },
    ...overrides,
  };
}

describe("golden examples", () => {
  const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".mem.md"));

  it("ships at least one example per memory type", () => {
    const types = files.map(
      (f) => parseMemfile(readFileSync(join(EXAMPLES_DIR, f), "utf8"), f).frontmatter.type,
    );
    expect(new Set(types)).toEqual(
      new Set(["decision", "gotcha", "convention", "map", "deadend"]),
    );
  });

  it("ships a golden fixture for both provenance origins", () => {
    const origins = files.map(
      (f) =>
        parseMemfile(readFileSync(join(EXAMPLES_DIR, f), "utf8"), f).frontmatter
          .provenance.origin,
    );
    expect(new Set(origins)).toEqual(new Set(["distilled", "authored"]));
  });

  it.each(files)("%s filename matches its id", (file) => {
    const { frontmatter } = parseMemfile(
      readFileSync(join(EXAMPLES_DIR, file), "utf8"),
      file,
    );
    expect(file).toBe(`${frontmatter.id}.mem.md`);
  });
});

/**
 * INVARIANT — the standard's load-bearing guarantee.
 *
 * Serialization is a fixed point: parsing a canonical Memfile and
 * re-serializing it reproduces the source BYTE FOR BYTE, and the frontmatter
 * survives the round trip unchanged. Memories live in git and are reviewed in
 * pull requests, so any drift here shows up as phantom diffs on files nobody
 * edited. This must hold for every golden file, forever.
 */
describe("INVARIANT: byte-exact round-trip", () => {
  const files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith(".mem.md"));

  it.each(files)("serialize(parse(%s)) is byte-identical", (file) => {
    const source = readFileSync(join(EXAMPLES_DIR, file), "utf8");
    expect(serializeMemfileRecord(parseMemfile(source, file), file)).toBe(source);
  });

  it.each(files)("parse(serialize(parse(%s))) is unchanged", (file) => {
    const source = readFileSync(join(EXAMPLES_DIR, file), "utf8");
    const once = parseMemfile(source, file);
    const twice = parseMemfile(serializeMemfileRecord(once, file), file);
    expect(twice).toEqual(once);
  });

  it("holds for a memory built in memory, not just for files on disk", () => {
    const text = serializeMemfile(validMemory(), "A statement.");
    expect(serializeMemfileRecord(parseMemfile(text), text ? undefined : "")).toBe(
      text,
    );
  });
});

describe("serialization determinism", () => {
  it("emits a stable key order regardless of input key order", () => {
    const body = "Some durable, project-specific thing.";
    const forward = serializeMemfile(validMemory(), body);
    const shuffled = serializeMemfile(
      {
        provenance: validMemory().provenance,
        anchors: validMemory().anchors,
        verified: "2026-07-24T08:00:00Z",
        created: "2026-07-21T16:42:00Z",
        confidence: 0.9,
        scope: "repo",
        status: "verified",
        type: "gotcha",
        id: "m-4f2a",
        memfile: 1,
      },
      body,
    );
    expect(shuffled).toBe(forward);
    expect(forward.indexOf("memfile:")).toBeLessThan(forward.indexOf("id:"));
  });

  it("defaults and emits the anchor kind discriminator", () => {
    const text = serializeMemfile(validMemory(), "A statement.");
    expect(text).toContain("kind: git");
  });

  it("emits line ranges in flow style", () => {
    const text = serializeMemfile(
      validMemory({
        anchors: [{ path: "src/auth.ts", line_range: [42, 60], commit: COMMIT }],
      }),
      "A statement.",
    );
    expect(text).toContain("line_range: [42, 60]");
  });

  it("emits kind as the first key of every anchor", () => {
    const text = serializeMemfile(
      validMemory({
        anchors: [
          { path: "src/auth.ts", symbol: "refreshToken", commit: COMMIT },
          { path: "src/db.ts", commit: COMMIT },
        ],
      }),
      "A statement.",
    );
    for (const anchor of text.matchAll(/^ {2}- (\w+):/gm)) {
      expect(anchor[1]).toBe("kind");
    }
  });

  it("emits origin as the first key of the provenance block", () => {
    const text = serializeMemfile(validMemory(), "A statement.");
    const provenance = text.slice(text.indexOf("provenance:"));
    expect(provenance.split("\n")[1]?.trim()).toBe("origin: distilled");
  });

  it("quotes timestamps so YAML 1.1 cannot coerce them to dates", () => {
    const text = serializeMemfile(validMemory(), "A statement.");
    expect(text).toContain('created: "2026-07-21T16:42:00Z"');
    expect(text).toContain('verified: "2026-07-24T08:00:00Z"');
  });

  it("normalizes a local offset to canonical UTC", () => {
    // The same instant, written in Kochi, must serialize identically.
    const kochi = serializeMemfile(
      validMemory({ created: "2026-07-21T22:12:00+05:30" }),
      "A statement.",
    );
    const london = serializeMemfile(
      validMemory({ created: "2026-07-21T16:42:00Z" }),
      "A statement.",
    );
    expect(kochi).toBe(london);
    expect(kochi).toContain('created: "2026-07-21T16:42:00Z"');
  });

  it("truncates sub-second precision to canonical second precision", () => {
    const text = serializeMemfile(
      validMemory({ created: "2026-07-21T16:42:00.987Z" }),
      "A statement.",
    );
    expect(text).toContain('created: "2026-07-21T16:42:00Z"');
  });

  it("normalizes body whitespace to a single trailing newline", () => {
    const text = serializeMemfile(validMemory(), "\n\n  A statement.  \n\n\n");
    expect(text.endsWith("A statement.\n")).toBe(true);
  });
});

describe("loud failure", () => {
  it("rejects a body-less memory on write", () => {
    expect(() => serializeMemfile(validMemory(), "   ")).toThrow(
      MemfileValidationError,
    );
  });

  it("rejects a Date timestamp on write, keeping the tolerance one-directional", () => {
    const withDate = { ...validMemory(), created: new Date() } as unknown as MemoryInput;
    expect(() => serializeMemfile(withDate, "A statement.")).toThrow(
      MemfileValidationError,
    );
  });

  // The presence of a source_hash must MEAN something: a nameable artifact
  // stands behind it. A plausible-looking junk hash on a hand-authored memory
  // is worse for an auditor than no hash at all, so it cannot validate.
  it("rejects authored provenance carrying a source_hash", () => {
    expect(() =>
      serializeMemfile(
        validMemory({
          provenance: {
            origin: "authored",
            session: "sess-1",
            agent: "claude-code",
            model: "claude-opus-4-8",
            source_hash: SOURCE_HASH,
          } as never,
        }),
        "A statement.",
      ),
    ).toThrow(MemfileValidationError);
  });

  it("rejects distilled provenance with no source_hash", () => {
    expect(() =>
      serializeMemfile(
        validMemory({
          provenance: {
            origin: "distilled",
            session: "sess-1",
            agent: "claude-code",
            model: "claude-opus-4-8",
          } as never,
        }),
        "A statement.",
      ),
    ).toThrow(MemfileValidationError);
  });

  it("rejects provenance with no origin discriminator", () => {
    expect(() =>
      serializeMemfile(
        validMemory({
          provenance: {
            session: "sess-1",
            agent: "claude-code",
            model: "claude-opus-4-8",
            source_hash: SOURCE_HASH,
          } as never,
        }),
        "A statement.",
      ),
    ).toThrow(MemfileValidationError);
  });

  it("accepts authored provenance with no source_hash", () => {
    expect(() =>
      serializeMemfile(
        validMemory({
          provenance: {
            origin: "authored",
            session: "sess-1",
            agent: "claude-code",
            model: "claude-opus-4-8",
          },
        }),
        "A statement.",
      ),
    ).not.toThrow();
  });

  it("rejects an anchorless memory on write", () => {
    expect(() => serializeMemfile(validMemory({ anchors: [] }), "A statement.")).toThrow(
      /at least one anchor/,
    );
  });

  it("rejects unknown frontmatter fields", () => {
    const memory = { ...validMemory(), rogue: "field" } as MemoryInput;
    expect(() => serializeMemfile(memory, "A statement.")).toThrow(
      MemfileValidationError,
    );
  });

  it("rejects a non-unverified memory with no verified timestamp", () => {
    const { verified: _omitted, ...rest } = validMemory();
    expect(() => serializeMemfile(rest as MemoryInput, "A statement.")).toThrow(
      /must carry a verified timestamp/,
    );
  });

  it("accepts an unverified memory with no verified timestamp", () => {
    const { verified: _omitted, ...rest } = validMemory({ status: "unverified" });
    expect(() => serializeMemfile(rest as MemoryInput, "A statement.")).not.toThrow();
  });

  it("rejects an absolute anchor path", () => {
    expect(() =>
      serializeMemfile(
        validMemory({ anchors: [{ path: "/etc/passwd", commit: COMMIT }] }),
        "A statement.",
      ),
    ).toThrow(/repo-relative/);
  });

  it("rejects a traversing anchor path", () => {
    expect(() =>
      serializeMemfile(
        validMemory({ anchors: [{ path: "../secrets.ts", commit: COMMIT }] }),
        "A statement.",
      ),
    ).toThrow(/\.\. segments|must not contain/);
  });

  it("rejects a short commit sha", () => {
    expect(() =>
      serializeMemfile(
        validMemory({ anchors: [{ path: "src/auth.ts", commit: "9f1c2d3" }] }),
        "A statement.",
      ),
    ).toThrow(/40-char/);
  });

  it("rejects an inverted line range", () => {
    expect(() =>
      serializeMemfile(
        validMemory({
          anchors: [{ path: "src/auth.ts", line_range: [60, 42], commit: COMMIT }],
        }),
        "A statement.",
      ),
    ).toThrow(/start must be <= end/);
  });

  it("reports the filename and every issue in the error message", () => {
    try {
      serializeMemfile(
        validMemory({ confidence: 5, type: "nonsense" as never }),
        "A statement.",
        "m-4f2a.mem.md",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MemfileValidationError);
      const err = error as MemfileValidationError;
      expect(err.message).toContain("m-4f2a.mem.md");
      expect(err.issues).toHaveLength(2);
    }
  });
});

describe("parsing", () => {
  it("rejects a file with no frontmatter", () => {
    expect(() => parseMemfile("Just a body.", "x.mem.md")).toThrow(
      /missing.*frontmatter/i,
    );
  });

  it("rejects unparseable YAML", () => {
    expect(() => parseMemfile("---\n  : : :\n---\nBody.", "x.mem.md")).toThrow(
      MemfileValidationError,
    );
  });

  it("rejects frontmatter with a body of only whitespace", () => {
    const text = serializeMemfile(validMemory(), "A statement.");
    const stripped = text.replace("A statement.", "   ");
    expect(() => parseMemfile(stripped, "x.mem.md")).toThrow(
      /human-readable statement/,
    );
  });

  it("safeParse reports rather than throws", () => {
    const result = safeParseMemfile("Just a body.", "x.mem.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MemfileValidationError);
      expect(result.error.file).toBe("x.mem.md");
    }
  });

  it("normalizes an unquoted YAML timestamp that js-yaml coerces to a Date", () => {
    const text = serializeMemfile(validMemory(), "A statement.");
    const unquoted = text.replace(
      'created: "2026-07-21T16:42:00Z"',
      "created: 2026-07-21T16:42:00Z",
    );
    const { frontmatter } = parseMemfile(unquoted, "x.mem.md");
    expect(frontmatter.created).toBe("2026-07-21T16:42:00Z");
    // ...and re-serializing restores the canonical quoted form.
    expect(serializeMemfileRecord({ frontmatter, body: "A statement." })).toBe(text);
  });

  it("safeParse succeeds on a valid memfile", () => {
    const text = serializeMemfile(validMemory(), "A statement.");
    const result = safeParseMemfile(text, "x.mem.md");
    expect(result.ok).toBe(true);
  });
});
