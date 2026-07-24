import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryStatus, MemoryType } from "@membook/spec";

/**
 * LOCAL INSTRUMENTATION. NO NETWORK, EVER.
 *
 * This exists to turn the product's claims into numbers the user can check on
 * their own machine — recall hit rates, staleness caught, re-check accuracy.
 * Claims that cannot be falsified locally are marketing, and this file is the
 * difference.
 *
 * It is append-only JSONL because that is the most boring durable format
 * available: greppable, tailable, trivially parsed, and safe to truncate.
 * There is no schema migration story on purpose — this is a log, not a store,
 * and losing it costs nothing.
 */

export interface RecallEvent {
  event: "recall";
  /**
   * The query as asked.
   *
   * Recorded because `query_terms: 3` cannot answer the question this file
   * exists for — whether a memory *would* have helped. This log is local,
   * gitignored, and never leaves the machine, so recording the text is the
   * honest trade for a number that means something.
   *
   * Redacted to `[redacted]` when the query trips the secret scanner: people
   * type credentials into search boxes, and the "never records the secret
   * itself" invariant applies to what is asked as well as what is stored.
   */
  query: string;
  query_terms: number;
  served: number;
  withheld_below_floor: number;
  withheld_by_status: Record<string, number>;
  top_score: number | null;
  context_paths: number;
}

export interface RememberEvent {
  event: "remember";
  id: string;
  type: MemoryType;
  anchors: number;
}

export interface VerifyEvent {
  event: "verify";
  id: string;
  from: MemoryStatus;
  to: MemoryStatus;
  rechecked: boolean;
  outcomes: string[];
}

export interface RecheckEvent {
  event: "recheck";
  id: string;
  verdict: string;
  /** Which re-checker produced it, so accuracy is attributable. */
  checker: string;
  /** Present when the provider had to be asked twice. */
  repaired?: boolean;
  /** Present when it failed and the skeptical default was used instead. */
  failed?: boolean;
  /**
   * Whether a restore cited evidence that actually appears in the anchored
   * code. Only set when a restore was attempted.
   *
   * This — not naive verdict accuracy — is the number worth publishing. The
   * first live read scored 100% on verdicts while citing evidence that did
   * not support them, so a verdict-only metric would have reported a
   * rubber-stamp as a perfect score.
   */
  reason_grounded?: boolean;
}

export interface WriteBlockedEvent {
  event: "write_blocked";
  guard: string;
  rules: string[];
}

export interface BookEvent {
  event: "book";
  carried: number;
  omitted: number;
  excluded: number;
  tokens: number;
}

export type MembookEvent =
  | RecallEvent
  | RememberEvent
  | VerifyEvent
  | RecheckEvent
  | WriteBlockedEvent
  | BookEvent;

export interface Instrumentation {
  record(event: MembookEvent): void;
}

/** Discards everything. The default when no telemetry path is configured. */
export class NullInstrumentation implements Instrumentation {
  record(_event: MembookEvent): void {
    // Intentionally empty.
  }
}

/**
 * Appends one JSON object per line to a local file.
 *
 * Writes are synchronous and best-effort: instrumentation must never break a
 * write, fail a recall, or hold up a session. A failure to log is silently
 * swallowed, which is the one place in this codebase where swallowing an
 * error is correct — the alternative is telemetry taking down the product.
 */
export class FileInstrumentation implements Instrumentation {
  private readonly file: string;
  private readonly now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.now = now;
  }

  record(event: MembookEvent): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const line = JSON.stringify({
        at: `${this.now().toISOString().slice(0, 19)}Z`,
        ...event,
      });
      appendFileSync(this.file, `${line}\n`, "utf8");
    } catch {
      // Never let logging break the thing it is observing.
    }
  }
}
