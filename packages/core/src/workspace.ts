import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseWorkspaceManifest, type WorkspaceManifest } from "@membook/spec";
import { isGitRepository, originUrl } from "./git.js";

/**
 * THE RESOLVER TURNS NAMES INTO CHECKOUTS, PER MEMBER AND NON-FATALLY.
 *
 * A workspace is a resolution table: stable member names on one side, this
 * machine's checkouts on the other. Resolution failures are per-member and
 * never abort the pass — an absent member is a fact to report ("could not be
 * checked on this machine"), not an error to die on. The one loud state is a
 * remote that exists and DISAGREES with the manifest: verifying anchors
 * against the wrong checkout would manufacture false verdicts at scale, so
 * that member resolves to a refusal rather than a repository.
 */

/** `~/.membook/workspace.yaml` — the default manifest location. */
export function defaultWorkspacePath(home: string = homedir()): string {
  return join(home, ".membook", "workspace.yaml");
}

export interface ResolveOptions {
  /**
   * What `~` expands to. Injectable for tests; defaults to the real home.
   */
  home?: string;
  /**
   * What relative member paths resolve against. Defaults to the manifest's
   * own directory when resolving a file, which is what a committed meta-repo
   * manifest wants — and must be passed explicitly when resolving a parsed
   * manifest that has no file.
   */
  baseDir?: string;
}

/**
 * One member, resolved. A discriminated union because the states demand
 * different responses, and folding them would lie by aggregation:
 *
 * - `resolved`   — a usable checkout, with its identity spelled out
 * - `absent`     — nothing at the path on this machine
 * - `not-a-repository` — the path exists but git does not live there
 * - `remote-mismatch`  — a checkout whose origin names a DIFFERENT repo;
 *                        refused, because verification against the wrong
 *                        checkout is worse than no verification
 */
export type MemberResolution =
  | {
      name: string;
      path: string;
      state: "resolved";
      /**
       * `confirmed` — the manifest declared a remote and origin agrees.
       * `unconfirmed` — a remote was declared but the checkout has no
       *   origin to compare; resolved by path, said plainly.
       * `undeclared` — the manifest declared no remote; there was nothing
       *   to check, which is not the same fact as a check that passed.
       */
      identity: "confirmed" | "unconfirmed" | "undeclared";
    }
  | { name: string; path: string; state: "absent"; reason: string }
  | { name: string; path: string; state: "not-a-repository"; reason: string }
  | {
      name: string;
      path: string;
      state: "remote-mismatch";
      declared: string;
      found: string;
      reason: string;
    };

export interface ResolvedWorkspace {
  workspace: string;
  /** Sorted by member name: same manifest, same machine, same output. */
  members: MemberResolution[];
}

/**
 * Normalise a git remote URL to a canonical `host/path` identity.
 *
 * The SSH and HTTPS forms of a repository are the same identity, so a
 * resolver treating them as different would reject correct workspaces —
 * normalise once, properly, here. User info, port and the `.git` suffix are
 * transport details, not identity. Host and path are lowercased: every major
 * host treats repo paths case-insensitively, and the danger this check
 * exists for — a remote naming a different repository — differs by more
 * than case.
 *
 * A URL with no host (a filesystem remote) canonicalises to its trimmed
 * path, case preserved, because local filesystems do make case distinctions.
 */
// Plain string walks rather than regexes throughout: the equivalent
// patterns (`\/+$`, an ambiguous host match) backtrack polynomially on
// adversarial input, and CodeQL rightly refuses them even where the input
// is a local manifest.
function trimSlashes(path: string, edge: "both" | "trailing"): string {
  let start = 0;
  let end = path.length;
  if (edge === "both") while (start < end && path[start] === "/") start += 1;
  while (end > start && path[end - 1] === "/") end -= 1;
  return path.slice(start, end);
}

function stripPath(path: string): string {
  const bare = trimSlashes(path, "both");
  return bare.endsWith(".git") ? bare.slice(0, -".git".length) : bare;
}

/** The `host` of `user@host:path`, or null when the shape does not fit. */
function scpLikeHost(head: string): string | null {
  if (/\s/.test(head)) return null;
  const at = head.indexOf("@");
  if (at === head.length - 1) return null;
  const host = at >= 0 ? head.slice(at + 1) : head;
  // A dot flanked by non-dots, as a hostname has — this is what keeps
  // `C:/repos` and a relative `dir:thing` reading as paths, not hosts.
  const dot = host.indexOf(".");
  if (dot <= 0 || dot === host.length - 1) return null;
  if (host.includes("/")) return null;
  return host;
}

export function canonicalRemote(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  // Scheme form: ssh://git@host:2222/acme/repo.git, https://host/acme/repo
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.hostname === "") {
      // file:// — a filesystem identity, not a hosted one.
      return stripPath(parsed.pathname);
    }
    return `${parsed.hostname.toLowerCase()}/${stripPath(
      parsed.pathname
    ).toLowerCase()}`;
  }

  // scp-like form: git@host:acme/repo.git
  const colon = trimmed.indexOf(":");
  if (colon > 0 && colon < trimmed.length - 1) {
    const host = scpLikeHost(trimmed.slice(0, colon));
    if (host !== null) {
      return `${host.toLowerCase()}/${stripPath(
        trimmed.slice(colon + 1)
      ).toLowerCase()}`;
    }
  }

  // A plain filesystem path.
  return stripPath(trimmed) === "" ? null : trimSlashes(trimmed, "trailing");
}

function expandPath(raw: string, home: string, baseDir: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  if (isAbsolute(raw)) return raw;
  return resolve(baseDir, raw);
}

async function resolveMember(
  name: string,
  member: WorkspaceManifest["members"][string],
  home: string,
  baseDir: string
): Promise<MemberResolution> {
  const path = expandPath(member.path, home, baseDir);

  let exists = false;
  try {
    exists = (await stat(path)).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    return {
      name,
      path,
      state: "absent",
      reason: `${name}: nothing at ${path} on this machine`,
    };
  }

  if (!(await isGitRepository(path))) {
    return {
      name,
      path,
      state: "not-a-repository",
      reason: `${name}: ${path} exists but is not a git repository`,
    };
  }

  if (member.remote === undefined) {
    return { name, path, state: "resolved", identity: "undeclared" };
  }

  const origin = await originUrl(path);
  if (origin === null) {
    // No origin at all is NOT a mismatch: a local-only repo is legitimate.
    // Resolve by path and say the identity went unconfirmed.
    return { name, path, state: "resolved", identity: "unconfirmed" };
  }

  const declared = canonicalRemote(member.remote);
  const found = canonicalRemote(origin);
  if (declared !== null && declared === found) {
    return { name, path, state: "resolved", identity: "confirmed" };
  }

  return {
    name,
    path,
    state: "remote-mismatch",
    declared: member.remote,
    found: origin,
    reason:
      `${name}: the checkout at ${path} has origin ${origin}, but the ` +
      `manifest says ${member.remote}. Refusing to treat it as ${name} — ` +
      `verifying against the wrong repository would produce confident, ` +
      `wrong verdicts. Fix the manifest path or the checkout.`,
  };
}

/**
 * Resolve every member of a parsed manifest against this machine.
 *
 * Output order is sorted by member name regardless of manifest order, so the
 * same workspace state yields byte-identical reports.
 */
export async function resolveWorkspace(
  manifest: WorkspaceManifest,
  options: ResolveOptions = {}
): Promise<ResolvedWorkspace> {
  const home = options.home ?? homedir();
  const baseDir = options.baseDir ?? process.cwd();

  const members: MemberResolution[] = [];
  for (const name of Object.keys(manifest.members).sort()) {
    members.push(
      await resolveMember(name, manifest.members[name]!, home, baseDir)
    );
  }
  return { workspace: manifest.workspace, members };
}

/**
 * Read, parse and resolve a manifest file. Relative member paths resolve
 * against the manifest's directory — a committed meta-repo manifest carries
 * its members with it.
 */
export async function resolveWorkspaceFile(
  file: string,
  options: ResolveOptions = {}
): Promise<ResolvedWorkspace> {
  const source = await readFile(file, "utf8");
  const manifest = parseWorkspaceManifest(source, file);
  return resolveWorkspace(manifest, {
    baseDir: dirname(file),
    ...options,
  });
}
