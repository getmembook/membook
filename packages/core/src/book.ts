import { writeFile } from "node:fs/promises";
import type { Memory, MemoryStatus, MemoryType } from "@membook/spec";
import type { MemoryStore, StoredMemory } from "./store.js";
import type { RepoPaths } from "./paths.js";
import type { ResolvedWorkspace } from "./workspace.js";

/**
 * THE COMPILED BOOK.
 *
 * `MEMBOOK.md` at the repository root: what an agent should know before it
 * touches anything. It is emitted as a plain markdown file, at a conventional
 * path, so agents that have never heard of Membook still benefit — the same
 * zero-integration bargain AGENTS.md made.
 *
 * Selection differs from `recall` in kind, not degree. Recall has a query and
 * can gate on relevance to it. The book has no query, so nothing can gate on
 * relevance; ranking is prior expected value instead. That makes the CAP the
 * discipline: room is scarce, and every memory included pushes another out.
 */
export const BOOK = {
  /**
   * Hard cap. Not a target — the generator stops early rather than padding.
   *
   * The book is prepended to sessions, so it is paid for on every single one.
   * A budget that creeps costs more the more successful the tool becomes.
   */
  maxTokens: 2000,

  /**
   * Rough tokens-per-character. Deliberately pessimistic: overshooting the
   * budget is a real cost, undershooting is merely a smaller book.
   */
  charsPerToken: 3.6,

  /**
   * Prior value by status. These WEIGHT, they do not gate.
   *
   * A young book is honestly all-unverified — nothing has run a verify pass
   * yet — so gating on `verified` would emit an empty book for exactly the
   * repositories that most need one. Stale and invalidated are excluded
   * outright, because the book is asserted as fact with no chance to caveat.
   */
  statusWeight: {
    verified: 1,
    unverified: 0.7,
    stale: 0,
    invalidated: 0,
  } satisfies Record<MemoryStatus, number>,

  /**
   * Prior value by type, ordered by how badly an agent suffers not knowing.
   *
   * A gotcha prevents an actively wrong path; a map only saves searching.
   * Dead ends rank high for the same reason gotchas do — re-walking a known
   * dead end is the most expensive kind of ignorance.
   */
  typeWeight: {
    gotcha: 1,
    deadend: 0.95,
    decision: 0.85,
    convention: 0.8,
    map: 0.6,
  } satisfies Record<MemoryType, number>,

  /** Recency modulates; it never dominates. */
  recencyHalfLifeDays: 180,
  recencyBoost: 0.25,
} as const;

export interface BookEntry {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  body: string;
  anchors: string[];
  /** Expected value per token — the greedy selection key. */
  density: number;
  tokens: number;
}

export interface BookReport {
  /** The rendered file contents. */
  content: string;
  entries: BookEntry[];
  tokens: number;
  /** Eligible but did not fit under the cap. */
  omitted: number;
  /** Excluded by status: stale or invalidated. */
  excluded: number;
  /**
   * Excluded because a cross-repo anchor's member is not usable on this
   * machine (or no workspace was provided at all). Never folded into
   * `excluded`: "no longer trusted" and "not checkable here" are different
   * facts, and the header reports them as different sentences.
   */
  excludedUnresolvable: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / BOOK.charsPerToken);
}

function recencyFactor(memory: Memory, now: Date): number {
  const stamp = memory.verified ?? memory.created;
  const then = Date.parse(stamp);
  if (Number.isNaN(then)) return 0;
  const ageDays = Math.max(0, (now.getTime() - then) / 86_400_000);
  return Math.pow(0.5, ageDays / BOOK.recencyHalfLifeDays);
}

/** Expected value of carrying this memory, before its cost is considered. */
export function expectedValue(memory: Memory, now: Date): number {
  const status = BOOK.statusWeight[memory.status];
  if (status === 0) return 0;
  const type = BOOK.typeWeight[memory.type];
  const recency = recencyFactor(memory, now);
  return status * type * memory.confidence * (1 + recency * BOOK.recencyBoost);
}

function renderEntry(entry: BookEntry): string {
  const head = `### ${entry.type}${
    entry.status === "unverified" ? " (unverified)" : ""
  }`;
  return `${head}\n\n${entry.body}\n\n\`${entry.anchors.join("`, `")}\``;
}

/**
 * The header.
 *
 * Written for a reader with no idea what Membook is: a coding agent that
 * found this file by convention, or a human opening it in a diff. It has to
 * say what the file is, that editing it is pointless, how to change it, and —
 * most importantly — how much to trust it. Overstating that would poison the
 * context it exists to improve.
 */
/** Wrap to a fixed width, so interpolated counts cannot produce ragged lines. */
function wrap(text: string, width = 78): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

const pick = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

function header(generated: {
  count: number;
  omitted: number;
  excluded: number;
  excludedUnresolvable: number;
}): string {
  const { count, omitted, excluded, excludedUnresolvable } = generated;

  // "Omitted for space" and "withheld because it drifted" are different facts
  // and must never be blurred into one count. A reader told "the 1 best of 4"
  // concludes the other three were less useful, when in truth they were
  // withheld as no longer trustworthy — the opposite lesson.
  const sentences: string[] = [
    omitted === 0
      ? `It carries ${
          count === 1
            ? "the one eligible memory"
            : `all ${count} eligible memories`
        }.`
      : `It carries the ${count} highest-value of ${
          count + omitted
        } eligible memories.`,
  ];
  if (excluded > 0) {
    sentences.push(
      `${excluded} further ${pick(
        excluded,
        "memory is",
        "memories are"
      )} withheld because the code ${pick(
        excluded,
        "it describes has",
        "they describe has"
      )} changed since ${pick(excluded, "it was", "they were")} last checked.`
    );
  }
  if (excludedUnresolvable > 0) {
    sentences.push(
      `${excludedUnresolvable} further ${pick(
        excludedUnresolvable,
        "memory",
        "memories"
      )} could not be checked on this machine because the ${pick(
        excludedUnresolvable,
        "repository it describes is",
        "repositories they describe are"
      )} not present.`
    );
  }
  sentences.push(
    "This file is generated, never edited by hand — corrections belong in `.membook/memories/`."
  );

  return [
    "<!-- Generated by Membook. Do not edit: regenerate with `membook book`. -->",
    "",
    "# Project memory",
    "",
    "Durable, project-specific knowledge for anyone — human or agent — working in",
    "this repository: decisions and why they were made, traps that are not obvious",
    "from the code, and paths already known to be dead ends.",
    "",
    "Every memory is anchored to specific files. Anything whose anchored code has",
    "changed since it was last checked is withheld from this file rather than",
    "asserted.",
    "",
    ...wrap(sentences.join(" ")),
    "",
    "Entries marked `(unverified)` have not been checked against current code yet.",
    "Treat them as informed leads rather than established fact.",
  ].join("\n");
}

/**
 * Compile the book: greedy by expected-value-per-token under a hard cap.
 *
 * Greedy on density is the right shape here — it is the classic knapsack
 * heuristic, and the alternative (exact optimisation) would make the output
 * unstable under small edits, which matters more than the last few tokens of
 * packing efficiency.
 */
export async function compileBook(
  store: MemoryStore,
  options: { now?: Date; workspace?: ResolvedWorkspace } = {}
): Promise<BookReport> {
  const now = options.now ?? new Date();
  const { memories } = await store.readAll();

  const usableMembers = new Set(
    (options.workspace?.members ?? [])
      .filter((m) => m.state === "resolved")
      .map((m) => m.name)
  );
  /**
   * The book is asserted as fact with no chance to caveat, so a memory whose
   * cross-repo anchor this machine cannot resolve is withheld the way stale
   * is — and counted separately, because "not trusted" and "not checkable
   * here" teach the reader opposite lessons.
   */
  const isUnresolvableHere = (fm: Memory): boolean =>
    fm.anchors.some((a) => a.kind === "xgit" && !usableMembers.has(a.repo));

  let excluded = 0;
  let excludedUnresolvable = 0;
  const candidates: BookEntry[] = [];

  for (const memory of memories) {
    const fm = memory.memfile.frontmatter;
    if (isUnresolvableHere(fm)) {
      excludedUnresolvable += 1;
      continue;
    }
    const value = expectedValue(fm, now);
    if (value === 0) {
      excluded += 1;
      continue;
    }
    const entry: BookEntry = {
      id: fm.id,
      type: fm.type,
      status: fm.status,
      body: memory.memfile.body,
      anchors: fm.anchors.map((a) =>
        a.symbol ? `${a.path}#${a.symbol}` : a.path
      ),
      density: 0,
      tokens: 0,
    };
    entry.tokens = estimateTokens(renderEntry(entry));
    entry.density = value / Math.max(1, entry.tokens);
    candidates.push(entry);
  }

  // Stable ordering is a hard requirement, not a nicety: this file is
  // committed, and it is prepended to prompts. Unstable order means noisy PR
  // diffs on a file nobody edited, and a prompt-cache miss every session.
  // Ties break by id, which is content-addressed and therefore stable.
  candidates.sort((a, b) => b.density - a.density || a.id.localeCompare(b.id));

  // Budget the header pessimistically: assume every candidate is carried, so
  // the reserved size cannot come out smaller than the header finally emitted.
  const headerTokens = estimateTokens(
    header({
      count: candidates.length,
      omitted: candidates.length,
      excluded,
      excludedUnresolvable,
    })
  );
  const selected: BookEntry[] = [];
  let used = headerTokens;
  let omitted = 0;

  for (const entry of candidates) {
    // Keep scanning rather than stopping at the first entry that does not
    // fit: a long memory must not shut out the short ones behind it.
    if (used + entry.tokens <= BOOK.maxTokens) {
      selected.push(entry);
      used += entry.tokens;
    } else {
      omitted += 1;
    }
  }

  const content =
    selected.length === 0
      ? `${header({
          count: 0,
          omitted,
          excluded,
          excludedUnresolvable,
        })}\n\nNo memories yet.\n`
      : `${header({
          count: selected.length,
          omitted,
          excluded,
          excludedUnresolvable,
        })}\n\n${selected.map(renderEntry).join("\n\n")}\n`;

  return {
    content,
    entries: selected,
    tokens: estimateTokens(content),
    omitted,
    excluded,
    excludedUnresolvable,
  };
}

/** Compile and write `MEMBOOK.md`. */
export async function writeBook(
  paths: RepoPaths,
  store: MemoryStore,
  options: { now?: Date; workspace?: ResolvedWorkspace } = {}
): Promise<BookReport> {
  const report = await compileBook(store, options);
  await writeFile(paths.book, report.content, "utf8");
  return report;
}
