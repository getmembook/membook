/**
 * Regenerates the golden example Memfiles under examples/.
 * Run with: pnpm --filter @membook/spec generate:examples
 *
 * Examples are generated (never hand-edited) so they are canonical by
 * construction — the round-trip test then guards them as a fixed point.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeMemfile } from "../src/serialize.js";
import { computeMemoryId, memoryFilename } from "../src/id.js";
import type { MemoryInput } from "../src/schema.js";

const EXAMPLES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "examples"
);

const COMMIT_A = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const COMMIT_B = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const SOURCE_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

interface Example {
  body: string;
  frontmatter: Omit<MemoryInput, "id">;
}

const examples: Example[] = [
  {
    body: [
      "Store SQLite index under `.membook/index/` and treat it as disposable cache.",
      "",
      "Canonical memory state is the markdown files in `.membook/memories/`; the index",
      "is rebuilt bit-perfect by `membook reindex`, so it is gitignored and may be",
      "deleted at any time without data loss.",
    ].join("\n"),
    frontmatter: {
      memfile: 2,
      type: "decision",
      status: "verified",
      scope: "repo",
      confidence: 0.95,
      created: "2026-07-20T09:14:00Z",
      verified: "2026-07-24T08:00:00Z",
      anchors: [
        { path: "packages/core/src/index/sqlite.ts", commit: COMMIT_A },
        { path: ".gitignore", commit: COMMIT_A },
      ],
      provenance: {
        origin: "distilled",
        session: "sess-01H8X2K9",
        agent: "claude-code",
        model: "claude-opus-4-8",
        source_hash: SOURCE_HASH,
      },
    },
  },
  {
    body: [
      "`better-sqlite3` must be loaded after the process sets `PRAGMA journal_mode=WAL`,",
      "or concurrent MCP sessions on the same repo deadlock on first write.",
      "",
      "Symptom is a silent hang in `recall`, not an error — the second stdio server",
      "blocks forever acquiring the write lock.",
    ].join("\n"),
    frontmatter: {
      memfile: 2,
      type: "gotcha",
      status: "verified",
      scope: "repo",
      confidence: 0.9,
      created: "2026-07-21T16:42:00Z",
      verified: "2026-07-24T08:00:00Z",
      anchors: [
        {
          path: "packages/core/src/index/sqlite.ts",
          symbol: "openIndex",
          line_range: [18, 46],
          commit: COMMIT_A,
        },
      ],
      provenance: {
        origin: "distilled",
        session: "sess-01H8X4M2",
        agent: "claude-code",
        model: "claude-opus-4-8",
        source_hash: SOURCE_HASH,
      },
    },
  },
  {
    body: [
      "Validate every Memfile with the `@membook/spec` schema on read AND on write.",
      "",
      "A malformed memory is quarantined to `.membook/quarantine/` and reported by",
      "`membook status` — never silently skipped.",
    ].join("\n"),
    frontmatter: {
      memfile: 2,
      type: "convention",
      status: "verified",
      scope: "repo",
      confidence: 1,
      created: "2026-07-19T11:05:00Z",
      verified: "2026-07-24T08:00:00Z",
      anchors: [
        { path: "packages/spec/src/serialize.ts", commit: COMMIT_A },
        { path: "packages/core/src/store/read.ts", commit: COMMIT_A },
      ],
      // A person typing `membook remember` at a terminal: no digest artifact
      // to hash, and no agent or model, so all three are forbidden. Written
      // outside any session, so `session` is absent too.
      provenance: {
        origin: "authored",
        author: "human",
      },
    },
  },
  {
    body: [
      "Verification entry point is `verifyPass()` in `packages/core/src/verify/pass.ts`.",
      "",
      "It fans out: `git diff --name-status <anchor.commit>..HEAD` per distinct commit,",
      "intersects changed paths with anchor paths, and routes untouched anchors to a",
      "free re-verify and touched anchors to a single targeted LLM re-check.",
    ].join("\n"),
    frontmatter: {
      memfile: 2,
      type: "map",
      status: "verified",
      scope: "repo",
      confidence: 0.85,
      created: "2026-07-22T13:30:00Z",
      verified: "2026-07-24T08:00:00Z",
      anchors: [
        {
          path: "packages/core/src/verify/pass.ts",
          symbol: "verifyPass",
          commit: COMMIT_A,
        },
        { path: "packages/core/src/git/diff.ts", commit: COMMIT_A },
      ],
      provenance: {
        origin: "distilled",
        session: "sess-01H8XB4T",
        agent: "claude-code",
        model: "claude-opus-4-8",
        source_hash: SOURCE_HASH,
      },
    },
  },
  {
    body: [
      "Do not use `isomorphic-git` for rename detection — `log --follow` has no equivalent.",
      "",
      "Rename tracking is required for the stale-vs-invalidated distinction, and the",
      "pure-JS implementation cannot reproduce git's similarity heuristics. Shell out",
      "to the plain `git` CLI via execa instead.",
    ].join("\n"),
    frontmatter: {
      memfile: 2,
      type: "deadend",
      // Stale, and never verified: written, then the anchored code changed
      // before anything checked it. No `verified` timestamp exists, because
      // no verification ever happened — absence is the honest record.
      status: "stale",
      scope: "repo",
      confidence: 0.8,
      created: "2026-07-18T15:20:00Z",
      anchors: [{ path: "packages/core/src/git/log.ts", commit: COMMIT_B }],
      // An agent writing directly rather than distilling: it knows what it
      // is, so `agent` and `model` are required and truthfully filled.
      provenance: {
        origin: "authored",
        author: "agent",
        session: "sess-01H8V2C1",
        agent: "claude-code",
        model: "claude-opus-4-8",
      },
    },
  },
  {
    body: [
      "The gateway's rate-limit config is the contract this service consumes:",
      "`config/limits.yaml` in `platform-gateway` defines the per-tenant buckets.",
      "",
      "Anchored cross-repo so a limits change flips this stale in the consumer",
      "BEFORE an agent writes code against the old shape (contract-watch).",
    ].join("\n"),
    frontmatter: {
      memfile: 2,
      type: "map",
      status: "unverified",
      scope: "repo",
      confidence: 0.85,
      created: "2026-07-25T10:12:00Z",
      // An xgit anchor pins into ANOTHER repository, by workspace member
      // name; `commit` is the last-verified SHA in THAT repo's history. A
      // local git anchor alongside it records where the consumption lives.
      anchors: [
        {
          kind: "xgit",
          repo: "platform-gateway",
          path: "config/limits.yaml",
          commit: COMMIT_B,
        },
        { path: "src/clients/gateway.ts", commit: COMMIT_A },
      ],
      provenance: {
        origin: "authored",
        author: "agent",
        session: "sess-01H8ZQ7F",
        agent: "claude-code",
        model: "claude-opus-4-8",
      },
    },
  },
  {
    body: [
      "Prefer explicit return types on exported functions; inference is fine",
      "inside module bodies.",
    ].join("\n"),
    // A user-scope memory is testimony about the human, not a claim about
    // the world: no anchors (forbidden, not optional), and no status or
    // verified fields — a check can never be pending against it.
    frontmatter: {
      memfile: 2,
      type: "convention",
      scope: "user",
      confidence: 0.9,
      created: "2026-07-26T09:00:00Z",
      provenance: {
        origin: "authored",
        author: "human",
      },
    },
  },
];

mkdirSync(EXAMPLES_DIR, { recursive: true });

for (const example of examples) {
  const id = computeMemoryId(example.body);
  const text = serializeMemfile({ ...example.frontmatter, id }, example.body);
  const filename = memoryFilename(id);
  writeFileSync(join(EXAMPLES_DIR, filename), text, "utf8");
  console.log(`${example.frontmatter.type.padEnd(10)} → examples/${filename}`);
}
