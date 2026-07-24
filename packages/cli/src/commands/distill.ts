import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DISTILL_SYSTEM,
  Membook,
  SecretScanGuard,
  distill as runDistill,
  headSha,
  isGitRepository,
  pathExistsAt,
  seedFrontmatter,
  type ModelProvider,
} from "@membook/core";
import { providerFromEnv } from "./misc.js";
import { bad, dim, die, heading, ok, plural, wrap } from "../output.js";

export interface DistillOptions {
  root: string;
  log?: (line: string) => void;
  /** File of session notes. Reads stdin when omitted. */
  file?: string;
  dryRun?: boolean;
  model?: string;
  provider?: ModelProvider;
  now?: () => Date;
  /** Injected in tests, so stdin does not have to be simulated. */
  readInput?: () => Promise<string>;
}

/** Below this there is no session to distill, only a sentence. */
const MIN_NOTES_CHARS = 120;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Turn notes from a working session into candidate memories.
 *
 * This is the write side of the volition problem. Recording a memory through
 * `remember` asks an agent to notice it learned something, decide it is
 * durable, phrase it well, and choose anchors — four judgements, at the moment
 * it is busy finishing a task. Measured on a real repository, that produced
 * zero memories across two sessions.
 *
 * Distillation moves the bar to "say what happened" and does the four
 * judgements here, where rejection is the default and every candidate must
 * still survive grounding, the secret scan, and a human in `review`.
 *
 * Explicitly NOT passive capture, which is out of scope for v0.1: something
 * has to hand the notes over deliberately.
 */
export async function distill(options: DistillOptions): Promise<void> {
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
      "Distillation needs a model, and no API key is configured.",
      "Set ANTHROPIC_API_KEY or OPENAI_API_KEY and run this again."
    );
    return;
  }

  const notes = options.readInput
    ? await options.readInput()
    : options.file !== undefined
    ? await readFile(resolve(options.root, options.file), "utf8")
    : await readStdin();

  if (notes.trim().length < MIN_NOTES_CHARS) {
    die(
      "Nothing to distill.",
      options.file === undefined
        ? "Pipe session notes in, or pass a file: membook distill notes.md"
        : `${options.file} is too short to contain a memory.`
    );
    return;
  }

  const membook = new Membook(options.root, {
    guards: [new SecretScanGuard()],
    instrumentation: true,
  });

  const { memories } = await membook.store.readAll();
  const head = await headSha(options.root);

  log("");
  log(heading("Distilling the session"));

  const result = await runDistill(
    // The notes are not a repo file, so there is no source path to anchor to.
    // Every anchor must therefore come from the model and survive grounding —
    // there is no fallback, and a candidate citing nothing real is discarded.
    { path: "(session notes)", content: notes },
    DISTILL_SYSTEM,
    {
      provider,
      instrumentation: membook.instrumentation,
      existing: memories.map((m) => m.memfile.body),
      pathExists: async (path) => {
        const normalised = path.replace(/^\.\//, "");
        if (normalised.startsWith("/") || normalised.includes("..")) {
          return false;
        }
        return pathExistsAt(options.root, head, normalised);
      },
    }
  );

  log("");

  if (result.failed) {
    log(bad("The model did not return anything usable."));
    log("");
    log(
      wrap(
        "Nothing was written. A failed distillation costs you nothing — there is no safe way to guess a memory."
      )
    );
    log("");
    return;
  }

  if (result.candidates.length === 0) {
    log(ok("Nothing worth recording from this session."));
    log("");
    log(
      wrap(
        "Rejection is the default. Most of a session is what was tried and what an error said, and none of that is worth carrying into the next one."
      )
    );
    if (result.rejected.length > 0) {
      log("");
      log(dim(summarise(result.rejected)));
    }
    log("");
    return;
  }

  log(
    heading(
      `${result.candidates.length} candidate ${plural(
        result.candidates.length,
        "memory",
        "memories"
      )}`
    )
  );
  log("");

  for (const candidate of result.candidates) {
    log(`  ${candidate.type}  ${dim(candidate.paths.join(", "))}`);
    log(wrap(candidate.statement, 74, "    "));
    log("");
  }

  if (result.rejected.length > 0) {
    log(dim(summarise(result.rejected)));
    log("");
  }

  if (options.dryRun) {
    log(dim("Dry run: nothing was written."));
    log("");
    return;
  }

  const timestamp = `${now().toISOString().slice(0, 19)}Z`;
  let written = 0;
  const blocked: string[] = [];

  for (const candidate of result.candidates) {
    try {
      const id = await membook.store.allocateId(candidate.statement);
      await membook.remember(
        seedFrontmatter(
          {
            ...candidate,
            source: "(session notes)",
            sourceHash: result.sourceHash,
          },
          { id, commit: head, timestamp, model: provider.model }
        ),
        candidate.statement
      );
      written += 1;
    } catch (error) {
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
    log(bad(`${blocked.length} refused at the write: ${blocked[0]}`));
  }
  log("");
  log(dim("  membook review   ratify or delete each one"));
  log("");
}

function summarise(rejected: readonly { reason: string }[]): string {
  const describe: Record<string, string> = {
    "ungrounded-anchor": "cited a file that does not exist",
    secret: "contained a credential",
    duplicate: "already recorded",
    malformed: "was not well formed",
  };
  const byReason = new Map<string, number>();
  for (const r of rejected)
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  return (
    `Discarded ${rejected.length}: ` +
    [...byReason.entries()]
      .map(([reason, n]) => `${n} ${describe[reason] ?? reason}`)
      .join(", ") +
    "."
  );
}
