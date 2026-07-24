import type { MemoryStatus } from "@membook/spec";
import { Membook, isGitRepository } from "@membook/core";
import {
  STATUS_MEANING,
  dim,
  heading,
  ok,
  plural,
  statusLabel,
  warn,
  wrap,
} from "../output.js";

export interface StatusOptions {
  root: string;
  /** Also diff anchors against HEAD without writing. */
  check?: boolean;
  log?: (line: string) => void;
}

const ORDER: MemoryStatus[] = [
  "verified",
  "unverified",
  "stale",
  "invalidated",
];

/**
 * What is known, and how far to trust it.
 *
 * The counts are the easy part. The wording is the point: a person must be
 * able to tell "nothing is recorded" from "things are recorded but drifted",
 * because those call for opposite responses — write something, versus go and
 * re-check what you already wrote.
 */
export async function status(options: StatusOptions): Promise<void> {
  const log =
    options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const membook = new Membook(options.root);
  const report = await membook.status();

  log("");

  if (report.onDisk === 0) {
    log(heading("No memories recorded yet."));
    log("");
    log(
      wrap(
        "Nothing has been written for this repository. Connect an agent over MCP and it will record what it learns, or write one yourself with `membook remember`."
      )
    );
    log("");
    return;
  }

  log(
    heading(
      `${report.onDisk} ${plural(
        report.onDisk,
        "memory",
        "memories"
      )} in this repository`
    )
  );
  log("");

  for (const s of ORDER) {
    const n = report.byStatus[s] ?? 0;
    if (n === 0) continue;
    log(
      `  ${String(n).padStart(3)}  ${statusLabel(s).padEnd(20)} ${dim(
        STATUS_MEANING[s]
      )}`
    );
  }
  log("");

  if (report.needsNewerMembook.length > 0) {
    const n = report.needsNewerMembook.length;
    log(
      warn(
        `${n} ${plural(n, "file needs", "files need")} a newer Membook: ` +
          report.needsNewerMembook
            .map((f) => `${f.file} (v${f.found})`)
            .join(", ")
      )
    );
    log(
      dim(
        `  This Membook reads up to v${
          report.needsNewerMembook[0]!.supported
        }. The files are not damaged — upgrade rather than editing them.`
      )
    );
    log("");
  }

  const stale = report.byStatus["stale"] ?? 0;
  const invalid = report.byStatus["invalidated"] ?? 0;
  const unverified = report.byStatus["unverified"] ?? 0;

  // Each of these is a different call to action, so each gets its own line
  // rather than being folded into a single "needs attention" number.
  if (stale > 0) {
    log(
      wrap(
        `${stale} ${plural(
          stale,
          "memory has",
          "memories have"
        )} drifted: the code changed and nothing has confirmed ${plural(
          stale,
          "it",
          "them"
        )} since. ${plural(
          stale,
          "It is",
          "They are"
        )} withheld from MEMBOOK.md rather than asserted.`
      )
    );
    log(
      dim("  membook verify --recheck   ask a model whether they still hold")
    );
    log("");
  }

  if (invalid > 0) {
    log(
      wrap(
        `${invalid} ${plural(
          invalid,
          "memory describes",
          "memories describe"
        )} code that no longer exists.`
      )
    );
    log(dim("  membook review             decide whether to keep or delete"));
    log("");
  }

  if (unverified > 0) {
    log(
      wrap(
        `${unverified} ${plural(
          unverified,
          "memory has",
          "memories have"
        )} never been checked against the code. That is the honest state of anything just written — not a problem, just not yet proven.`
      )
    );
    log("");
  }

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
        )} left in place, unread:`
      )
    );
    for (const q of report.quarantined) {
      log(`    ${q.file}  ${dim(q.issues[0] ?? "")}`);
    }
    log(dim("  Repair the file, or delete it. Nothing was thrown away."));
    log("");
  }

  if (report.indexed !== report.onDisk) {
    log(
      warn(
        `The index is out of step with the files (${report.indexed} indexed, ${report.onDisk} on disk).`
      )
    );
    log(dim("  membook reindex            rebuild it from the files"));
    log("");
  }

  if (options.check) {
    if (!(await isGitRepository(options.root))) {
      log(warn("Not a git repository, so anchors cannot be checked."));
      log("");
      return;
    }
    const verify = await membook.verify({ dryRun: true });
    if (verify.changed.length === 0) {
      log(
        ok(
          `Anchors checked against ${verify.head.slice(
            0,
            7
          )} — nothing has drifted.`
        )
      );
    } else {
      log(
        heading(
          `Checked against ${verify.head.slice(0, 7)}: ${
            verify.changed.length
          } would change`
        )
      );
      for (const v of verify.changed) {
        log(`  ${v.id}  ${statusLabel(v.from)} → ${statusLabel(v.to)}`);
        log(dim(`        ${v.reason}`));
      }
      log("");
      log(dim("  Nothing was written. Run `membook verify` to apply."));
    }
    log("");
  }
}
