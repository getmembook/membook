import {
  Membook,
  SEED_SYSTEM,
  SecretScanGuard,
  headSha,
  isGitRepository,
  seed as runSeed,
  seedFrontmatter,
  type ModelProvider,
  type SeedCandidate,
} from "@membook/core";
import { providerFromEnv } from "./misc.js";
import { bad, dim, die, heading, ok, plural, warn, wrap } from "../output.js";

export interface SeedOptions {
  root: string;
  log?: (line: string) => void;
  dryRun?: boolean;
  maxFiles?: number;
  model?: string;
  /** Injected in tests; falls back to the environment. */
  provider?: ModelProvider;
  now?: () => Date;
}

/**
 * Turn a repository's existing prose into candidate memories.
 *
 * The cold-start problem stated plainly: a fresh `init` writes an empty book,
 * so nothing is gained until an agent volunteers to record something — and
 * measured on real repositories, it does not. Meanwhile `CLAUDE.md` and the
 * ADRs already contain the decisions, unanchored and unread at the moment
 * they would help.
 *
 * Everything written here is `unverified` and goes to `membook review`. That
 * is not timidity about model output; it is where the product gets the only
 * ground-truth labels it will ever have.
 */
export async function seed(options: SeedOptions): Promise<void> {
  const log =
    options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  if (!(await isGitRepository(options.root))) {
    die(
      "Not a git repository.",
      "Membook anchors memories to commits, so it needs one."
    );
  }

  const provider = options.provider ?? providerFromEnv(options.model);
  if (!provider) {
    die(
      "Seeding needs a model, and no API key is configured.",
      "Set ANTHROPIC_API_KEY or OPENAI_API_KEY and run this again. Everything else in Membook works without one."
    );
    return;
  }

  const membook = new Membook(options.root, {
    guards: [new SecretScanGuard()],
    instrumentation: true,
  });

  // Existing statements suppress exact duplicates, so re-running seed after
  // adding a document is cheap and does not pile up near-copies.
  const { memories } = await membook.store.readAll();
  const existing = memories.map((m) => m.memfile.body);

  log("");
  log(heading("Reading what this repository already documents"));
  log("");

  const report = await runSeed(options.root, {
    provider,
    system: SEED_SYSTEM,
    instrumentation: membook.instrumentation,
    existing,
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
    onProgress: (path, index, total) => {
      log(dim(`  [${index + 1}/${total}] ${path}`));
    },
  });

  log("");

  if (report.sourcesRead.length === 0) {
    log(warn("No documentation found to read."));
    log("");
    log(
      wrap(
        "Seeding reads tracked markdown — CLAUDE.md, AGENTS.md, ADRs, docs/. This repository has none long enough to be worth distilling."
      )
    );
    log("");
    return;
  }

  if (report.sourcesFailed.length > 0) {
    log(
      warn(
        `${report.sourcesFailed.length} ${plural(
          report.sourcesFailed.length,
          "file",
          "files"
        )} could not be distilled: ${report.sourcesFailed.join(", ")}.`
      )
    );
    log("");
  }

  if (report.candidates.length === 0) {
    log(ok("Nothing worth recording."));
    log("");
    log(
      wrap(
        `Read ${report.sourcesRead.length} ${plural(
          report.sourcesRead.length,
          "file",
          "files"
        )} and kept nothing. Rejection is the default — most documentation describes what the code already says, and a memory that repeats it is noise an agent has to read past.`
      )
    );
    reportRejections(report.rejected, log);
    log("");
    return;
  }

  const commit = await headSha(options.root);
  const timestamp = `${now().toISOString().slice(0, 19)}Z`;

  log(
    heading(
      `${report.candidates.length} candidate ${plural(
        report.candidates.length,
        "memory",
        "memories"
      )} from ${report.sourcesRead.length} ${plural(
        report.sourcesRead.length,
        "file",
        "files"
      )}`
    )
  );
  log("");

  for (const candidate of report.candidates) {
    log(`  ${candidate.type}  ${dim(candidate.source)}`);
    log(wrap(candidate.statement, 74, "    "));
    log("");
  }

  reportRejections(report.rejected, log);

  if (options.dryRun) {
    log(dim("Dry run: nothing was written."));
    log("");
    return;
  }

  let written = 0;
  const blocked: string[] = [];

  for (const candidate of report.candidates) {
    try {
      const id = await membook.store.allocateId(candidate.statement);
      await membook.remember(
        seedFrontmatter(candidate as SeedCandidate, {
          id,
          commit,
          timestamp,
          model: provider.model,
        }),
        candidate.statement
      );
      written += 1;
    } catch (error) {
      // A guard refusing at the write is not a crash: record it and continue,
      // or one bad candidate would discard every good one after it.
      blocked.push((error as Error).message);
    }
  }

  log(
    ok(
      `Recorded ${written} ${plural(
        written,
        "memory",
        "memories"
      )} as unverified.`
    )
  );

  if (blocked.length > 0) {
    log(
      bad(
        `${blocked.length} ${plural(
          blocked.length,
          "was",
          "were"
        )} refused at the write: ${blocked[0]}`
      )
    );
  }

  log("");
  log(
    wrap(
      "A model proposed these; nothing has checked them. Read them and decide — that decision is the strongest verification Membook has."
    )
  );
  log("");
  log(dim("  membook review   ratify or delete each one"));
  log(dim("  membook book     regenerate MEMBOOK.md afterwards"));
  log("");
}

/**
 * Report what was thrown away.
 *
 * Shown rather than hidden because the rejection count is how a user can tell
 * the gates are working. A seeder that silently kept everything would look
 * identical to one that refused nothing.
 */
function reportRejections(
  rejected: readonly { reason: string }[],
  log: (line: string) => void
): void {
  if (rejected.length === 0) return;

  const byReason = new Map<string, number>();
  for (const r of rejected)
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);

  const describe: Record<string, string> = {
    "ungrounded-anchor": "cited a file that does not exist",
    secret: "contained a credential",
    duplicate: "already recorded",
    malformed: "was not well formed",
  };

  log(
    dim(
      `Discarded ${rejected.length}: ` +
        [...byReason.entries()]
          .map(([reason, n]) => `${n} ${describe[reason] ?? reason}`)
          .join(", ") +
        "."
    )
  );
  log("");
}
