import { describe, expect, it } from "vitest";
import { memoryJsonSchema } from "./json-schema.js";
import { memorySchema, memoryWireSchema } from "./schema.js";

const COMMIT = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const SOURCE_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("JSON Schema export", () => {
  // memoryJsonSchema is evaluated at module load: if projection throws, every
  // import of @membook/spec fails. Zod cannot represent z.date(), which is why
  // the projection runs off the wire schema rather than the file schema.
  it("projects without throwing", () => {
    expect(typeof memoryJsonSchema).toBe("object");
    expect(memoryJsonSchema["type"]).toBe("object");
  });

  it("describes the required frontmatter fields", () => {
    expect(memoryJsonSchema["required"]).toEqual(
      expect.arrayContaining([
        "memfile",
        "id",
        "type",
        "status",
        "scope",
        "confidence",
        "created",
        "anchors",
        "provenance",
      ])
    );
  });

  it("does not require the optional fields", () => {
    const required = memoryJsonSchema["required"] as string[];
    expect(required).not.toContain("verified");
    expect(required).not.toContain("supersedes");
  });

  it("forbids unknown fields, matching the strict schema", () => {
    expect(memoryJsonSchema["additionalProperties"]).toBe(false);
  });

  it("types timestamps as strings, not dates", () => {
    const properties = memoryJsonSchema["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties["created"]?.["type"]).toBe("string");
  });
});

describe("wire schema", () => {
  const wireMemory = {
    memfile: 2 as const,
    id: "m-4f2a",
    type: "gotcha" as const,
    status: "verified" as const,
    scope: "repo" as const,
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
  };

  it("accepts string timestamps", () => {
    expect(memoryWireSchema.safeParse(wireMemory).success).toBe(true);
  });

  it("rejects Date timestamps that the file schema tolerates", () => {
    const withDate = {
      ...wireMemory,
      created: new Date("2026-07-21T16:42:00Z"),
    };
    expect(memoryWireSchema.safeParse(withDate).success).toBe(false);
    expect(memorySchema.safeParse(withDate).success).toBe(true);
  });

  it("normalizes a Date to a canonical second-precision timestamp", () => {
    const parsed = memorySchema.parse({
      ...wireMemory,
      created: new Date("2026-07-21T16:42:00Z"),
    });
    expect(parsed.created).toBe("2026-07-21T16:42:00Z");
  });

  it("enforces the same verified-timestamp rule as the file schema", () => {
    const { verified: _omitted, ...rest } = wireMemory;
    expect(memoryWireSchema.safeParse(rest).success).toBe(false);
  });
});
