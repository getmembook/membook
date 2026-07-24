import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeMemoryId, type MemoryInput } from "@membook/spec";
import { Membook } from "./membook.js";

export const COMMIT = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";

export async function tempRepo(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "membook-test-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export interface SeedSpec {
  body: string;
  type?: MemoryInput["type"];
  status?: MemoryInput["status"];
  paths?: string[];
}

export function memoryFor(spec: SeedSpec): {
  frontmatter: MemoryInput;
  body: string;
} {
  return {
    body: spec.body,
    frontmatter: {
      memfile: 1,
      id: computeMemoryId(spec.body),
      type: spec.type ?? "gotcha",
      status: spec.status ?? "unverified",
      scope: "repo",
      confidence: 0.9,
      created: "2026-07-21T16:42:00Z",
      ...(spec.status && spec.status !== "unverified"
        ? { verified: "2026-07-24T08:00:00Z" }
        : {}),
      anchors: (spec.paths ?? ["src/auth.ts"]).map((path) => ({
        path,
        commit: COMMIT,
      })),
      provenance: {
        origin: "authored",
        author: "agent",
        session: "sess-test",
        agent: "claude-code",
        model: "claude-opus-4-8",
      },
    },
  };
}

export const CORPUS: SeedSpec[] = [
  {
    body: "Load better-sqlite3 after setting PRAGMA journal_mode WAL, or concurrent sessions deadlock.",
    type: "gotcha",
    paths: ["packages/core/src/index-db.ts"],
  },
  {
    body: "Store the SQLite index under .membook/index and treat it as a disposable cache.",
    type: "decision",
    status: "verified",
    paths: ["packages/core/src/index-db.ts", ".gitignore"],
  },
  {
    body: "Validate every Memfile on read and on write, quarantining malformed files.",
    type: "convention",
    status: "verified",
    paths: ["packages/spec/src/serialize.ts"],
  },
  {
    body: "Do not use isomorphic-git for rename detection; log --follow has no equivalent.",
    type: "deadend",
    status: "stale",
    paths: ["packages/core/src/git-log.ts"],
  },
  {
    body: "Retrieval joins anchors against changed paths for path proximity ranking.",
    type: "map",
    paths: ["packages/core/src/search.ts"],
  },
];

export async function seeded(root: string): Promise<Membook> {
  const membook = new Membook(root);
  // One batch, one index open: dozens of open/WAL/close cycles per test are
  // what pushed the Windows CI runners past the test timeout.
  await membook.rememberMany(CORPUS.map(memoryFor));
  return membook;
}
