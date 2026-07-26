import { z } from "zod";
import { parse as parseYaml } from "yaml";

/**
 * THE WORKSPACE MANIFEST — a resolution table, not a database.
 *
 * It maps stable member names to the git checkouts a machine already has.
 * Memories reference repos by MEMBER NAME, never by path: paths are
 * machine-specific, and the names travel in committed files. That is why the
 * manifest schema lives in the spec package — a committed `xgit` anchor is
 * only as meaningful as the name it references, so the name grammar is
 * standard-surface, exactly like the anchor grammar.
 *
 * The manifest itself is NOT committed to any member repo. It defaults to
 * `~/.membook/workspace.yaml`; a team that wants a shared definition may
 * commit one in a meta-repo and point at it explicitly — same format.
 */

/**
 * Member names are lowercase on purpose. They are cross-machine identifiers
 * that end up in committed files, and two names differing only in case would
 * collide on a case-insensitive filesystem the moment anything is keyed by
 * them — the workspace index cache is. A name is an alias the workspace
 * chooses, not the repository's own name, so the constraint costs nothing.
 *
 * `/` and `:` are excluded because serialized anchor forms use them as
 * separators, and a name that needs escaping is a name that will eventually
 * be parsed wrongly by an implementation that forgets to.
 */
export const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

const workspaceName = z
  .string()
  .regex(
    WORKSPACE_NAME_RE,
    "must be lowercase: letters, digits, dot, dash, underscore; starting with a letter or digit"
  );

/**
 * Where the member's checkout lives on THIS machine. Absolute, or `~`-rooted;
 * a relative path resolves against the manifest's own directory, which is
 * what a meta-repo manifest wants. Existence is the resolver's business, not
 * the schema's — an absent member is a legitimate state the verify pass
 * reports honestly, never a malformed manifest.
 */
const memberPath = z.string().min(1, "member path must not be empty");

export const workspaceMemberSchema = z
  .object({
    path: memberPath,
    /**
     * Identity tiebreaker, optional. When present, the resolver compares it
     * against the checkout's `origin` after normalising to canonical
     * host/path — the SSH and HTTPS forms of a repository are the same
     * identity. A checkout with no origin at all is legitimate (resolve by
     * path, identity unconfirmed); the loud failure is reserved for a remote
     * that exists and DISAGREES, which is a wrong-checkout-verification
     * factory.
     */
    remote: z
      .string()
      .min(1, "remote must not be empty when present")
      .optional(),
  })
  .strict();

export const workspaceManifestSchema = z
  .object({
    workspace: workspaceName,
    members: z
      .record(workspaceName, workspaceMemberSchema)
      .refine((members) => Object.keys(members).length > 0, {
        error: "a workspace needs at least one member",
      }),
  })
  .strict();

export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>;

/**
 * Raised when a workspace manifest fails validation. Same shape and ethic as
 * MemfileValidationError: loud, listing every issue, naming the file.
 */
export class WorkspaceManifestError extends Error {
  readonly issues: string[];
  readonly file: string | undefined;

  constructor(issues: string[], file?: string) {
    const where = file ? ` in ${file}` : "";
    super(
      `Invalid workspace manifest${where}:\n${issues
        .map((i) => `  - ${i}`)
        .join("\n")}`
    );
    this.name = "WorkspaceManifestError";
    this.issues = issues;
    this.file = file;
  }
}

/**
 * Parse and validate a workspace manifest. Throws WorkspaceManifestError
 * with actionable issues; there is no quarantine path for manifests — a
 * broken resolution table has nothing to resolve with, so it fails whole.
 */
export function parseWorkspaceManifest(
  source: string,
  file?: string
): WorkspaceManifest {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (cause) {
    throw new WorkspaceManifestError(
      [`unparseable YAML — ${(cause as Error).message}`],
      file
    );
  }

  const result = workspaceManifestSchema.safeParse(data);
  if (!result.success) {
    throw new WorkspaceManifestError(
      result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      }),
      file
    );
  }
  return result.data;
}
