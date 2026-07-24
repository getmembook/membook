import type { Anchor, GitAnchor } from "./schema.js";
import { anchorSchema } from "./schema.js";
import { MemfileValidationError } from "./errors.js";

/**
 * Compact string form of an anchor, for CLI output, logs, and docs:
 *
 *   git:<path>[#<symbol>][:L<start>[-<end>]]@<commit>
 *
 * Examples:
 *   git:packages/core/src/store.ts@0123456789abcdef0123456789abcdef01234567
 *   git:src/auth.ts#refreshToken:L42-60@0123456789abcdef0123456789abcdef01234567
 *
 * The structured YAML form in frontmatter is canonical. The string form is
 * lossless for it but reserves `#` in paths and requires the commit to be
 * the final `@`-suffixed field.
 */
const ANCHOR_RE =
  /^git:(?<path>.+?)(?:#(?<symbol>[^#@]+?))?(?::L(?<start>\d+)(?:-(?<end>\d+))?)?@(?<commit>[0-9a-f]{40})$/;

export function formatAnchor(anchor: Anchor): string {
  const a: GitAnchor = anchor;
  let s = `git:${a.path}`;
  if (a.symbol !== undefined) s += `#${a.symbol}`;
  if (a.line_range !== undefined) {
    const [start, end] = a.line_range;
    s += start === end ? `:L${start}` : `:L${start}-${end}`;
  }
  return `${s}@${a.commit}`;
}

export function parseAnchor(input: string): Anchor {
  const match = ANCHOR_RE.exec(input);
  if (!match?.groups) {
    throw new MemfileValidationError([
      `unparseable anchor "${input}" — expected git:<path>[#<symbol>][:L<start>[-<end>]]@<40-hex commit>`,
    ]);
  }
  const { path, symbol, start, end, commit } = match.groups;
  const candidate = {
    kind: "git" as const,
    path,
    ...(symbol !== undefined ? { symbol } : {}),
    ...(start !== undefined
      ? {
          line_range: [Number(start), Number(end ?? start)] as [number, number],
        }
      : {}),
    commit,
  };
  const result = anchorSchema.safeParse(candidate);
  if (!result.success) {
    throw MemfileValidationError.fromZodError(result.error);
  }
  return result.data;
}
