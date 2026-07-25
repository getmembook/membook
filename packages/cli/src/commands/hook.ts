import {
  Membook,
  RANKING,
  queryTerms,
  type RecallHit,
} from "@membook/core";

/**
 * THE HARNESS-DRIVEN READ PATH.
 *
 * Recall through MCP depends on an agent choosing to ask. Measured twice on a
 * real repository, it mostly does not: `recall` fired once across two sessions
 * and `remember` never. The tools were connected and the trigger was live —
 * availability is not adoption.
 *
 * A hook removes the choice. The harness runs this on every prompt, and
 * whatever it prints becomes context. The agent does not have to decide it
 * needs memory, which is the one decision it reliably fails to make.
 *
 * This is deliberately OPT-IN and deliberately thin. Hooks are Claude
 * Code-specific, and zero-integration portability via `MEMBOOK.md` is a
 * marketed differentiator, so the portable path stays primary and this is an
 * accelerant for the one harness where the effect can be measured.
 *
 * ABSOLUTE RULE: this never breaks a session. Every failure — no index, no
 * repository, corrupt database, unreadable stdin — exits 0 with empty output.
 * A memory tool that can wedge someone's editor is not a memory tool.
 */

/** Hard cap. Injected context the user did not ask for must stay small. */
export const HOOK_MAX_HITS = 3;

/** Below this a prompt is conversational and recall would only add noise. */
const MIN_QUERY_CHARS = 12;

/**
 * A vague prompt is not a query, and must not trigger an injection.
 *
 * Measured against 61 real prompts from this repo's sessions: "WHat is next",
 * "what is next for us" and "done - what is next" all cleared the push floor
 * and would have injected a memory about gitleaks. They are 12+ characters, so
 * the length gate passed them; they carry one content word, so nothing else
 * stopped them.
 *
 * Three content terms is where a prompt starts being ABOUT something. It costs
 * a few marginal true positives — "CI failed" no longer injects — and silence
 * is the right way to be wrong on a surface that fires on every prompt.
 */
const MIN_QUERY_TERMS = 3;

export interface HookOptions {
  root: string;
  log?: (line: string) => void;
  /** Injected in tests instead of reading stdin. */
  readInput?: () => Promise<string>;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function renderHit(hit: RecallHit): string {
  const anchors = hit.anchors
    .map((a) => (a.symbol ? `${a.path}#${a.symbol}` : a.path))
    .join(", ");
  const flag = hit.status === "unverified" ? " (unverified)" : "";
  return `- [${hit.type}${flag}] ${hit.body} (${anchors})`;
}

/**
 * Answer a `UserPromptSubmit` hook.
 *
 * Reads the harness's JSON on stdin, recalls against the user's prompt, and
 * prints anything worth knowing. Silence is the common and correct case:
 * printing something on every prompt would train the reader to skip it, and
 * would spend context on a tool that had nothing to say.
 */
export async function hookPrompt(options: HookOptions): Promise<void> {
  const log =
    options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  try {
    const raw = options.readInput
      ? await options.readInput()
      : await readStdin();

    const parsed: unknown = JSON.parse(raw);
    const prompt =
      typeof parsed === "object" &&
      parsed !== null &&
      "prompt" in parsed &&
      typeof (parsed as { prompt: unknown }).prompt === "string"
        ? (parsed as { prompt: string }).prompt
        : "";

    if (prompt.trim().length < MIN_QUERY_CHARS) return;
    if (queryTerms(prompt).length < MIN_QUERY_TERMS) return;

    const membook = new Membook(options.root, { instrumentation: true });
    const { hits } = await membook.recall(prompt, {
      // Stale memories are never injected. Unrequested context has to be
      // trustworthy or it is worse than absent — the agent cannot tell where
      // an injected line came from, so it cannot discount it.
      statuses: ["verified", "unverified"],
      limit: HOOK_MAX_HITS,
      // An ABSOLUTE floor, not the relative one. The relative floor always
      // admits the best of a bad set, which is fine when an agent asked and
      // wrong when nobody did.
      minScore: RANKING.pushFloor,
    });

    if (hits.length === 0) return;

    log("Relevant project memory (from Membook, anchored to this repo):");
    for (const hit of hits) log(renderHit(hit));
  } catch {
    // Silence, always. See the rule above.
  }
}
