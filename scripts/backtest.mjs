/**
 * VERIFY-LOOP BACKTEST.
 *
 * The verification loop is the product's only moat, and until now it had been
 * tested exclusively against fixtures we wrote — mutations chosen by the same
 * person who wrote the code that detects them. That proves the mechanism runs;
 * it cannot prove the mechanism is USEFUL, because a fixture cannot tell you
 * how often real code actually drifts.
 *
 * Git history is a time machine for exactly this. Seed memories at an old
 * commit, walk forward through history that already happened, and measure the
 * loop against real evolution at a thousand times speed.
 *
 * NEEDS NO MODEL. Detection is `git diff`, rename-following and deletion —
 * all deterministic. The one thing it cannot judge is whether a STATEMENT is
 * still true after its anchor moved; that is the re-check question, and it is
 * deliberately out of scope here.
 *
 * The headline number is MEMORY HALF-LIFE: how long a memory anchored to a
 * real file survives before its anchor drifts. If that is three days the loop
 * cries wolf and the product is noise; if it is months, the signal is real.
 * Nobody has this number, and every claim about reclaimed hours depends on it.
 *
 * Usage:
 *   node scripts/backtest.mjs <repo> [--anchors 12] [--steps 20]
 *
 * Operates on a temporary clone. The target repository is never written to.
 */
import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Membook } from "@membook/core";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const ANCHORS = flag("anchors", 12);
const STEPS = flag("steps", 20);

if (!target) {
  console.error(
    "usage: node scripts/backtest.mjs <repo> [--anchors N] [--steps N]"
  );
  process.exit(1);
}

const git = (cwd) => (a) => execa("git", a, { cwd });

console.log(`\nbacktest: ${target}\n`);

// A temporary clone, so the loop can check out historical commits without
// touching a repository someone is actually working in.
const dir = await mkdtemp(join(tmpdir(), "membook-backtest-"));
const g = git(dir);
await execa("git", ["clone", "--quiet", "--no-hardlinks", target, dir]);
await g(["config", "user.name", "Backtest"]);
await g(["config", "user.email", "backtest@example.test"]);
await g(["config", "commit.gpgsign", "false"]);

const commits = (await g(["log", "--format=%H %at", "--reverse"])).stdout
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [sha, at] = l.split(" ");
    return { sha, at: Number(at) * 1000 };
  });

if (commits.length < 20) {
  console.error(
    `only ${commits.length} commits — too little history to measure.`
  );
  await rm(dir, { recursive: true, force: true });
  process.exit(1);
}

/**
 * Seed a third of the way in — unless that would skip every rename.
 *
 * Measured on a real repository: all 67 renames sat in the FIRST third of
 * history, so a fixed seed point walked a window containing none and reported
 * rename-following as untested. That is the common shape, not an accident —
 * restructuring happens early and paths settle — so a fixed fraction
 * systematically blinds the harness to the behaviour it most needs to check.
 *
 * So the seed point moves back to sit before the first rename when one exists.
 * A shorter window measured against real renames beats a longer one measured
 * against none.
 */
const firstRenameIdx = await (async () => {
  const shas = (
    await g(["log", "--diff-filter=R", "--find-renames", "--format=%H"])
  ).stdout
    .split("\n")
    .filter(Boolean);
  if (shas.length === 0) return -1;
  const oldest = shas.at(-1);
  return commits.findIndex((c) => c.sha === oldest);
})();

const CODE = /\.(ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|swift|kt|sql)$/;
const defaultIdx = Math.floor(commits.length / 3);

/**
 * Walk back toward the first rename, but only as far as there is still enough
 * code to anchor to.
 *
 * A first attempt guarded with `firstRenameIdx > 1` and silently did nothing,
 * because the oldest rename sat at index 1 — seeding before it would have
 * meant the initial commit, where barely any source exists. Two constraints
 * pull opposite ways: early enough to see renames, late enough to have files.
 * So satisfy the first, then advance until the second holds.
 */
const MIN_ANCHORABLE = Math.max(15, ANCHORS);
const countSource = async (sha) =>
  (await g(["ls-tree", "-r", "--name-only", sha])).stdout
    .split("\n")
    .filter(
      (p) => CODE.test(p) && !/(^|\/)(node_modules|dist|build|vendor)\//.test(p)
    ).length;

/**
 * ONE SEED POINT CANNOT SERVE BOTH NUMBERS.
 *
 * Moving the seed back to capture renames put it at the initial commit, where
 * the next few commits rewrite everything — half-life came out at 0.0 days,
 * measuring a project's first-week churn rather than the durability of a
 * memory about settled code. The fix for one bias produced its mirror image.
 *
 * So the modes are explicit. `--renames` seeds early and measures the
 * mechanics; the default seeds into mature history and measures half-life.
 * Reporting either number from the wrong window would be worse than not
 * measuring it.
 */
const RENAME_MODE = args.includes("--renames");

let startIdx = defaultIdx;
if (RENAME_MODE && firstRenameIdx >= 0 && firstRenameIdx <= defaultIdx) {
  let i = Math.max(0, firstRenameIdx - 1);
  while (
    i < defaultIdx &&
    (await countSource(commits[i].sha)) < MIN_ANCHORABLE
  ) {
    i += 1;
  }
  startIdx = i;
}

if (startIdx !== defaultIdx) {
  console.log(
    `RENAME MODE: seeded at index ${startIdx} (default ${defaultIdx}) to capture renames.\n` +
      `Half-life from this window is NOT meaningful — early history rewrites itself.\n` +
      `Run without --renames for the durability number.\n`
  );
}

const start = commits[startIdx];
const walk = commits.slice(startIdx + 1);
const step = Math.max(1, Math.floor(walk.length / STEPS));
const checkpoints = walk.filter(
  (_, i) => i % step === 0 || i === walk.length - 1
);

await g(["checkout", "--quiet", start.sha]);

/**
 * Anchor to the files a memory would plausibly be written about: real source,
 * not config or lockfiles. Sampled across the tree rather than taking the top
 * N, so the result is not dominated by one hot directory.
 */
const tracked = (await g(["ls-files"])).stdout
  .split("\n")
  .filter(
    (p) => CODE.test(p) && !/(^|\/)(node_modules|dist|build|vendor)\//.test(p)
  );

if (tracked.length === 0) {
  console.error("no source files at the seed commit.");
  await rm(dir, { recursive: true, force: true });
  process.exit(1);
}

/**
 * SAMPLE WHERE MEMORIES ACTUALLY GET WRITTEN.
 *
 * The first run of this harness sampled by alphabetical stride and reported a
 * half-life beyond the whole window — because it had anchored to empty
 * `__init__.py` files and migration stubs. Files that never change because
 * they contain nothing are not evidence that memories survive; nobody writes
 * a memory about an empty file.
 *
 * A memory is written about code someone had to reason about, which means
 * substantive files that people actually work in. So: require real content,
 * and sample across the activity distribution rather than taking the hottest
 * files (which would bias the number in the opposite direction just as hard).
 */
const MIN_BYTES = 600;

const sized = [];
for (const path of tracked) {
  const bytes = Number(
    (
      await g(["cat-file", "-s", `${start.sha}:${path}`]).catch(() => ({
        stdout: "0",
      }))
    ).stdout
  );
  if (bytes >= MIN_BYTES) sized.push(path);
}

// How often each file was touched over the walked window, so the sample spans
// quiet, ordinary and busy code rather than clustering at one end.
const touchCounts = new Map();
const log = (
  await g([
    "log",
    "--format=",
    "--name-only",
    `${start.sha}..${commits.at(-1).sha}`,
  ])
).stdout
  .split("\n")
  .filter(Boolean);
for (const p of log) touchCounts.set(p, (touchCounts.get(p) ?? 0) + 1);

const ranked = sized
  .map((path) => ({ path, touches: touchCounts.get(path) ?? 0 }))
  .sort((a, b) => b.touches - a.touches);

/**
 * DELIBERATELY ANCHOR TO FILES THAT GET RENAMED.
 *
 * The first version of this harness reported "renames followed: 0" against a
 * repository containing 67 real renames — none of the sampled files happened
 * to be one. So the backtest silently exercised none of rename-following,
 * which is the signature demo and the single most-marketed behaviour.
 *
 * Random sampling will keep missing it: renames are rare per-file even where
 * they are common per-repo. The fix is to stop leaving it to chance and
 * reserve part of the sample for paths git says are renamed during the window.
 * Anything a harness only tests by luck, it does not test.
 */
const renamedDuringWindow = new Map(); // old path -> new path
{
  const raw = (
    await g([
      "log",
      "--diff-filter=R",
      "--find-renames",
      "--format=",
      "--name-status",
      `${start.sha}..${commits.at(-1).sha}`,
    ])
  ).stdout
    .split("\n")
    .filter((l) => l.startsWith("R"));
  for (const line of raw) {
    const [, from, to] = line.split("\t");
    if (from && to) renamedDuringWindow.set(from, to);
  }
}

// Up to a third of the sample, so the number stays a measurement of the loop
// rather than a demo staged to look good.
const renameQuota = Math.max(1, Math.floor(ANCHORS / 3));
const renameCandidates = ranked
  .filter((r) => renamedDuringWindow.has(r.path))
  .slice(0, renameQuota)
  .map((r) => r.path);

const remaining = ANCHORS - renameCandidates.length;
const rest = ranked.filter((r) => !renameCandidates.includes(r.path));
const pickStride = Math.max(
  1,
  Math.floor(rest.length / Math.max(1, remaining))
);
const chosen = [
  ...renameCandidates,
  ...rest
    .filter((_, i) => i % pickStride === 0)
    .slice(0, remaining)
    .map((r) => r.path),
];

if (chosen.length === 0) {
  console.error(`no source files over ${MIN_BYTES} bytes at the seed commit.`);
  await rm(dir, { recursive: true, force: true });
  process.exit(1);
}

console.log(
  `${renamedDuringWindow.size} renames in window; ` +
    `${renameCandidates.length} of ${chosen.length} anchors deliberately placed on renamed paths`
);

const membook = new Membook(dir);
const seeded = [];
for (const [i, path] of chosen.entries()) {
  const id = `m-b${String(i).padStart(3, "0")}`;
  const created = new Date(start.at).toISOString().slice(0, 19) + "Z";
  await membook.remember(
    {
      memfile: 1,
      id,
      type: "gotcha",
      status: "verified",
      scope: "repo",
      confidence: 0.9,
      created,
      verified: created,
      anchors: [{ path, commit: start.sha }],
      provenance: { origin: "authored", author: "human" },
    },
    `A durable claim about the behaviour implemented in ${path}.`
  );
  seeded.push({ id, path });
}

const touchesOf = (path) => touchCounts.get(path) ?? 0;
console.log(
  "sample activity (commits touching each anchor in the window):\n  " +
    chosen.map((c) => `${touchesOf(c)}`).join(", ") +
    "\n"
);
console.log(
  `seeded ${seeded.length} memories at ${start.sha.slice(0, 7)} ` +
    `(${new Date(start.at).toISOString().slice(0, 10)}), ` +
    `walking ${checkpoints.length} checkpoints across ${walk.length} commits\n`
);

// `.membook/` must survive checkouts of commits that predate it.
await writeFile(
  join(dir, ".git/info/exclude"),
  ".membook/\nMEMBOOK.md\n",
  "utf8"
);

const firstDrift = new Map(); // id -> {at, sha, kind}
const renamesFollowed = [];
let checkpointsRun = 0;

for (const cp of checkpoints) {
  // `--force` because historical commits may not contain paths the working
  // tree has; the memories live in an excluded directory and are unaffected.
  await g(["checkout", "--quiet", "--force", cp.sha]);
  checkpointsRun += 1;

  const report = await membook.verify();

  for (const v of report.changed) {
    // The target repo may carry its own real memories — membook itself does.
    // The measurement is about the anchors this harness planted; a verdict on
    // a pre-existing memory is someone else's story and crashes the
    // bookkeeping (found when the first target with a live store was scanned).
    if (!seeded.some((s) => s.id === v.id)) continue;
    if (v.from === "verified" && v.to !== "verified" && !firstDrift.has(v.id)) {
      firstDrift.set(v.id, {
        at: cp.at,
        sha: cp.sha,
        to: v.to,
        kinds: v.outcomes.map((o) => o.kind),
      });
    }
    // A followed rename is the loop's most valuable trick: the memory keeps
    // pointing at the code rather than at a path that no longer exists.
    for (const o of v.outcomes) {
      if (o.kind === "renamed") {
        renamesFollowed.push({ id: v.id, sha: cp.sha });
      }
    }
  }
}

/**
 * Did the anchor actually end up pointing at the code?
 *
 * Counting `renamed` outcomes only proves the loop NOTICED. The claim being
 * made is stronger — that a memory survives a rename still pointing at the
 * file — so the check is against where git says the content ended up, after
 * following the whole chain (a file renamed twice must land on the last name).
 */
function resolveRenameChain(path) {
  const seen = new Set();
  let current = path;
  while (renamedDuringWindow.has(current) && !seen.has(current)) {
    seen.add(current);
    current = renamedDuringWindow.get(current);
  }
  return current;
}

const renameChecks = [];
for (const s of seeded) {
  const expected = resolveRenameChain(s.path);
  if (expected === s.path) continue; // never renamed; nothing to prove here
  const stored = await membook.store.read(s.id);
  const actual = stored.memfile.frontmatter.anchors[0].path;
  renameChecks.push({
    from: s.path,
    expected,
    actual,
    ok: actual === expected,
  });
}

const survived = seeded.filter((s) => !firstDrift.has(s.id));
const drifted = [...firstDrift.entries()].map(([id, d]) => ({
  id,
  path: seeded.find((s) => s.id === id).path,
  days: (d.at - start.at) / 86_400_000,
  to: d.to,
  kinds: d.kinds,
}));
drifted.sort((a, b) => a.days - b.days);

const span = (commits.at(-1).at - start.at) / 86_400_000;

console.log("─".repeat(68));
console.log(
  `window                ${span.toFixed(0)} days, ${walk.length} commits`
);
console.log(`checkpoints verified  ${checkpointsRun}`);
console.log(`memories seeded       ${seeded.length}`);
console.log(`drifted               ${drifted.length}`);
console.log(`never drifted         ${survived.length}`);
console.log(`renames noticed       ${renamesFollowed.length}`);
if (renameChecks.length > 0) {
  const ok = renameChecks.filter((r) => r.ok).length;
  console.log(
    `RENAME-FOLLOW RATE    ${ok}/${renameChecks.length} anchors landed on the new path`
  );
  for (const r of renameChecks.filter((x) => !x.ok)) {
    console.log(`  MISSED  ${r.from}`);
    console.log(`    expected ${r.expected}`);
    console.log(`    actual   ${r.actual}`);
  }
} else {
  console.log(`RENAME-FOLLOW RATE    untested (no sampled anchor was renamed)`);
}

if (drifted.length > 0) {
  const median = drifted[Math.floor(drifted.length / 2)].days;
  console.log(`\nMEDIAN TIME TO DRIFT  ${median.toFixed(1)} days`);
  console.log(`fastest               ${drifted[0].days.toFixed(1)} days`);
  console.log(`slowest               ${drifted.at(-1).days.toFixed(1)} days`);
}

// Half-life: the point at which half the memories are still trustworthy. The
// number a claim about reclaimed hours actually rests on.
const halfIdx = Math.floor(seeded.length / 2);
console.log(
  `\nHALF-LIFE             ` +
    (drifted.length > halfIdx
      ? `${drifted[halfIdx].days.toFixed(1)} days`
      : `> ${span.toFixed(0)} days (over half survived the whole window)`)
);

console.log("\nstable anchors (never drifted):");
for (const s of survived.slice(0, 8)) console.log(`  ${s.path}`);
if (survived.length > 8) console.log(`  ... and ${survived.length - 8} more`);

console.log("\nfirst to drift:");
for (const d of drifted.slice(0, 8)) {
  console.log(
    `  ${d.days.toFixed(1)}d  ${d.to.padEnd(12)} ${d.path}  [${d.kinds.join(
      ","
    )}]`
  );
}

console.log("\n" + "─".repeat(68));
console.log(
  `Half-life is the number every claim about reclaimed hours rests on.\n` +
    `Short, and the loop cries wolf. Long, and the signal is real — and\n` +
    `these stable paths are the anchors worth writing memories against.`
);
console.log("");

await rm(dir, { recursive: true, force: true });
