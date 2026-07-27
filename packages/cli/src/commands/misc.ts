import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MEMFILE_SPEC_VERSION,
  type MemoryInput,
  type MemoryType,
} from "@membook/spec";
import {
  AnthropicProvider,
  LlmRechecker,
  Membook,
  OpenAiCompatibleProvider,
  SecretScanGuard,
  UserStore,
  changesSince,
  defaultWorkspacePath,
  headSha,
  findMissingAnchorPaths,
  isGitRepository,
  resolveWorkspaceFile,
  type AnchorRechecker,
  type ModelProvider,
  type Instrumentation,
  type ResolvedWorkspace,
} from "@membook/core";
import {
  bad,
  die,
  dim,
  heading,
  ok,
  plural,
  statusLabel,
  warn,
  wrap,
} from "../output.js";

export interface CommonOptions {
  root: string;
  log?: (line: string) => void;
}

const out = (options: CommonOptions) =>
  options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

export async function reindex(options: CommonOptions): Promise<void> {
  const log = out(options);
  const membook = new Membook(options.root);
  const report = await membook.reindex();

  log("");
  log(
    ok(
      `Rebuilt the index from ${report.indexed} ${plural(
        report.indexed,
        "memory",
        "memories"
      )}.`
    )
  );
  if (report.quarantined.length > 0) {
    log(
      warn(
        `${report.quarantined.length} ${plural(
          report.quarantined.length,
          "file",
          "files"
        )} failed validation and ${plural(
          report.quarantined.length,
          "was",
          "were"
        )} skipped:`
      )
    );
    for (const q of report.quarantined)
      log(`    ${q.file}  ${dim(q.issues[0] ?? "")}`);
    log(dim("  The files were left in place. Repair them and reindex again."));
  }
  log("");
}

/**
 * Resolve a `--workspace [manifest]` flag: a bare flag means the default
 * `~/.membook/workspace.yaml`, and a manifest the user asked for but cannot
 * be used is a configuration error to die on, never to degrade around.
 */
export async function resolveWorkspaceFlag(
  flag: string | true | undefined
): Promise<ResolvedWorkspace | undefined> {
  if (flag === undefined) return undefined;
  const manifestPath = typeof flag === "string" ? flag : defaultWorkspacePath();
  try {
    return await resolveWorkspaceFile(manifestPath);
  } catch (error) {
    die(
      `Could not use the workspace manifest at ${manifestPath}.`,
      (error as Error).message
    );
  }
}

export interface MigrateCliOptions extends CommonOptions {
  dryRun?: boolean;
}

/**
 * Rewrite the store to the current canonical form, as a diff to review.
 *
 * This is the write half of the version machinery: reading tolerates every
 * version ever published, and nothing rewrites a committed file as a side
 * effect of having read it. When the store should move forward — an older
 * memfile version, or a hand-edited file that drifted from canonical
 * serialization — this command does it explicitly, in one pass a human can
 * read before committing.
 */
export async function migrate(options: MigrateCliOptions): Promise<void> {
  const log = out(options);
  const membook = new Membook(options.root, { instrumentation: true });
  const report = await membook.migrate({
    ...(options.dryRun ? { dryRun: true } : {}),
  });

  log("");

  if (
    report.examined === 0 &&
    report.quarantined.length === 0 &&
    report.needsNewerMembook.length === 0
  ) {
    log(ok("Nothing to migrate — no memories are recorded yet."));
    log("");
    return;
  }

  if (report.rewritten.length === 0) {
    log(
      ok(
        `All ${report.examined} ${plural(
          report.examined,
          "memory is",
          "memories are"
        )} already in the current form (memfile v${MEMFILE_SPEC_VERSION}).`
      )
    );
  } else {
    log(
      heading(
        `${report.rewritten.length} of ${report.examined} ${
          report.dryRun ? "would be rewritten" : "rewritten"
        } to the current form (memfile v${MEMFILE_SPEC_VERSION})`
      )
    );
    for (const entry of report.rewritten) {
      log(
        `  ${entry.id}  ${dim(
          entry.reason === "older-version"
            ? `v${entry.from} → v${entry.to}`
            : "canonical form restored"
        )}`
      );
    }
    log("");
    if (report.dryRun) {
      log(dim("  Nothing was written. Run without --dry-run to apply."));
    } else {
      log(
        wrap(
          "The files changed on disk and nothing was committed. Review the diff and commit it as its own change — a migration is a rewrite a human reads, never a side effect."
        )
      );
    }
  }
  log("");

  if (report.needsNewerMembook.length > 0) {
    const n = report.needsNewerMembook.length;
    log(
      warn(
        `${n} ${plural(n, "file was", "files were")} skipped: ${plural(
          n,
          "it needs",
          "they need"
        )} a newer Membook than this one (` +
          report.needsNewerMembook
            .map((f) => `${f.file} is v${f.found}`)
            .join(", ") +
          `).`
      )
    );
    log(
      dim(
        "  Upgrade Membook rather than editing them — an older tool must not rewrite a newer file."
      )
    );
    log("");
  }

  if (report.quarantined.length > 0) {
    const n = report.quarantined.length;
    log(
      warn(
        `${n} ${plural(
          n,
          "file failed validation and was",
          "files failed validation and were"
        )} left untouched:`
      )
    );
    for (const q of report.quarantined)
      log(`    ${q.file}  ${dim(q.issues[0] ?? "")}`);
    log(dim("  Repair the file, or delete it. Nothing was thrown away."));
    log("");
  }
}

export interface RecallOptions extends CommonOptions {
  query: string;
  paths?: string[];
  includeStale?: boolean;
  limit?: number;
}

/**
 * Ask what an agent would be served.
 *
 * This exists because retrieval precision is the binding constraint — a wrong
 * retrieval poisons a loop far more expensively than a missing one costs — and
 * until now it was unobservable without an agent volunteering to ask. A human
 * could write memories and never see what they bought.
 *
 * It deliberately goes through `recall`, not `search`: the ranked, floored,
 * capped answer is the product surface. A raw index query would show a
 * different, friendlier result than the one that reaches an agent, which is
 * exactly the self-deception this command is meant to prevent.
 */
export async function recall(options: RecallOptions): Promise<void> {
  const log = out(options);
  const membook = new Membook(options.root, {
    instrumentation: true,
    // The human's own store joins every recall (v0.2 §8).
    userStore: new UserStore(),
  });

  const statuses: Array<"verified" | "unverified" | "stale"> = [
    "verified",
    "unverified",
  ];
  if (options.includeStale) statuses.push("stale");

  const { hits, withheld } = await membook.recall(options.query, {
    statuses,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.paths?.length ? { contextPaths: options.paths } : {}),
  });

  log("");

  if (hits.length === 0) {
    // "We know nothing" and "we know something we no longer trust" call for
    // opposite responses, so both drifted statuses have to be counted here.
    // Counting only `stale` reports a deleted-file memory as nothing known —
    // the same confusion this command exists to prevent, one status over.
    const stale = withheld.byStatus["stale"] ?? 0;
    const invalidated = withheld.byStatus["invalidated"] ?? 0;

    if (stale + invalidated > 0) {
      log(heading("Nothing usable for that query."));
      log("");
      if (stale > 0) {
        log(
          wrap(
            `${stale} matching ${plural(
              stale,
              "memory is",
              "memories are"
            )} stale — the code they describe changed and nothing has confirmed them since.`
          )
        );
      }
      if (invalidated > 0) {
        log(
          wrap(
            `${invalidated} matching ${plural(
              invalidated,
              "memory was",
              "memories were"
            )} invalidated — the code ${plural(
              invalidated,
              "it describes is",
              "they describe is"
            )} gone.`
          )
        );
      }
      log("");
      // Invalidated memories are never served: the anchor is gone, so nothing
      // can re-ground them. `review` is the only honest next step for those.
      log(
        dim(
          stale > 0
            ? "  membook recall --include-stale   see the stale ones"
            : "  membook review                   decide what to do with them"
        )
      );
    } else {
      log(heading("Nothing recorded for that query."));
    }
    if (withheld.belowFloor > 0) {
      log(
        dim(
          `  ${withheld.belowFloor} weak ${plural(
            withheld.belowFloor,
            "match",
            "matches"
          )} scored below the relevance floor and ${plural(
            withheld.belowFloor,
            "was",
            "were"
          )} not served.`
        )
      );
    }
    log("");
    return;
  }

  log(
    heading(
      `${hits.length} ${plural(hits.length, "memory", "memories")} an agent ` +
        `would be served for “${options.query}”`
    )
  );
  log("");

  for (const hit of hits) {
    // A user hit has no lifecycle to label and no anchors to cite — the
    // scope IS its provenance, and it is said plainly.
    log(
      `${hit.status === null ? dim("user") : statusLabel(hit.status)}  ${
        hit.id
      }  ${dim(hit.type)}`
    );
    log(wrap(hit.body, 76, "  "));
    if (hit.anchors.length > 0) {
      log(
        dim(
          `  ${hit.anchors
            .map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path))
            .join(", ")}`
        )
      );
    }
    // Shown because a human tuning retrieval needs to see the margin between
    // what was served and what was not.
    log(dim(`  score ${hit.score.toFixed(3)}`));
    log("");
  }

  if (withheld.belowFloor > 0) {
    log(
      dim(
        `${withheld.belowFloor} weaker ${plural(
          withheld.belowFloor,
          "match was",
          "matches were"
        )} held back below the relevance floor.`
      )
    );
    log("");
  }
}

export interface BookCliOptions extends CommonOptions {
  /** Resolve cross-repo anchors via a workspace manifest. */
  workspace?: string | true;
}

export async function book(options: BookCliOptions): Promise<void> {
  const log = out(options);
  const workspace = await resolveWorkspaceFlag(options.workspace);
  // Instrumented, because how much the book carried and how much it withheld
  // are the numbers the honesty claim rests on. Found by dogfooding: the book
  // event existed and was recorded into a null log on every human run.
  const membook = new Membook(options.root, { instrumentation: true });
  const report = await membook.writeBook({
    ...(workspace ? { workspace } : {}),
  });

  log("");
  log(
    ok(
      `Wrote MEMBOOK.md — ${report.entries.length} ${plural(
        report.entries.length,
        "memory",
        "memories"
      )}, ${report.tokens} tokens.`
    )
  );
  if (report.excluded > 0) {
    log(
      dim(
        `  ${report.excluded} withheld: the code ${plural(
          report.excluded,
          "it describes has",
          "they describe has"
        )} changed since ${plural(
          report.excluded,
          "it was",
          "they were"
        )} last checked.`
      )
    );
  }
  if (report.excludedUnresolvable > 0) {
    log(
      dim(
        `  ${report.excludedUnresolvable} withheld: the ${plural(
          report.excludedUnresolvable,
          "repository it describes is",
          "repositories they describe are"
        )} not present on this machine.`
      )
    );
  }
  if (report.omitted > 0) {
    log(dim(`  ${report.omitted} did not fit under the token budget.`));
  }
  log("");
}

/**
 * Build a re-checker from the environment, or explain why it cannot.
 *
 * The model is overridable by `--model` first, then `MEMBOOK_MODEL`, then the
 * provider default. The env var alone was not enough: nothing surfaced its
 * name, so a local Ollama was asked for `gpt-4o-mini` twelve times across four
 * runs before the telemetry made it obvious. An override nobody can find is
 * not an override.
 */
/**
 * Resolve a model provider from the environment, or null if none is
 * configured.
 *
 * Anthropic wins when both keys are present — an arbitrary but fixed choice,
 * and a fixed one matters: a provider that varies with environment ordering
 * makes an inconsistent result impossible to reproduce.
 */
export function providerFromEnv(modelOverride?: string): ModelProvider | null {
  const model = modelOverride ?? process.env["MEMBOOK_MODEL"];

  if (process.env["ANTHROPIC_API_KEY"]) {
    return new AnthropicProvider({
      apiKey: process.env["ANTHROPIC_API_KEY"],
      ...(model ? { model } : {}),
    });
  }
  if (process.env["OPENAI_API_KEY"]) {
    return new OpenAiCompatibleProvider({
      apiKey: process.env["OPENAI_API_KEY"],
      ...(model ? { model } : {}),
      ...(process.env["OPENAI_BASE_URL"]
        ? { baseUrl: process.env["OPENAI_BASE_URL"] }
        : {}),
    });
  }
  return null;
}

export function recheckerFromEnv(
  root: string,
  instrumentation?: Instrumentation,
  modelOverride?: string
): AnchorRechecker | null {
  const provider = providerFromEnv(modelOverride);
  if (!provider) return null;

  return new LlmRechecker({
    provider,
    // Without this the verdicts go to a NullInstrumentation, and re-checker
    // accuracy — the one number this seam exists to make measurable — is
    // silently not recorded.
    ...(instrumentation ? { instrumentation } : {}),
    readAnchor: async (path) => {
      try {
        return await readFile(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    readDiff: async (path, since) => {
      try {
        const changes = await changesSince(root, since);
        const change = changes.get(path);
        return change ? `${change.kind} ${change.path}` : null;
      } catch {
        return null;
      }
    },
  });
}

export interface VerifyOptions extends CommonOptions {
  dryRun?: boolean;
  recheck?: boolean;
  /** Overrides the provider default and `MEMBOOK_MODEL`. */
  model?: string;
  /**
   * Manifest path, or `true` for the default `~/.membook/workspace.yaml`.
   * Without it, cross-repo anchors are honestly unresolvable, not errors.
   */
  workspace?: string | true;
}

export async function verify(options: VerifyOptions): Promise<void> {
  const log = out(options);

  if (!(await isGitRepository(options.root))) {
    die(
      "Not a git repository.",
      "Verification diffs anchors against HEAD, so it needs one."
    );
  }

  const membook = new Membook(options.root, { instrumentation: true });

  const workspace = await resolveWorkspaceFlag(options.workspace);

  let rechecker: AnchorRechecker | null = null;
  if (options.recheck) {
    rechecker = recheckerFromEnv(
      options.root,
      membook.instrumentation,
      options.model
    );
    if (!rechecker) {
      die(
        "No model configured for re-checking.",
        "Set ANTHROPIC_API_KEY or OPENAI_API_KEY. Without one, drifted memories stay stale rather than being assumed true."
      );
    }
  }

  const report = await membook.verify({
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(rechecker ? { rechecker } : {}),
    ...(workspace ? { workspace } : {}),
  });

  // Never folded into "nothing changed": a memory the pass could not reach
  // is a different fact from one it checked and found sound, and the member
  // name is the actionable part — it says which checkout this machine lacks.
  const unreached = [...report.changed, ...report.unchanged].filter((v) =>
    v.outcomes.some((o) => o.kind === "unresolvable")
  );

  // A memory re-checked and returned `still-stale` did not change status, so
  // it lands in `unchanged`. Reporting that as "nothing changed" would fold
  // "we asked and were told no" together with "we never asked" — different
  // facts about how much is actually known.
  const rechecked = [...report.changed, ...report.unchanged].filter(
    (v) => v.rechecked
  );

  log("");

  if (unreached.length > 0) {
    const members = [
      ...new Set(
        unreached.flatMap((v) =>
          v.outcomes
            .filter((o) => o.kind === "unresolvable")
            .map((o) => o.member ?? "?")
        )
      ),
    ];
    log(
      warn(
        `${unreached.length} ${plural(
          unreached.length,
          "memory reaches",
          "memories reach"
        )} into ${plural(
          members.length,
          "a repository",
          "repositories"
        )} this machine cannot check (${members.join(", ")}).`
      )
    );
    log(
      dim(
        options.workspace === undefined
          ? "  membook verify --workspace   resolve them via ~/.membook/workspace.yaml"
          : "  Their statuses were left untouched — not confirmed, not doubted."
      )
    );
    log("");
  }

  if (report.changed.length === 0 && rechecked.length === 0) {
    log(
      ok(
        `Checked ${report.checked} against ${report.head.slice(
          0,
          7
        )} — nothing changed.`
      )
    );
    log("");
    return;
  }

  if (rechecked.length > 0) {
    log(
      heading(
        `${rechecked.length} re-checked against ${report.head.slice(0, 7)}`
      )
    );
    for (const v of rechecked) {
      const verdict =
        v.to === v.from
          ? `${statusLabel(v.to)} ${dim("(unchanged)")}`
          : `${statusLabel(v.from)} → ${statusLabel(v.to)}`;
      log(`  ${v.id}  ${verdict}`);
      log(wrap(v.reason, 74, "        "));
    }
    log("");

    // Every re-check failing with the SAME message is a configuration
    // problem, not a flaky call — and saying so is what stops a person
    // retrying in hope. Four identical runs in five minutes happened here
    // before the telemetry made the cause visible.
    const failures = rechecked.filter((v) =>
      v.reason.includes("could not run")
    );
    if (failures.length === rechecked.length && failures.length > 1) {
      const first = failures[0]!.reason;
      const identical = failures.every((v) => v.reason === first);
      if (identical) {
        log(
          warn(
            `All ${failures.length} re-checks failed with the same error. That is a configuration problem, not a transient one — retrying will not change it.`
          )
        );
        log(
          dim(
            "  Check the model name (--model), the API key, and OPENAI_BASE_URL if you are pointing at a local server."
          )
        );
        log("");
      }
    }
  }

  if (report.changed.length === 0) {
    log(dim("  No status changed."));
    log("");
    return;
  }

  log(
    heading(
      `${report.changed.length} of ${
        report.checked
      } changed at ${report.head.slice(0, 7)}`
    )
  );
  log("");
  for (const v of report.changed) {
    log(`  ${v.id}  ${statusLabel(v.from)} → ${statusLabel(v.to)}`);
    log(wrap(v.reason, 74, "        "));
  }
  log("");

  if (options.dryRun) {
    log(dim("  Nothing was written. Run without --dry-run to apply."));
  } else {
    const stale = report.byStatus.stale;
    if (stale > 0 && !options.recheck) {
      log(
        wrap(
          `${stale} ${plural(
            stale,
            "memory is",
            "memories are"
          )} stale and cannot be restored without a re-check — the absence of further change is not evidence that ${plural(
            stale,
            "it still holds",
            "they still hold"
          )}.`
        )
      );
      log(
        dim("  membook verify --recheck   ask a model, with a key configured")
      );
    }
    log(dim("  membook book               regenerate MEMBOOK.md"));
  }
  log("");
}

export interface RememberOptions extends CommonOptions {
  statement: string;
  type: MemoryType;
  paths: string[];
  scope?: "repo" | "user";
  symbol?: string;
  confidence?: number;
  now?: () => Date;
}

/**
 * A memory written by a PERSON.
 *
 * This is the first real exercise of the human branch of the provenance
 * schema: `author: human`, with `agent` and `model` structurally absent
 * because a person at a terminal has neither. The schema makes inventing
 * them impossible rather than merely discouraged.
 */
export async function remember(options: RememberOptions): Promise<void> {
  const log = out(options);
  const now = options.now ?? (() => new Date());

  if (options.scope === "user") {
    // A preference follows the human, not a repository: no git required, no
    // anchors possible. If you have a file to point at, it is not a
    // preference — it is repo knowledge wearing the wrong scope.
    if (options.paths.length > 0 || options.symbol !== undefined) {
      die(
        "A user-scope memory cannot carry anchors.",
        "If it is about specific files, it is repo knowledge: record it without --scope user."
      );
    }
    const store = new UserStore(undefined, { guards: [new SecretScanGuard()] });
    try {
      const stored = await store.remember({
        statement: options.statement,
        type: options.type,
        ...(options.confidence !== undefined
          ? { confidence: options.confidence }
          : {}),
        now,
      });
      log("");
      log(ok(`Recorded ${stored.id} (${options.type}, user scope).`));
      log(dim(`  ${stored.path}`));
      log(
        dim(
          "  It follows you, not this repository: recalled in every session, never committed."
        )
      );
      log("");
    } catch (error) {
      log("");
      log(bad("Not recorded."));
      log(wrap((error as Error).message, 76, "  "));
      log("");
      process.exitCode = 1;
    }
    return;
  }

  if (!(await isGitRepository(options.root))) {
    die(
      "Not a git repository.",
      "Memories are anchored to a commit, so one is needed."
    );
  }

  const membook = new Membook(options.root, {
    guards: [new SecretScanGuard()],
    instrumentation: true,
  });

  const commit = await headSha(options.root);

  // A memory anchored to a path absent from its own commit can never be
  // verified; the usual cause is a file that has not been committed yet.
  const missing = await findMissingAnchorPaths(
    options.root,
    commit,
    options.paths
  );
  if (missing.length > 0) {
    die(
      `${missing.join(", ")} ${
        missing.length === 1 ? "does" : "do"
      } not exist at HEAD (${commit.slice(0, 7)}).`,
      "Commit the file first, or anchor to a path that is already committed — a memory anchored to an uncommitted file cannot be verified."
    );
  }
  const id = await membook.store.allocateId(options.statement);

  const frontmatter: MemoryInput = {
    memfile: MEMFILE_SPEC_VERSION,
    id,
    type: options.type,
    status: "unverified",
    scope: "repo",
    confidence: options.confidence ?? 0.9,
    created: `${now().toISOString().slice(0, 19)}Z`,
    anchors: options.paths.map((path, i) => ({
      path,
      ...(options.symbol !== undefined && i === 0
        ? { symbol: options.symbol }
        : {}),
      commit,
    })),
    provenance: { origin: "authored", author: "human" },
  };

  try {
    const stored = await membook.remember(frontmatter, options.statement);
    log("");
    log(
      ok(`Recorded ${stored.id} (${options.type}) at ${commit.slice(0, 7)}.`)
    );
    log(dim(`  .membook/memories/${stored.file}`));
    log(
      dim(
        "  Status is unverified — nothing has checked it against the code yet."
      )
    );
    log("");
  } catch (error) {
    log("");
    log(bad("Not recorded."));
    log(wrap((error as Error).message, 76, "  "));
    log("");
    process.exitCode = 1;
  }
}
