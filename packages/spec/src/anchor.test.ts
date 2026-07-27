import { describe, expect, it } from "vitest";
import { formatAnchor, parseAnchor } from "./anchor.js";
import { MemfileValidationError } from "./errors.js";
import type { Anchor } from "./schema.js";

const COMMIT = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";

const cases: Array<{ name: string; anchor: Anchor; text: string }> = [
  {
    name: "path only",
    anchor: { kind: "git", path: "packages/core/src/store.ts", commit: COMMIT },
    text: `git:packages/core/src/store.ts@${COMMIT}`,
  },
  {
    name: "path and symbol",
    anchor: {
      kind: "git",
      path: "src/auth.ts",
      symbol: "refreshToken",
      commit: COMMIT,
    },
    text: `git:src/auth.ts#refreshToken@${COMMIT}`,
  },
  {
    name: "path, symbol and line range",
    anchor: {
      kind: "git",
      path: "src/auth.ts",
      symbol: "refreshToken",
      line_range: [42, 60],
      commit: COMMIT,
    },
    text: `git:src/auth.ts#refreshToken:L42-60@${COMMIT}`,
  },
  {
    name: "path and line range",
    anchor: {
      kind: "git",
      path: "src/auth.ts",
      line_range: [42, 60],
      commit: COMMIT,
    },
    text: `git:src/auth.ts:L42-60@${COMMIT}`,
  },
  {
    name: "single-line range collapses",
    anchor: {
      kind: "git",
      path: "src/auth.ts",
      line_range: [42, 42],
      commit: COMMIT,
    },
    text: `git:src/auth.ts:L42@${COMMIT}`,
  },
  {
    name: "cross-repo anchor",
    anchor: {
      kind: "xgit",
      repo: "platform-gateway",
      path: "config/limits.yaml",
      commit: COMMIT,
    },
    text: `xgit:platform-gateway/config/limits.yaml@${COMMIT}`,
  },
  {
    name: "cross-repo anchor with symbol and range",
    anchor: {
      kind: "xgit",
      repo: "platform-gateway",
      path: "config/limits.yaml",
      symbol: "rateLimits",
      line_range: [3, 12],
      commit: COMMIT,
    },
    text: `xgit:platform-gateway/config/limits.yaml#rateLimits:L3-12@${COMMIT}`,
  },
];

describe("anchor grammar", () => {
  it.each(cases)("formats $name", ({ anchor, text }) => {
    expect(formatAnchor(anchor)).toBe(text);
  });

  it.each(cases)("parses $name", ({ anchor, text }) => {
    expect(parseAnchor(text)).toEqual(anchor);
  });

  it.each(cases)("round-trips $name", ({ text }) => {
    expect(formatAnchor(parseAnchor(text))).toBe(text);
  });

  it("parses a path containing an @ sign", () => {
    const anchor = parseAnchor(`git:packages/@scope/pkg/src/a.ts@${COMMIT}`);
    expect(anchor.path).toBe("packages/@scope/pkg/src/a.ts");
    expect(anchor.commit).toBe(COMMIT);
  });

  it("rejects a missing commit", () => {
    expect(() => parseAnchor("git:src/auth.ts")).toThrow(
      MemfileValidationError
    );
  });

  it("rejects a short commit", () => {
    expect(() => parseAnchor("git:src/auth.ts@9f1c2d3")).toThrow(
      MemfileValidationError
    );
  });

  it("rejects an unknown anchor kind", () => {
    expect(() => parseAnchor(`lockfile:pnpm-lock.yaml@${COMMIT}`)).toThrow(
      MemfileValidationError
    );
  });

  // Member names cannot contain `/`, so the first slash splits repo from
  // path unambiguously — an uppercase "member" must fail as a bad name, not
  // silently reparse as part of the path.
  it("rejects an xgit anchor whose repo is not a member name", () => {
    expect(() =>
      parseAnchor(`xgit:Gateway/config/limits.yaml@${COMMIT}`)
    ).toThrow(/member name/);
  });

  it("rejects an absolute path through the string grammar", () => {
    expect(() => parseAnchor(`git:/etc/passwd@${COMMIT}`)).toThrow(
      /repo-relative/
    );
  });
});
