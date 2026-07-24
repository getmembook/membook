import { execa, ExecaError } from "execa";

/**
 * Plain `git` CLI via execa — no libgit2 bindings, no isomorphic-git.
 *
 * Rename detection is the reason. The stale-vs-invalidated distinction
 * depends on knowing that a file moved rather than vanished, and no pure-JS
 * implementation reproduces git's similarity heuristics.
 */

export class GitError extends Error {
  readonly command: string;
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(command: string, cause: ExecaError) {
    super(`git ${command} failed: ${cause.stderr || cause.message}`);
    this.name = "GitError";
    this.command = command;
    this.exitCode =
      typeof cause.exitCode === "number" ? cause.exitCode : undefined;
    this.stderr = String(cause.stderr ?? "");
  }
}

export class NotAGitRepositoryError extends Error {
  constructor(cwd: string) {
    super(
      `${cwd} is not a git repository. Membook anchors memories to commits, so it needs one.`
    );
    this.name = "NotAGitRepositoryError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execa("git", args, {
      cwd,
      stripFinalNewline: true,
    });
    return stdout;
  } catch (error) {
    throw new GitError(args.join(" "), error as ExecaError);
  }
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** Full 40-char SHA of HEAD. Throws if the repo has no commits yet. */
export async function headSha(cwd: string): Promise<string> {
  if (!(await isGitRepository(cwd))) throw new NotAGitRepositoryError(cwd);
  return git(cwd, ["rev-parse", "HEAD"]);
}

export async function commitExists(cwd: string, sha: string): Promise<boolean> {
  try {
    const type = await git(cwd, ["cat-file", "-t", sha]);
    return type === "commit";
  } catch {
    return false;
  }
}

export type ChangeKind = "modified" | "added" | "deleted" | "renamed";

export interface PathChange {
  kind: ChangeKind;
  /** Path as of the base commit. */
  path: string;
  /** Where it moved to. Only set for renames. */
  renamedTo?: string;
  /** Rename similarity, 0–100. Only set for renames. */
  similarity?: number;
}

/**
 * `git diff --name-status` between a commit and HEAD, with rename detection.
 *
 * Returns a map keyed by the path AS OF THE BASE COMMIT, which is the side an
 * anchor holds. Renames therefore resolve without a second lookup.
 */
export async function changesSince(
  cwd: string,
  base: string,
  head = "HEAD"
): Promise<Map<string, PathChange>> {
  const raw = await git(cwd, [
    "diff",
    "--name-status",
    // Detect renames, and follow them even when the file was also edited.
    "--find-renames",
    "-z",
    `${base}..${head}`,
  ]);

  const changes = new Map<string, PathChange>();
  if (raw.length === 0) return changes;

  // -z output is NUL-separated. Renames occupy three fields (status, old,
  // new); everything else occupies two. Parsing the NUL form rather than the
  // line form is deliberate: paths may contain newlines, and git would
  // otherwise quote-escape them into something we would have to unescape.
  const fields = raw.split("\0").filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; ) {
    const status = fields[i]!;
    const code = status[0]!;

    if (code === "R") {
      const from = fields[i + 1]!;
      const to = fields[i + 2]!;
      const similarity = Number(status.slice(1));
      changes.set(from, {
        kind: "renamed",
        path: from,
        renamedTo: to,
        ...(Number.isFinite(similarity) && similarity > 0
          ? { similarity }
          : {}),
      });
      i += 3;
      continue;
    }

    const path = fields[i + 1]!;
    const kind: ChangeKind =
      code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    changes.set(path, { kind, path });
    i += 2;
  }

  return changes;
}

/** True if the path exists in the given tree. */
/**
 * Reject anchors pointing at paths that do not exist at their own commit.
 *
 * This is the most common way to create a broken memory, and it is invisible
 * at the moment it happens: an agent creates a file, records a memory about
 * it, and anchors to HEAD — where the file does not exist yet, because it has
 * not been committed. The memory is born unverifiable, and the next verify
 * pass reports it as such long after the session that caused it has ended.
 *
 * Refusing at write time turns a silent future failure into an immediate,
 * actionable one.
 */
export async function findMissingAnchorPaths(
  cwd: string,
  commit: string,
  paths: readonly string[]
): Promise<string[]> {
  const missing: string[] = [];
  for (const path of paths) {
    if (!(await pathExistsAt(cwd, commit, path))) missing.push(path);
  }
  return missing;
}

export async function pathExistsAt(
  cwd: string,
  sha: string,
  path: string
): Promise<boolean> {
  try {
    await git(cwd, ["cat-file", "-e", `${sha}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/** File contents at a commit, or null when the path is absent there. */
export async function showFile(
  cwd: string,
  sha: string,
  path: string
): Promise<string | null> {
  try {
    return await git(cwd, ["show", `${sha}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * Trace a path back through renames with `log --follow`.
 *
 * `changesSince` already resolves renames for the common case. This is the
 * fallback for the case it cannot see: a file renamed and then deleted, where
 * the diff reports only a deletion at the original path.
 */
export async function followRename(
  cwd: string,
  base: string,
  path: string,
  head = "HEAD"
): Promise<string | null> {
  let raw: string;
  try {
    raw = await git(cwd, [
      "log",
      "--follow",
      "--name-status",
      "--find-renames",
      "--format=%H",
      "-z",
      `${base}..${head}`,
      "--",
      path,
    ]);
  } catch {
    return null;
  }

  // Walk newest-first; the first rename whose source side is the path we are
  // tracking gives its current name.
  const fields = raw.split("\0").filter((f) => f.length > 0);
  let current = path;
  for (let i = fields.length - 1; i >= 0; i--) {
    const field = fields[i]!;
    if (/^R\d*$/.test(field)) {
      const from = fields[i + 1];
      const to = fields[i + 2];
      if (from === current && to !== undefined) current = to;
    }
  }
  return current === path ? null : current;
}
