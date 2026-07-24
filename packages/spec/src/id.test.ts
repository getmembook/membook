import { describe, expect, it } from "vitest";
import {
  MEMORY_ID_LENGTH_LADDER,
  computeMemoryId,
  idFromFilename,
  memoryFilename,
  resolveMemoryId,
} from "./id.js";
import { memoryIdSchema } from "./schema.js";

describe("memory ids", () => {
  it("is deterministic for identical content", () => {
    expect(computeMemoryId("a statement")).toBe(computeMemoryId("a statement"));
  });

  it("differs for different content", () => {
    expect(computeMemoryId("a statement")).not.toBe(computeMemoryId("b statement"));
  });

  it("produces ids the schema accepts", () => {
    for (const length of [4, 8, 12]) {
      const id = computeMemoryId("a statement", length);
      expect(memoryIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it("extends by prefix when lengthened, so collision handling stays stable", () => {
    const short = computeMemoryId("a statement", 4);
    const long = computeMemoryId("a statement", 8);
    expect(long.startsWith(short)).toBe(true);
  });

  it("rejects out-of-range lengths", () => {
    expect(() => computeMemoryId("x", 3)).toThrow(RangeError);
    expect(() => computeMemoryId("x", 13)).toThrow(RangeError);
  });

  it("round-trips through a filename", () => {
    const id = computeMemoryId("a statement");
    expect(idFromFilename(memoryFilename(id))).toBe(id);
  });

  it("returns null for a non-memfile filename", () => {
    expect(idFromFilename("README.md")).toBeNull();
    expect(idFromFilename("m-4f2a.md")).toBeNull();
    expect(idFromFilename("notes.mem.md")).toBeNull();
  });
});

describe("collision handling", () => {
  const content = "a statement";

  it("uses the short id when it is free", () => {
    expect(resolveMemoryId(content, () => false)).toBe(computeMemoryId(content, 4));
  });

  it("extends 4 → 8 on collision", () => {
    const taken = new Set([computeMemoryId(content, 4)]);
    expect(resolveMemoryId(content, (id) => taken.has(id))).toBe(
      computeMemoryId(content, 8),
    );
  });

  it("extends 8 → 12 when both shorter ids collide", () => {
    const taken = new Set([
      computeMemoryId(content, 4),
      computeMemoryId(content, 8),
    ]);
    expect(resolveMemoryId(content, (id) => taken.has(id))).toBe(
      computeMemoryId(content, 12),
    );
  });

  it("is deterministic: same content and same store give the same id", () => {
    const taken = new Set([computeMemoryId(content, 4)]);
    const isTaken = (id: string) => taken.has(id);
    expect(resolveMemoryId(content, isTaken)).toBe(resolveMemoryId(content, isTaken));
  });

  it("climbs the ladder in order, without skipping a rung", () => {
    const seen: number[] = [];
    // Everything is taken, so this exhausts the ladder and throws — but it
    // must have tried every rung, in order, on the way up.
    expect(() =>
      resolveMemoryId(content, (id) => {
        seen.push(id.length - "m-".length);
        return true;
      }),
    ).toThrow(/collision/);
    expect(seen).toEqual([...MEMORY_ID_LENGTH_LADDER]);
  });

  it("throws rather than looping forever when the ladder is exhausted", () => {
    expect(() => resolveMemoryId(content, () => true)).toThrow(/collision/);
  });

  it("produces schema-valid ids at every rung", () => {
    for (const length of MEMORY_ID_LENGTH_LADDER) {
      const id = computeMemoryId(content, length);
      expect(memoryIdSchema.safeParse(id).success).toBe(true);
      expect(idFromFilename(memoryFilename(id))).toBe(id);
    }
  });
});
