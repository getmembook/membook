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

// Seed a third of the way in, leaving two thirds of history to walk through.
const startIdx = Math.floor(commits.length / 3);
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
const CODE = /\.(ts|tsx|js|jsx|py|go|rs|java|cs|rb|php|swift|kt|sql)$/;
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

// Even stride across the ranked list: a spread of hot, warm and cold files.
const pickStride = Math.max(1, Math.floor(ranked.length / ANCHORS));
const chosen = ranked
  .filter((_, i) => i % pickStride === 0)
  .slice(0, ANCHORS)
  .map((r) => r.path);

if (chosen.length === 0) {
  console.error(`no source files over ${MIN_BYTES} bytes at the seed commit.`);
  await rm(dir, { recursive: true, force: true });
  process.exit(1);
}

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
console.log(`renames followed      ${renamesFollowed.length}`);

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
