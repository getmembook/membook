import { headSha } from "./git.js";
import type { ResolvedWorkspace } from "./workspace.js";

/**
 * What the verify pass knows about one workspace member: a usable checkout
 * with its HEAD, or the reason it cannot be used. Built lazily — a member is
 * only consulted when an xgit anchor actually names it, so a fifty-member
 * manifest costs nothing to a repo whose memories never leave home.
 */
export type MemberContext =
  | { usable: true; path: string; head: string }
  | { usable: false; reason: string };

export class WorkspaceContext {
  private readonly workspace: ResolvedWorkspace | undefined;
  private readonly cache = new Map<string, MemberContext>();

  constructor(workspace?: ResolvedWorkspace) {
    this.workspace = workspace;
  }

  /**
   * The reasons are written for the verify report, where they must explain a
   * memory that was NOT checked — so each says what was missing, on this
   * machine, in words that tell the reader what to do about it.
   */
  async member(name: string): Promise<MemberContext> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const context = await this.resolve(name);
    this.cache.set(name, context);
    return context;
  }

  private async resolve(name: string): Promise<MemberContext> {
    if (!this.workspace) {
      return {
        usable: false,
        reason: `no workspace manifest was provided, so \`${name}\` cannot be resolved to a checkout`,
      };
    }
    const member = this.workspace.members.find((m) => m.name === name);
    if (!member) {
      return {
        usable: false,
        reason: `\`${name}\` is not a member of workspace \`${this.workspace.workspace}\``,
      };
    }
    if (member.state !== "resolved") {
      return { usable: false, reason: member.reason };
    }
    try {
      return {
        usable: true,
        path: member.path,
        head: await headSha(member.path),
      };
    } catch {
      return {
        usable: false,
        reason: `${name}: the checkout at ${member.path} has no readable HEAD`,
      };
    }
  }
}
