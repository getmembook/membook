import pc from "picocolors";
import type { MemoryStatus } from "@membook/spec";

/**
 * The CLI is the HUMAN's surface, where the MCP server is the agent's.
 *
 * The honesty distinctions the engine enforces internally have to survive
 * being said out loud here — "we know nothing" and "we know something we no
 * longer trust" must read as different sentences, not different integers.
 */

export const STATUS_COLOUR: Record<MemoryStatus, (s: string) => string> = {
  verified: pc.green,
  unverified: pc.yellow,
  stale: pc.magenta,
  invalidated: pc.red,
};

/** How each status is explained to a person, not merely named. */
export const STATUS_MEANING: Record<MemoryStatus, string> = {
  verified: "checked against the current code",
  unverified: "not checked yet",
  stale: "the code it describes has changed",
  invalidated: "the code it describes is gone",
};

export function statusLabel(status: MemoryStatus): string {
  return STATUS_COLOUR[status](status);
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function heading(text: string): string {
  return pc.bold(text);
}

export function dim(text: string): string {
  return pc.dim(text);
}

/** Wrap prose so long explanations do not run off a narrow terminal. */
export function wrap(text: string, width = 76, indent = ""): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width - indent.length)
      line += ` ${word}`;
    else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(indent + line);
  return lines.join("\n");
}

export function ok(text: string): string {
  return `${pc.green("✓")} ${text}`;
}

export function warn(text: string): string {
  return `${pc.yellow("!")} ${text}`;
}

export function bad(text: string): string {
  return `${pc.red("✗")} ${text}`;
}

/**
 * Fail with an actionable message rather than a stack trace.
 *
 * A CLI error is read by a person who wants to know what to do next, so it
 * says that, and exits non-zero so scripts can tell.
 */
export function die(message: string, hint?: string): never {
  process.stderr.write(`${bad(message)}\n`);
  if (hint) process.stderr.write(`${dim(`  ${hint}`)}\n`);
  process.exit(1);
}
