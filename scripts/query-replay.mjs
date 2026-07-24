/**
 * QUERY REPLAY — does retrieval hold up against real questions?
 *
 * `RANKING.pushFloor` decides what an unprompted hook injects into an agent's
 * context, and it was calibrated against eleven queries invented by the person
 * who wrote the scorer. Retrieval precision is the stated binding constraint of
 * the whole product, so tuning it on synthetic data is exactly the wrong place
 * to be guessing.
 *
 * Real prompts already exist: every Claude Code session on this machine is a
 * transcript of things a person actually asked while working. Replaying those
 * against a real memory store gives a hit-rate distribution grounded in the
 * shape of real questions rather than in the author's imagination of them.
 *
 * PRIVACY. Transcripts are the user's own sessions. Everything here runs
 * locally and nothing is transmitted. Prompt text is never printed in full —
 * only aggregates, and short redacted excerpts for spot-checking relevance,
 * which is the minimum needed to tell a good hit from a bad one.
 *
 * NEEDS NO MODEL. Recall is BM25 plus coverage; no API spend.
 *
 * Usage:
 *   node scripts/query-replay.mjs [repo] [--limit 2000]
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  Membook,
  RANKING,
  queryTerms,
  scanForSecrets,
} from "@membook/core";

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--")) ?? process.cwd();
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i === -1 ? 2000 : Number(args[i + 1]);
})();

/** Prompts shorter than this are conversational; the hook ignores them too. */
const MIN_CHARS = 12;

/**
 * Slash commands, pasted output, and tool noise are not questions.
 * Including them would inflate the "no hit" rate with things nobody expected
 * a memory to answer.
 */
function isRealQuestion(text) {
  if (text.length < MIN_CHARS) return false;
  if (text.startsWith("/")) return false;
  if (text.startsWith("<")) return false; // system-reminder and similar
  if (text.includes("[Request interrupted")) return false;
  if (text.length > 2000) return false; // pasted logs, not a question
  return true;
}

/**
 * ONE PROJECT'S OWN TRANSCRIPTS, NEVER THE WHOLE MACHINE.
 *
 * The first version of this walked every project directory under
 * ~/.claude/projects. That is both more of the user's data than the question
 * needs — other clients' sessions have no business being read to tune a
 * ranking constant — and worse measurement: memories here are about THIS
 * codebase, so prompts from an unrelated project score zero by construction
 * and would dilute the hit rate with questions nobody expected an answer to.
 *
 * The realistic scenario, and the only honest one, is a repo's own questions
 * against its own memories.
 */
function projectDir(repo) {
  // Claude Code encodes a project path by replacing separators with dashes.
  return repo.replace(/\//g, "-");
}

async function collectPrompts(limit, repo) {
  const root = join(homedir(), ".claude", "projects");
  const out = [];
  const dirs = [projectDir(repo)];

  for (const d of dirs) {
    let files = [];
    try {
      files = (await readdir(join(root, d))).filter((f) =>
        f.endsWith(".jsonl")
      );
    } catch {
      continue;
    }
    for (const f of files) {
      if (out.length >= limit) return out;
      let text;
      try {
        text = await readFile(join(root, d, f), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        if (out.length >= limit) return out;
        try {
          const j = JSON.parse(line);
          if (j.type !== "user") continue;
          const c = j.message?.content;
          const s =
            typeof c === "string"
              ? c
              : Array.isArray(c)
              ? c
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join(" ")
              : "";
          if (isRealQuestion(s.trim()))
            out.push({ project: d, text: s.trim() });
        } catch {
          // Malformed line: skip it, this is a measurement not a parser.
        }
      }
    }
  }
  return out;
}

/**
 * Short excerpt — enough to judge relevance, not to reproduce.
 *
 * Runs the product's own scanner first. The first run of this harness printed
 * a live npm token to the terminal, because real transcripts contain
 * credentials people pasted while working. `recall` already redacts queries
 * before they reach the telemetry log; a script that reads the same text owes
 * the same care.
 */
const excerpt = (s) => {
  const one = s.replace(/\s+/g, " ").trim();
  const clipped = one.length > 68 ? one.slice(0, 68) + "…" : one;
  return scanForSecrets(clipped).length > 0
    ? "[redacted — credential]"
    : clipped;
};

const prompts = await collectPrompts(LIMIT, repo);
if (prompts.length === 0) {
  console.error(`No transcripts for ${repo} under ~/.claude/projects.`);
  process.exit(1);
}

const membook = new Membook(repo);
const { onDisk } = await membook.status();

console.log(`\nquery replay`);
console.log(`  store:   ${repo} (${onDisk} memories)`);
console.log(`  prompts: ${prompts.length} real user turns\n`);

const scores = [];
let served = 0;
let abovePush = 0;
const pushHits = [];

/**
 * Simulate the HOOK, not bare recall.
 *
 * An earlier run reported "WHat is next" as an injection because it called
 * `recall` directly, while the hook additionally requires a minimum number of
 * content terms. Measuring a surface without its own gates measures something
 * nobody ships.
 */
const MIN_QUERY_TERMS = 3;
let gated = 0;

for (const p of prompts) {
  if (queryTerms(p.text).length < MIN_QUERY_TERMS) {
    gated += 1;
    scores.push(0);
    continue;
  }
  const { hits } = await membook.recall(p.text, {
    statuses: ["verified", "unverified"],
    limit: 3,
  });
  const top = hits[0]?.score ?? 0;
  scores.push(top);
  if (hits.length > 0) served += 1;
  if (top >= RANKING.pushFloor) {
    abovePush += 1;
    if (pushHits.length < 12) {
      pushHits.push({ q: p.text, score: top, body: hits[0].body });
    }
  }
}

const sorted = [...scores].sort((a, b) => a - b);
const pct = (p) => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
const rate = (n) => `${((n / prompts.length) * 100).toFixed(1)}%`;

console.log("─".repeat(70));
console.log(`too vague to query (< ${MIN_QUERY_TERMS} terms)   ${gated}  ${rate(gated)}`);
console.log(`any hit at all (relative floor)   ${served}  ${rate(served)}`);
console.log(
  `would be INJECTED (>= ${RANKING.pushFloor})       ${abovePush}  ${rate(
    abovePush
  )}`
);
console.log("");
console.log("top-score distribution");
for (const [label, p] of [
  ["p50", 0.5],
  ["p75", 0.75],
  ["p90", 0.9],
  ["p95", 0.95],
  ["p99", 0.99],
  ["max", 1.0],
]) {
  console.log(`  ${label}  ${pct(p).toFixed(4)}`);
}

console.log("");
console.log("what a hook WOULD have injected (judge these — precision is the");
console.log("binding constraint, and a wrong injection is worse than none):");
console.log("─".repeat(70));
for (const h of pushHits) {
  console.log(`  ${h.score.toFixed(3)}  Q: ${excerpt(h.q)}`);
  console.log(`         M: ${excerpt(h.body)}`);
}
if (pushHits.length === 0) {
  console.log("  nothing cleared the push floor.");
}

console.log("");
console.log("─".repeat(70));
console.log(
  `Injection rate is the number to judge. Too high and the hook is noise on\n` +
    `every prompt; too low and it never earns its keep. Read the pairs above:\n` +
    `if they do not look like answers to their questions, the floor is wrong.`
);
console.log("");
