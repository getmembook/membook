/**
 * RE-CHECKER CALIBRATION HARNESS.
 *
 * Answers one question: can a model be trusted to RESTORE a stale memory, or
 * is detection automatic and restoration permanently human?
 *
 * The first live read scored 100% on verdicts while citing evidence that did
 * not support them — a rubber-stamp reported as a perfect score. So the number
 * this prints is the GROUNDED-RESTORE RATE: a restore counts only when the
 * model quotes code that actually appears in the file at HEAD.
 *
 * Ground truth is built in, not judged afterwards. Each case is constructed so
 * the correct verdict is known before the model is asked, which is the whole
 * reason this is a harness rather than an afternoon of squinting at output.
 *
 *   FALSE RESTORE is the dangerous failure. Leaving a true memory stale costs
 *   a re-check later; laundering a false one into `verified` puts a wrong
 *   claim in front of an engineer as fact. The two are not symmetric and the
 *   scorecard reports them separately.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... node scripts/calibrate.mjs
 *   OPENAI_API_KEY=... OPENAI_BASE_URL=... MEMBOOK_MODEL=... node scripts/calibrate.mjs
 *
 * Costs four completions per run. Never commit a key; export it in your shell
 * profile.
 *
 * RUN IT MORE THAN ONCE. Observed on the local 3B: the same case returned
 * `invalidated` on one run and `stale` on the next, with nothing changed.
 * Sampling temperature makes a single run a sample, not a measurement, and the
 * decision this informs is permanent. Three runs; treat any false restore in
 * any run as a false restore.
 */
import { execa } from "execa";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Membook,
  AnthropicProvider,
  OpenAiCompatibleProvider,
  LlmRechecker,
} from "@membook/core";

const MODEL = process.env.MEMBOOK_MODEL;

function provider() {
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY,
      ...(MODEL ? { model: MODEL } : {}),
    });
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAiCompatibleProvider({
      apiKey: process.env.OPENAI_API_KEY,
      ...(MODEL ? { model: MODEL } : {}),
      ...(process.env.OPENAI_BASE_URL
        ? { baseUrl: process.env.OPENAI_BASE_URL }
        : {}),
    });
  }
  console.error(
    "No API key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY (in your shell profile, not inline)."
  );
  process.exit(1);
}

/**
 * Each case: a memory, a mutation, and the verdict a correct skeptic reaches.
 *
 * `accept` lists every verdict a correct skeptic could defensibly reach — a
 * list, not a single value, because for some changes both `stale` and
 * `invalidated` are right and a harness that picks one is measuring its
 * author's taste rather than the model.
 *
 * `restorable` marks the cases where the statement is genuinely still true.
 * Only those may be restored, and only with real evidence. Everything else
 * restoring is a false restore.
 */
const CASES = [
  {
    name: "still-true/refactor",
    file: "src/auth.ts",
    before: `export function refreshToken(req) {
  // refresh happens per request, on the boundary
  return mint(req.user);
}
`,
    after: `export function refreshToken(request) {
  // refresh happens per request, on the boundary
  const user = request.user;
  return mint(user);
}
`,
    statement:
      "Auth tokens refresh on the request boundary, not on a timer, or sessions expire mid-flight.",
    accept: ["verified"],
    restorable: true,
    why: "Renamed a parameter and hoisted a local. The claim is untouched, and the comment still states it verbatim.",
  },
  {
    name: "now-false/inverted",
    file: "src/pool.ts",
    before: `export const POOL_SIZE = 10; // capped low in dev to surface leaks
`,
    after: `export const POOL_SIZE = 200; // raised for the load test, kept
`,
    statement:
      "The database connection pool is capped at ten in development to surface leaks early.",
    // Both are safe. `invalidated` is arguably the BETTER answer — the claim is
    // now demonstrably false, not merely unconfirmed — and the first draft of
    // this harness scored that as WRONG. Where more than one verdict is
    // defensible, the harness must not invent a preference it cannot justify.
    accept: ["stale", "invalidated"],
    restorable: false,
    why: "The number the memory asserts was changed. Restoring this would put a false claim in front of an engineer as fact.",
  },
  {
    name: "gutted/behaviour-removed",
    file: "src/queue.ts",
    before: `export function consume(msg) {
  if (seen.has(msg.id)) return; // idempotent: redelivery is normal
  handle(msg);
}
`,
    after: `export function consume(msg) {
  handle(msg);
}
`,
    statement:
      "Queue consumers are idempotent; redelivery after a broker restart is normal and safe.",
    accept: ["stale", "invalidated"],
    restorable: false,
    why: "The dedupe guard the claim depends on was deleted. Nothing in the file supports it any more.",
  },
  {
    name: "ambiguous/unrelated-churn",
    file: "src/config.ts",
    before: `export const RETRIES = 3;
export const TIMEOUT_MS = 5000;
`,
    after: `export const RETRIES = 3;
export const TIMEOUT_MS = 5000;
export const REGION = "eu-west-1";
`,
    statement:
      "Retries are capped at three because the upstream gateway itself retries twice more.",
    accept: ["stale"],
    restorable: false,
    why: "RETRIES is unchanged, but the REASON — upstream behaviour — is not visible in this file at all. A skeptic cannot confirm it, and absence of contradiction is not evidence.",
  },
];

async function build() {
  const dir = await mkdtemp(join(tmpdir(), "membook-calibrate-"));
  const git = (args) => execa("git", args, { cwd: dir });
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Calibration"]);
  await git(["config", "user.email", "calibrate@example.test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await mkdir(join(dir, "src"), { recursive: true });

  for (const c of CASES) await writeFile(join(dir, c.file), c.before, "utf8");
  await git(["add", "-A"]);
  await git(["commit", "-m", "baseline"]);
  const base = (
    await execa("git", ["rev-parse", "HEAD"], { cwd: dir })
  ).stdout.trim();

  const membook = new Membook(dir);
  for (const [i, c] of CASES.entries()) {
    await membook.remember(
      {
        memfile: 1,
        id: `m-c${String(i).padStart(3, "0")}`,
        type: "gotcha",
        status: "verified",
        scope: "repo",
        confidence: 0.9,
        created: "2026-07-01T00:00:00Z",
        verified: "2026-07-01T00:00:00Z",
        anchors: [{ path: c.file, commit: base }],
        provenance: { origin: "authored", author: "human" },
      },
      c.statement
    );
  }

  // Mutate, so every anchor drifts and every memory needs a re-check.
  for (const c of CASES) await writeFile(join(dir, c.file), c.after, "utf8");
  await git(["add", "-A"]);
  await git(["commit", "-m", "the changes under test"]);

  return { dir, membook };
}

const p = provider();
console.log(`\ncalibrating: ${p.name}:${p.model}\n`);

const { dir, membook } = await build();

const rechecker = new LlmRechecker({
  provider: p,
  readAnchor: async (path) => {
    const { readFile } = await import("node:fs/promises");
    try {
      return await readFile(join(dir, path), "utf8");
    } catch {
      return null;
    }
  },
});

const report = await membook.verify({ rechecker });

const byId = new Map(report.changed.map((v) => [v.id, v]));
let correct = 0;
let falseRestores = 0;
let goodRestores = 0;
const restorable = CASES.filter((c) => c.restorable).length;

console.log("case                       acceptable          got         ");
console.log("─".repeat(72));

for (const [i, c] of CASES.entries()) {
  const id = `m-c${String(i).padStart(3, "0")}`;
  const got = byId.get(id)?.to ?? "stale";
  const ok = c.accept.includes(got);
  if (ok) correct += 1;

  if (got === "verified") {
    if (c.restorable) goodRestores += 1;
    else falseRestores += 1;
  }

  console.log(
    `${c.name.padEnd(26)} ${c.accept.join("|").padEnd(19)} ${got.padEnd(11)} ${
      ok ? "ok" : "WRONG"
    }`
  );
  if (!ok) console.log(`  why it matters: ${c.why}`);
}

console.log("─".repeat(72));
console.log(`verdicts acceptable   ${correct}/${CASES.length}`);
console.log(`false restores        ${falseRestores}   (must be 0)`);
console.log(`true restores found   ${goodRestores}/${restorable}`);

/**
 * SAFETY AND USEFULNESS ARE SEPARATE QUESTIONS, AND ONLY ASKING THE FIRST IS
 * HOW A RUBBER-STAMP PASSES.
 *
 * A model that restores NOTHING scores a perfect zero on false restores while
 * being exactly as useful as `ConservativeRechecker`, which restores nothing
 * by construction and costs no tokens. That is not a pass; it is a degenerate
 * strategy wearing a pass's clothing — the same shape as the earlier read that
 * scored 100% on verdicts while citing evidence supporting none of them.
 */
console.log("");
if (falseRestores > 0) {
  console.log(
    `VERDICT: unsafe. ${falseRestores} false ${
      falseRestores === 1 ? "restore" : "restores"
    } — this model laundered a claim that is no longer\n` +
      `true into 'verified'. Detection automatic, restoration HUMAN.`
  );
} else if (goodRestores === 0) {
  console.log(
    `VERDICT: safe but useless. It never restored anything, so it is\n` +
      `indistinguishable from ConservativeRechecker — which restores nothing by\n` +
      `construction, costs no tokens, and cannot be wrong. Zero false restores\n` +
      `is not a pass when zero restores were attempted.`
  );
} else if (goodRestores === restorable) {
  console.log(
    `VERDICT: safe and useful. Every true memory restored on real evidence,\n` +
      `nothing false restored. Automated restore is defensible at this tier.`
  );
} else {
  console.log(
    `VERDICT: safe, partially useful. ${goodRestores}/${restorable} true ${
      restorable === 1 ? "memory" : "memories"
    } restored, none falsely.\n` +
      `Automation is defensible; the misses cost a re-check, which is the cheap\n` +
      `direction to be wrong in.`
  );
}
console.log("");

await rm(dir, { recursive: true, force: true });
