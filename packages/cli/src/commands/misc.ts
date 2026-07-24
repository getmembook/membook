import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryInput, MemoryType } from "@membook/spec";
import {
  AnthropicProvider,
  LlmRechecker,
  Membook,
  OpenAiCompatibleProvider,
  SecretScanGuard,
  changesSince,
  headSha,
  isGitRepository,
  type AnchorRechecker,
  type ModelProvider,
  type Instrumentation,
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

export async function book(options: CommonOptions): Promise<void> {
  const log = out(options);
  const membook = new Membook(options.root);
  const report = await membook.writeBook();

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
  if (report.omitted > 0) {
    log(dim(`  ${report.omitted} did not fit under the token budget.`));
  }
  log("");
}

/** Build a re-checker from the environment, or explain why it cannot. */
export function recheckerFromEnv(
  root: string,
  instrumentation?: Instrumentation
): AnchorRechecker | null {
  let provider: ModelProvider | null = null;

  if (process.env["ANTHROPIC_API_KEY"]) {
    provider = new AnthropicProvider({
      apiKey: process.env["ANTHROPIC_API_KEY"],
      ...(process.env["MEMBOOK_MODEL"]
        ? { model: process.env["MEMBOOK_MODEL"] }
        : {}),
    });
  } else if (process.env["OPENAI_API_KEY"]) {
    provider = new OpenAiCompatibleProvider({
      apiKey: process.env["OPENAI_API_KEY"],
      ...(process.env["MEMBOOK_MODEL"]
        ? { model: process.env["MEMBOOK_MODEL"] }
        : {}),
      ...(process.env["OPENAI_BASE_URL"]
        ? { baseUrl: process.env["OPENAI_BASE_URL"] }
        : {}),
    });
  }

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

  let rechecker: AnchorRechecker | null = null;
  if (options.recheck) {
    rechecker = recheckerFromEnv(options.root, membook.instrumentation);
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
  });

  // A memory re-checked and returned `still-stale` did not change status, so
  // it lands in `unchanged`. Reporting that as "nothing changed" would fold
  // "we asked and were told no" together with "we never asked" — different
  // facts about how much is actually known.
  const rechecked = [...report.changed, ...report.unchanged].filter(
    (v) => v.rechecked
  );

  log("");
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
  const id = await membook.store.allocateId(options.statement);

  const frontmatter: MemoryInput = {
    memfile: 1,
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
