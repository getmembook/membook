import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { MemoryStatus } from "@membook/spec";
import {
  Membook,
  headSha,
  isGitRepository,
  type StoredMemory,
} from "@membook/core";
import {
  STATUS_MEANING,
  dim,
  heading,
  ok,
  plural,
  statusLabel,
  wrap,
} from "../output.js";

/**
 * THE HUMAN RATIFICATION SURFACE.
 *
 * Everything else in Membook is a machine deciding what it can prove. This is
 * the one place a person says "I have read this and it is true" — and the
 * provenance format was built to keep that claim distinguishable from an
 * agent's assertion.
 *
 * Ratifying sets the anchor commits to HEAD and the status to `verified`,
 * because a human reading the code and confirming the statement IS a
 * verification — the strongest kind available. Rejecting deletes the file:
 * a memory nobody will stand behind should not be served to anyone.
 */

const NEEDS_REVIEW: MemoryStatus[] = ["unverified", "stale", "invalidated"];

export interface ReviewOptions {
  root: string;
  /** Print what needs review and exit, without prompting. */
  list?: boolean;
  log?: (line: string) => void;
  /** Injected in tests instead of reading a terminal. */
  ask?: (question: string) => Promise<string>;
  now?: () => Date;
}

function describe(memory: StoredMemory): string[] {
  const fm = memory.memfile.frontmatter;
  const anchors = fm.anchors
    .map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path))
    .join(", ");
  const author =
    fm.provenance.origin === "distilled"
      ? `distilled by ${fm.provenance.agent}`
      : fm.provenance.author === "human"
      ? "written by a human"
      : `written by ${fm.provenance.agent}`;

  return [
    `${statusLabel(fm.status)}  ${dim(STATUS_MEANING[fm.status])}`,
    "",
    wrap(memory.memfile.body, 76, "  "),
    "",
    dim(`  ${anchors}`),
    dim(`  ${fm.type}, ${author}, recorded ${fm.created.slice(0, 10)}`),
  ];
}

export async function review(options: ReviewOptions): Promise<void> {
  const log =
    options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const membook = new Membook(options.root, { instrumentation: true });
  const { memories } = await membook.store.readAll();

  const pending = memories.filter((m) =>
    NEEDS_REVIEW.includes(m.memfile.frontmatter.status)
  );

  log("");
  if (pending.length === 0) {
    log(ok("Nothing is waiting for review."));
    log("");
    return;
  }

  log(
    heading(
      `${pending.length} ${plural(
        pending.length,
        "memory needs",
        "memories need"
      )} a human decision`
    )
  );
  log("");

  if (options.list) {
    for (const memory of pending) {
      log(`${memory.memfile.frontmatter.id}  ${describe(memory)[0]}`);
      log(wrap(memory.memfile.body.split("\n")[0] ?? "", 76, "    "));
      log("");
    }
    log(dim("Run `membook review` without --list to decide on each."));
    log("");
    return;
  }

  /**
   * The reader is created LAZILY, on the first prompt.
   *
   * Created up front, it starts consuming stdin immediately — and the async
   * setup below (reading every memory, resolving HEAD) is long enough for
   * piped input to drain and close before the first question is ever asked.
   * The answer is then silently lost, which is worse than an error.
   */
  // Held in an object because the assignment happens inside the closure
  // below, which control-flow analysis cannot see — a plain `let` would be
  // narrowed to `null` by the time it is closed.
  const reader: { rl: ReturnType<typeof createInterface> | null } = {
    rl: null,
  };

  const ask =
    options.ask ??
    (async (question: string): Promise<string> => {
      reader.rl ??= createInterface({ input: stdin, output: stdout });
      try {
        return (await reader.rl.question(question)).trim().toLowerCase();
      } catch {
        // Input ended — piped stdin ran out, or a terminal got Ctrl-D. That
        // is a person saying "no more", not a crash.
        return "q";
      }
    });

  const head = (await isGitRepository(options.root))
    ? await headSha(options.root)
    : null;
  let ratified = 0;
  let rejected = 0;

  try {
    for (const memory of pending) {
      const fm = memory.memfile.frontmatter;
      log(heading(fm.id));
      for (const line of describe(memory)) log(line);
      log("");

      const answer = await ask(
        "  [k]eep and ratify · [d]elete · [s]kip · [q]uit  > "
      );

      if (answer === "q" || answer === "quit") break;

      if (answer === "d" || answer === "delete") {
        // Recorded BEFORE the delete: afterwards the memory is gone from disk
        // and its status — the thing that makes the label worth having — is
        // unrecoverable.
        membook.instrumentation.record({
          event: "review",
          id: fm.id,
          action: "delete",
          from: fm.status,
        });
        await membook.forget(fm.id);
        rejected += 1;
        log(ok(`Deleted ${fm.id}.`));
        log("");
        continue;
      }

      if (answer === "k" || answer === "keep") {
        if (head === null) {
          log(
            dim(
              "  Not a git repository, so this cannot be anchored to a commit. Skipped."
            )
          );
          log("");
          continue;
        }
        // A human has read it and stands behind it: that is a verification,
        // recorded at the commit they read.
        await membook.remember(
          {
            ...fm,
            status: "verified",
            verified: `${now().toISOString().slice(0, 19)}Z`,
            anchors: fm.anchors.map((a) => ({ ...a, commit: head })),
          },
          memory.memfile.body
        );
        membook.instrumentation.record({
          event: "review",
          id: fm.id,
          action: "ratify",
          from: fm.status,
        });
        ratified += 1;
        log(ok(`Ratified ${fm.id} at ${head.slice(0, 7)}.`));
        log("");
        continue;
      }

      log(dim("  Skipped."));
      log("");
    }
  } finally {
    reader.rl?.close();
  }

  log(
    heading(
      `${ratified} ratified, ${rejected} deleted, ${
        pending.length - ratified - rejected
      } left for later.`
    )
  );
  if (ratified > 0 || rejected > 0) {
    log(
      dim("  Regenerate the book with `membook book`, then commit the change.")
    );
  }
  log("");
}
