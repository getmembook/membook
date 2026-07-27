import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  Membook,
  UserStore,
  headSha,
  findMissingAnchorPaths,
  isGitRepository,
  type RecallHit,
  SecretScanGuard,
  type WriteGuard,
  type Instrumentation,
} from "@membook/core";
import {
  MEMFILE_SPEC_VERSION,
  MEMORY_TYPES,
  computeMemoryId,
  type MemoryInput,
} from "@membook/spec";

export const SERVER_NAME = "membook";
// Runtime read, not a constant: the hardcoded predecessor shipped 0.1.1
// announcing itself as 0.1.0. dist/*.js -> ../package.json in the tarball.
export const SERVER_VERSION: string = createRequire(import.meta.url)(
  "../package.json"
).version;

/**
 * Hard cap on what one recall can put into an agent's context.
 *
 * The cap is the point, not a default to be raised: a bounded, ranked answer
 * is what keeps retrieval from becoming context pollution. `recall` will
 * return fewer, never more.
 */
export const MAX_RECALL_HITS = 8;

export interface CreateServerOptions {
  /** Repository root. */
  root: string;
  /** Agent identity, recorded in provenance. */
  agent?: string;
  model?: string;
  session?: string;
  guards?: readonly WriteGuard[];
  /** Local event log. Defaults to on; never leaves the machine. */
  instrumentation?: Instrumentation | boolean;
  /** Injected for deterministic tests. */
  now?: () => Date;
}

function renderHit(hit: RecallHit): string {
  // A user-scope hit is the human's own testimony: no anchors to cite, no
  // lifecycle to flag — and the label says whose knowledge it is, so an
  // agent can tell a personal preference from a repository fact.
  if (hit.scope === "user") {
    return [`[${hit.type} · user preference] ${hit.id}`, hit.body].join("\n");
  }
  const anchors = hit.anchors
    .map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path))
    .join(", ");
  // Only drifted memories get a warning. Every freshly written memory is
  // `unverified`, so flagging that too would put a ⚠ on nearly everything and
  // teach the agent to ignore the marker that actually matters.
  const flag =
    hit.status === "stale" || hit.status === "invalidated"
      ? ` ⚠ ${hit.status}`
      : hit.status === "unverified"
      ? " (unverified)"
      : "";
  return [
    `[${hit.type}${flag}] ${hit.id}`,
    hit.body,
    `anchors: ${anchors}`,
  ].join("\n");
}

/**
 * The Membook MCP server.
 *
 * Spawned on stdio per session and exits with it — no daemon, no port, no
 * resident state. Every tool call opens the index, answers, and closes.
 */
export function createServer(options: CreateServerOptions): McpServer {
  const { root } = options;
  const now = options.now ?? (() => new Date());
  // The scanner is ON by default, and instrumentation with it. This is the
  // surface agents actually write through, so a guard that had to be opted
  // into would protect nobody. Telemetry is a local file and never network.
  const membook = new Membook(root, {
    guards: options.guards ?? [new SecretScanGuard()],
    instrumentation: options.instrumentation ?? true,
    // The human's own store joins every recall (v0.2 §8). Reading an absent
    // store is a no-op, so this costs nothing until preferences exist.
    userStore: new UserStore(),
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "recall",
    {
      title: "Recall memories",
      description:
        "Search this repository's memories for durable, project-specific knowledge — decisions, gotchas, conventions, dead ends. " +
        "Call before assuming how something works, and before re-deriving something the team already settled. " +
        "Results are ranked, capped, and filtered: memories whose anchored code has changed are reported as stale rather than served as fact.",
      inputSchema: {
        query: z.string().min(1).describe("What you want to know about."),
        paths: z
          .array(z.string())
          .optional()
          .describe(
            "Files you are currently working on. Memories anchored to them rank higher."
          ),
        include_unverified: z
          .boolean()
          .optional()
          .describe(
            "Include memories that have not been verified against current code. Default true."
          ),
        include_stale: z
          .boolean()
          .optional()
          .describe(
            "Include memories whose anchored code has changed since they were verified. Default false."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RECALL_HITS)
          .optional()
          .describe(`Maximum memories to return (cap ${MAX_RECALL_HITS}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, paths, include_unverified, include_stale, limit }) => {
      const statuses: Array<"verified" | "unverified" | "stale"> = ["verified"];
      if (include_unverified !== false) statuses.push("unverified");
      if (include_stale === true) statuses.push("stale");

      const { hits, withheld } = await membook.recall(query, {
        statuses,
        limit: Math.min(limit ?? MAX_RECALL_HITS, MAX_RECALL_HITS),
        ...(paths?.length ? { contextPaths: paths } : {}),
        now: now(),
      });

      if (hits.length === 0) {
        // Say WHY nothing came back. "No memories" and "memories exist but
        // none can be trusted" are different facts, and an agent that cannot
        // tell them apart will confidently re-derive something known-broken.
        // Both drifted statuses count. Reporting only `stale` tells the agent
        // "nothing recorded" when a memory exists whose anchored file was
        // deleted — which is a fact the agent needs, and the opposite of none.
        const staleCount = withheld.byStatus["stale"] ?? 0;
        const invalidCount = withheld.byStatus["invalidated"] ?? 0;
        const parts: string[] = [];
        if (staleCount > 0) {
          parts.push(
            `${staleCount} matching ${
              staleCount === 1 ? "memory is" : "memories are"
            } stale — the code they describe changed and they have not been re-verified. Re-run with include_stale to see them, and treat them as leads rather than fact.`
          );
        }
        if (invalidCount > 0) {
          // Never served, at any flag: the anchor is gone, so there is nothing
          // left to check the statement against.
          parts.push(
            `${invalidCount} matching ${
              invalidCount === 1 ? "memory was" : "memories were"
            } invalidated — the code ${
              invalidCount === 1 ? "it describes is" : "they describe is"
            } gone. They are not served, but something was once known here.`
          );
        }
        const note =
          parts.length > 0
            ? `No usable memories for that query. ${parts.join(" ")}`
            : "No memories recorded for that query.";
        return { content: [{ type: "text" as const, text: note }] };
      }

      const parts = hits.map(renderHit);
      const staleShown = hits.filter((h) => h.status === "stale").length;
      if (staleShown > 0) {
        parts.push(
          `Note: ${staleShown} of these ${
            staleShown === 1 ? "is" : "are"
          } stale — not verified against current code. Check before relying on them.`
        );
      }

      return { content: [{ type: "text" as const, text: parts.join("\n\n") }] };
    }
  );

  server.registerTool(
    "remember",
    {
      title: "Remember a memory",
      description:
        // WHEN, not just what. Measured in a real repo: `recall` fired and
        // `remember` never did, because recall has a natural pull — "I need
        // to know something" — and nothing in a session prompts "you just
        // learned something, write it down". The what-not-to-record guidance
        // is right for precision, but with no trigger it resolves to never.
        "Record durable, project-specific knowledge worth carrying into a future session: a decision and its reason, a non-obvious gotcha, a convention, a map of where something lives, or a dead end not worth retrying. " +
        "CALL THIS as soon as you work out something that was not obvious — a surprising constraint, why an approach failed, where behaviour actually lives — and before you finish a task. If you spent effort discovering it, the next session should not have to. " +
        "Do NOT record what the code already says, what is obvious from reading it, or anything specific to the current task. " +
        "Every memory MUST name the files it is about — an unanchored memory cannot be verified and will be rejected.",
      inputSchema: {
        statement: z
          .string()
          .min(1)
          .describe(
            "The memory itself: imperative, terse, self-contained. Lead with the claim, then why it matters."
          ),
        type: z
          .enum(MEMORY_TYPES)
          .describe(
            "decision (a choice and its reason) | gotcha (a surprising trap) | convention (a rule we follow) | map (where something lives) | deadend (what not to retry)"
          ),
        paths: z
          .array(z.string().min(1))
          .min(1)
          .describe("Repo-relative files this memory is about. At least one."),
        symbol: z
          .string()
          .optional()
          .describe("Specific function or class, if the memory is about one."),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Default 0.8."),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ statement, type, paths, symbol, confidence }) => {
      if (!(await isGitRepository(root))) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Not a git repository. Membook anchors memories to commits, so it needs one.",
            },
          ],
        };
      }

      const commit = await headSha(root);

      // A memory anchored to a path that does not exist at its own commit can
      // never be verified. The usual cause is an uncommitted file: the agent
      // just created it, so it is absent from HEAD. Refuse now rather than
      // let the next verify pass report it long after this session ended.
      const missing = await findMissingAnchorPaths(root, commit, paths);
      if (missing.length > 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Not remembered: ${missing.join(", ")} ${
                  missing.length === 1 ? "does" : "do"
                } not exist at HEAD (${commit.slice(0, 7)}).\n` +
                "Commit the file first, or anchor to a path that is already committed — a memory anchored to an uncommitted file cannot be verified.",
            },
          ],
        };
      }

      const id = await membook.store.allocateId(statement);
      const timestamp = `${now().toISOString().slice(0, 19)}Z`;

      // `unverified` is the honest status for something just written: no
      // verify pass has checked it against the code yet.
      const frontmatter: MemoryInput = {
        memfile: MEMFILE_SPEC_VERSION,
        id,
        type,
        status: "unverified",
        scope: "repo",
        confidence: confidence ?? 0.8,
        created: timestamp,
        anchors: paths.map((path, i) => ({
          path,
          ...(symbol !== undefined && i === 0 ? { symbol } : {}),
          commit,
        })),
        provenance: {
          origin: "authored",
          author: "agent",
          session: options.session ?? "mcp",
          agent: options.agent ?? "unknown-agent",
          model: options.model ?? "unknown-model",
        },
      };

      try {
        const stored = await membook.remember(frontmatter, statement);
        return {
          content: [
            {
              type: "text" as const,
              text: `Remembered as ${
                stored.id
              } (${type}, unverified) anchored to ${paths.join(
                ", "
              )} at ${commit.slice(0, 7)}.\nFile: .membook/memories/${
                stored.file
              }`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Not remembered: ${(error as Error).message}`,
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    "session_digest",
    {
      title: "Session digest",
      description:
        "Report the state of this repository's memory: how many memories exist, how many are verified, stale, or invalidated, and which need attention. " +
        "CALL THIS at the start of a session to learn what is already known and how far to trust it, and again at the end to check whether what you learned has been recorded.",
      inputSchema: {
        verify: z
          .boolean()
          .optional()
          .describe(
            "Re-check anchors against HEAD before reporting. Read-only: reports without writing. Default false."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ verify }) => {
      const status = await membook.status();
      const lines: string[] = [];

      const total = status.onDisk;
      if (total === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No memories recorded for this repository yet.",
            },
          ],
        };
      }

      const counts = Object.entries(status.byStatus)
        .filter(([, n]) => n > 0)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ");
      lines.push(`${total} ${total === 1 ? "memory" : "memories"}: ${counts}.`);

      if (status.quarantined.length > 0) {
        lines.push(
          `${
            status.quarantined.length
          } quarantined (failed validation): ${status.quarantined
            .map((q) => q.file)
            .join(", ")}.`
        );
      }

      if (verify === true && (await isGitRepository(root))) {
        const report = await membook.verify({ dryRun: true });
        const wouldChange = report.changed.length;
        lines.push(
          wouldChange === 0
            ? `Anchors checked against ${report.head.slice(
                0,
                7
              )}: nothing has drifted.`
            : `Anchors checked against ${report.head.slice(
                0,
                7
              )}: ${wouldChange} would change status. ` +
                report.changed
                  .map((v) => `${v.id} ${v.from}→${v.to}`)
                  .join(", ") +
                ". Run `membook verify` to apply."
        );
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  return server;
}
