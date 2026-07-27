import type { Anchor } from "./schema.js";
import { anchorSchema } from "./schema.js";
import { MemfileValidationError } from "./errors.js";

/**
 * Compact string form of an anchor, for CLI output, logs, and docs:
 *
 *   git:<path>[#<symbol>][:L<start>[-<end>]]@<commit>
 *   xgit:<repo>/<path>[#<symbol>][:L<start>[-<end>]]@<commit>
 *
 * Examples:
 *   git:packages/core/src/store.ts@0123456789abcdef0123456789abcdef01234567
 *   git:src/auth.ts#refreshToken:L42-60@0123456789abcdef0123456789abcdef01234567
 *   xgit:platform-gateway/config/limits.yaml@0123456789abcdef0123456789abcdef01234567
 *
 * The structured YAML form in frontmatter is canonical. The string form is
 * lossless for it but reserves `#` in paths and requires the commit to be
 * the final `@`-suffixed field. The xgit form splits repo from path at the
 * FIRST `/`, which is unambiguous because member names cannot contain one.
 */
const TAIL =
  /(?:#(?<symbol>[^#@]+?))?(?::L(?<start>\d+)(?:-(?<end>\d+))?)?@(?<commit>[0-9a-f]{40})$/
    .source;

const GIT_ANCHOR_RE = new RegExp(`^git:(?<path>.+?)${TAIL}`);
const XGIT_ANCHOR_RE = new RegExp(`^xgit:(?<repo>[^/]+?)/(?<path>.+?)${TAIL}`);

export function formatAnchor(anchor: Anchor): string {
  let s =
    anchor.kind === "xgit"
      ? `xgit:${anchor.repo}/${anchor.path}`
      : `git:${anchor.path}`;
  if (anchor.symbol !== undefined) s += `#${anchor.symbol}`;
  if (anchor.line_range !== undefined) {
    const [start, end] = anchor.line_range;
    s += start === end ? `:L${start}` : `:L${start}-${end}`;
  }
  return `${s}@${anchor.commit}`;
}

export function parseAnchor(input: string): Anchor {
  const xgit = input.startsWith("xgit:");
  const match = (xgit ? XGIT_ANCHOR_RE : GIT_ANCHOR_RE).exec(input);
  if (!match?.groups) {
    throw new MemfileValidationError([
      `unparseable anchor "${input}" — expected ` +
        (xgit
          ? "xgit:<repo>/<path>[#<symbol>][:L<start>[-<end>]]@<40-hex commit>"
          : "git:<path>[#<symbol>][:L<start>[-<end>]]@<40-hex commit>"),
    ]);
  }
  const { repo, path, symbol, start, end, commit } = match.groups;
  const candidate = {
    ...(xgit ? { kind: "xgit" as const, repo } : { kind: "git" as const }),
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
