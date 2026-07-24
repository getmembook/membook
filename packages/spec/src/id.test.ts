import { describe, expect, it } from "vitest";
import { computeMemoryId, idFromFilename, memoryFilename } from "./id.js";
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
