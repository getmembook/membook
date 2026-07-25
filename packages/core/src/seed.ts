import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { execa } from "execa";
import type { MemoryInput } from "@membook/spec";
import type { ModelProvider } from "./provider.js";
import type { Instrumentation } from "./instrumentation.js";
import { NullInstrumentation } from "./instrumentation.js";
import { pathExistsAt, headSha } from "./git.js";
import {
  distill,
  sourceHash,
  type DistillCandidate,
  type DistillRejection,
} from "./distill.js";

/**
 * THE COLD-START FIX.
 *
 * A fresh `membook init` writes an empty `MEMBOOK.md`, so the tool is worth
 * nothing on day one and must be carried by an agent choosing to record
 * something. Measured twice on a real repository, that choice is not made.
 *
 * But the memories are usually already written — in `CLAUDE.md`, in ADRs, in
 * design docs — as prose nobody reads at the moment it would help. Seeding
 * turns that prose into anchored, checkable memories, which means the book is
 * useful before any agent has cooperated even once.
 *
 * It also produces the labels the product cannot otherwise get: every seeded
 * memory is `unverified` and goes to a human in `membook review`, and those
 * ratify/delete decisions are the only ground truth against which re-check
 * accuracy can ever be measured.
 */

/**
 * The model-facing prompt, mirroring `prompts/seed.md`.
 *
 * Inlined so the package carries no runtime file dependency, but the markdown
 * is the reviewed source of truth and a test asserts the two are identical
 * character for character. Without that test, "versioned and reviewed like
 * code" would be a claim about a file nothing actually reads.
 */
export const SEED_SYSTEM = `You extract durable project memories from a documentation file.

A memory is a specific, non-obvious claim about THIS project that would save a
future engineer real time. Five kinds, and nothing else qualifies:

- **decision** — a choice that was made, and the reason for it
- **gotcha** — a trap that is not visible from reading the code
- **convention** — a rule this project follows that an outsider would not guess
- **map** — where a particular responsibility actually lives
- **deadend** — an approach already tried that did not work, and why

REJECTION IS THE DEFAULT. Most documentation contains no memories at all.
Returning an empty list is a correct and common answer, and is much better
than returning something weak. Do not try to find something. Do not summarise
the document.

Do NOT emit:

- anything a competent engineer would assume by default
- restatements of what the code plainly says
- aspirational or unimplemented plans, roadmap items, or TODOs
- generic best practice that is not specific to this project
- setup instructions that are already in a README and will be read anyway
- anything whose truth you cannot tie to a specific file

Each memory MUST cite the files it is about, in \`paths\`. Cite only paths you
have actually seen referenced in the content or the file's own path — a cited
path that does not exist in the repository causes the memory to be discarded,
because an anchor that cannot be checked is not a memory.

Write each \`statement\` as a claim, not a topic. Lead with what is true, then
why it matters. Imperative, terse, self-contained, at most two sentences. It
will be read cold, months from now, by someone with no other context.

Set \`confidence\` to how sure you are the claim is true and durable: 0.9 when
the document states it outright as a settled decision, 0.6 when you are
inferring it, below 0.5 not at all — omit it instead.

Never include credentials, tokens, connection strings, hostnames, or personal
data in a statement.

Reply with JSON only, in exactly this shape:

\`\`\`json
{
  "memories": [
    {
      "statement": "...",
      "type": "decision",
      "paths": ["docs/example.md"],
      "confidence": 0.8
    }
  ]
}
\`\`\`

If nothing in the file qualifies, reply \`{"memories": []}\`.`;

/** Files worth distilling, in the order they are most likely to pay off. */
const PREFERRED = [
  "CLAUDE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  "DEPLOYMENT.md",
  "README.md",
];

/**
 * Directories whose markdown is usually decisions rather than prose.
 * `adr` and `decisions` first: an ADR is a memory that has not been anchored.
 */
const DOC_DIRS = ["docs", "doc", "adr", "adrs", "decisions", "rfcs"];

/**
 * Skipped even when they match. These are dense, long, and almost entirely
 * chronology — distilling them produces confident claims about things that
 * were true once, which is the exact failure the product exists to prevent.
 */
const EXCLUDED = /(^|\/)(CHANGELOG|HISTORY|LICENSE|NOTICE|SECURITY)\.md$/i;

/** Below this, a file is a stub with nothing to say. */
export const MIN_SOURCE_CHARS = 400;

/**
 * Above this, a file is truncated rather than skipped.
 *
 * Truncation is honest here: the top of a design document is where its
 * decisions live, and the tail is usually appendices. Skipping outright would
 * silently drop the most valuable file in most repositories.
 */
export const MAX_SOURCE_CHARS = 24_000;

export const DEFAULT_MAX_FILES = 12;

export interface SeedSourceFile {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * Choose what to distill, using git's file list rather than the filesystem.
 *
 * Tracked files only, deliberately: an untracked file cannot be anchored to a
 * commit, and `node_modules` and build output are excluded for free by the
 * same rule rather than by a blocklist that would need endless maintenance.
 */
export async function findSeedSources(
  root: string,
  options: { maxFiles?: number } = {}
): Promise<SeedSourceFile[]> {
  const { stdout } = await execa(
    "git",
    ["ls-files", "-z", "*.md", "*.markdown"],
    {
      cwd: root,
    }
  );
  const tracked = stdout.split("\0").filter((p) => p !== "");

  const rank = (path: string): number => {
    const preferred = PREFERRED.indexOf(path);
    if (preferred !== -1) return preferred;
    const top = path.split("/")[0] ?? "";
    if (DOC_DIRS.includes(top.toLowerCase())) return PREFERRED.length;
    // Root-level markdown that is not a known name: PRDs, specs, plans.
    if (!path.includes("/")) return PREFERRED.length + 1;
    return PREFERRED.length + 2;
  };

  const eligible = tracked
    .filter((p) => !EXCLUDED.test(p))
    // Forward slash, NOT `path.sep`: `git ls-files` emits POSIX separators on
    // every platform, so matching on the native separator would silently stop
    // excluding anything on Windows — and Membook would seed memories from its
    // own memory files.
    .filter((p) => !p.startsWith(".membook/") && p !== "MEMBOOK.md")
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  const sources: SeedSourceFile[] = [];
  for (const path of eligible) {
    if (sources.length >= (options.maxFiles ?? DEFAULT_MAX_FILES)) break;
    let content: string;
    try {
      content = await readFile(join(root, path), "utf8");
    } catch {
      continue;
    }
    if (content.length < MIN_SOURCE_CHARS) continue;
    const truncated = content.length > MAX_SOURCE_CHARS;
    sources.push({
      path,
      content: truncated ? content.slice(0, MAX_SOURCE_CHARS) : content,
      truncated,
    });
  }
  return sources;
}

export interface SeedCandidate extends DistillCandidate {
  /** The file this was distilled from. */
  source: string;
  /** sha256 of exactly what the model read, for `provenance.source_hash`. */
  sourceHash: string;
}

export interface SeedReport {
  candidates: SeedCandidate[];
  rejected: DistillRejection[];
  /** Sources read, whether or not they yielded anything. */
  sourcesRead: string[];
  /** Sources whose distillation failed outright (provider down, unparseable). */
  sourcesFailed: string[];
}

export interface SeedOptions {
  provider: ModelProvider;
  system: string;
  instrumentation?: Instrumentation;
  existing?: readonly string[];
  maxFiles?: number;
  /** Progress, so a multi-minute run is not a silent hang. */
  onProgress?: (path: string, index: number, total: number) => void;
}

export async function seed(
  root: string,
  options: SeedOptions
): Promise<SeedReport> {
  const instrumentation = options.instrumentation ?? new NullInstrumentation();
  const head = await headSha(root);
  const sources = await findSeedSources(root, {
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
  });

  // Anchors are checked against HEAD, not the working tree: a memory anchored
  // to an uncommitted file can never be verified, so it must never be born.
  const pathExists = async (path: string): Promise<boolean> => {
    const normalised = path.replace(/^\.\//, "");
    // Reject escapes before they reach git, and keep anchors repo-relative.
    if (normalised.startsWith("/") || normalised.includes("..")) return false;
    const rel = relative(root, join(root, normalised));
    if (rel.startsWith("..")) return false;
    return pathExistsAt(root, head, normalised);
  };

  const candidates: SeedCandidate[] = [];
  const rejected: DistillRejection[] = [];
  const sourcesRead: string[] = [];
  const sourcesFailed: string[] = [];
  const existing = [...(options.existing ?? [])];

  for (const [index, source] of sources.entries()) {
    options.onProgress?.(source.path, index, sources.length);
    sourcesRead.push(source.path);

    const result = await distill(
      { path: source.path, content: source.content },
      options.system,
      {
        provider: options.provider,
        instrumentation,
        pathExists,
        existing,
      }
    );

    if (result.failed) {
      sourcesFailed.push(source.path);
      continue;
    }

    for (const candidate of result.candidates) {
      // The source file is always an anchor. The model cites what a claim is
      // *about*; the file it came from is where the claim was made, and if
      // that text is rewritten the memory deserves re-checking.
      const paths = candidate.paths.includes(source.path)
        ? candidate.paths
        : [source.path, ...candidate.paths];
      candidates.push({
        ...candidate,
        paths,
        source: source.path,
        sourceHash: result.sourceHash,
      });
      existing.push(candidate.statement);
    }
    rejected.push(...result.rejected);
  }

  return { candidates, rejected, sourcesRead, sourcesFailed };
}

/**
 * Build the frontmatter for a seeded memory.
 *
 * `origin: "distilled"` with a real `source_hash` — the sha256 of exactly the
 * text the model read. That makes the claim auditable: anyone can recompute it
 * and see precisely what this memory was derived from.
 *
 * Status is `unverified`, always. A model extracted it and nothing has checked
 * it, and claiming otherwise would launder a guess into a fact.
 */
export function seedFrontmatter(
  candidate: SeedCandidate,
  context: { id: string; commit: string; timestamp: string; model: string }
): MemoryInput {
  return {
    memfile: 1,
    id: context.id,
    type: candidate.type,
    status: "unverified",
    scope: "repo",
    confidence: candidate.confidence,
    created: context.timestamp,
    anchors: candidate.paths.map((path, i) => ({
      path,
      ...(candidate.symbol !== undefined && i === 0
        ? { symbol: candidate.symbol }
        : {}),
      commit: context.commit,
    })),
    provenance: {
      origin: "distilled",
      session: "seed",
      agent: "membook-seed",
      model: context.model,
      source_hash: candidate.sourceHash,
    },
  };
}

