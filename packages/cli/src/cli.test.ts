import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
  symlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Membook, type ModelProvider } from "@membook/core";
import { init } from "./commands/init.js";
import { status } from "./commands/status.js";
import { review } from "./commands/review.js";
import { seed } from "./commands/seed.js";
import { distill } from "./commands/distill.js";
import { HOOK_MAX_HITS, hookPrompt } from "./commands/hook.js";
import {
  book,
  recall,
  recheckerFromEnv,
  reindex,
  remember,
  verify,
} from "./commands/misc.js";

let root: string;
let lines: string[];
const log = (line: string): void => void lines.push(line);
const output = (): string => lines.join("\n");
// Assertions are about wording, not line breaks: wrap() is layout.
const flat = (): string => output().replace(/\s+/g, " ");

async function git(dir: string, args: string[]): Promise<void> {
  await execa("git", args, { cwd: dir });
}

/**
 * The local event log, parsed.
 *
 * Read from disk rather than through a spy on purpose: the bugs this catches
 * are commands that build a correct event and hand it to a null sink, which a
 * spy injected by the test would hide.
 */
async function readEvents(
  dir: string
): Promise<Array<Record<string, unknown> & { event: string }>> {
  const file = join(dir, ".membook/telemetry/events.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

beforeEach(async () => {
  lines = [];
  root = await mkdtemp(join(tmpdir(), "membook-cli-"));
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@example.test"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/auth.ts"), "export const a = 1;\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "init"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("init", () => {
  it("creates the store, gitignore and book", async () => {
    await init({ root, log });
    expect(existsSync(join(root, ".membook/memories"))).toBe(true);
    expect(existsSync(join(root, "MEMBOOK.md"))).toBe(true);
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain(".membook/index/");
    expect(ignore).toContain(".membook/telemetry/");
  });

  it("does not gitignore the memories or the book — those are committed", async () => {
    await init({ root, log });
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).not.toMatch(/^\.membook\/memories/m);
    expect(ignore).not.toMatch(/^MEMBOOK\.md/m);
  });

  it("is idempotent", async () => {
    await init({ root, log });
    const first = await readFile(join(root, ".gitignore"), "utf8");
    await init({ root, log });
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(first);
  });

  it("preserves an existing gitignore", async () => {
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
    await init({ root, log });
    const ignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("node_modules/");
    expect(ignore).toContain(".membook/index/");
  });

  it("tells the user how to connect an agent", async () => {
    await init({ root, log });
    expect(output()).toContain("@membook/mcp");
  });
});

/**
 * Measured in a real repo: after a full session, `recall` fired once and
 * `remember` never. Recall has a natural pull — "I need to know something".
 * Nothing in a session prompts "you just learned something, write it down",
 * so the book stays empty, recall keeps returning nothing, and the agent
 * stops asking. `init` sets up storage and leaves the hardest part — knowing
 * when to use it — to the human.
 *
 * The pointer is one marked line, not a section: CLAUDE.md is shared team
 * instruction, and a tool that injects opinionated prose into it is
 * obnoxious.
 */
describe("agent pointer", () => {
  const MARKER = "<!-- membook -->";

  it("appends a marked pointer to CLAUDE.md", async () => {
    await writeFile(
      join(root, "CLAUDE.md"),
      "# Project\n\nExisting guidance.\n",
      "utf8"
    );
    await init({ root, log });

    const md = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(md).toContain(MARKER);
    expect(md).toMatch(/MEMBOOK\.md/);
    // Existing content survives byte-for-byte.
    expect(md).toContain("# Project\n\nExisting guidance.\n");
  });

  it("prefers AGENTS.md when both exist, and writes only one", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# Claude\n", "utf8");
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await init({ root, log });

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(MARKER);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).not.toContain(
      MARKER
    );
  });

  // D1: creating an agent-instruction file in a repo that deliberately has
  // none is presumptuous. Skip and say so.
  it("creates nothing when neither file exists", async () => {
    await init({ root, log });
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expect(flat()).toMatch(/no CLAUDE\.md or AGENTS\.md/i);
  });

  /**
   * Found in a real repo, not invented: `docs-repo` has CLAUDE.md as a
   * symlink to AGENTS.md. Both "contain" the pointer because they are one
   * file. AGENTS.md winning means we write to it by its real name and report
   * it truthfully; had CLAUDE.md come first we would have written through the
   * link and named the wrong file.
   */
  it("handles CLAUDE.md being a symlink to AGENTS.md", async () => {
    await writeFile(join(root, "AGENTS.md"), "# Agents\n", "utf8");
    await symlink("AGENTS.md", join(root, "CLAUDE.md"));

    lines = [];
    await init({ root, log });

    const target = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(target.match(new RegExp(MARKER, "g"))).toHaveLength(1);
    expect(flat()).toContain("AGENTS.md");

    // And re-running still does not duplicate through the link.
    await init({ root, log });
    const after = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(after.match(new RegExp(MARKER, "g"))).toHaveLength(1);
  });

  it("is idempotent — a second init does not duplicate it", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# Project\n", "utf8");
    await init({ root, log });
    const once = await readFile(join(root, "CLAUDE.md"), "utf8");
    await init({ root, log });
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(once);
  });

  it("does not duplicate when the user has reworded the line", async () => {
    await writeFile(
      join(root, "CLAUDE.md"),
      `# Project\n\n${MARKER}\nOur own wording about membook.\n`,
      "utf8"
    );
    await init({ root, log });
    const md = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(md.match(new RegExp(MARKER, "g"))).toHaveLength(1);
    expect(md).toContain("Our own wording about membook.");
  });

  it("appends cleanly to a file with no trailing newline", async () => {
    await writeFile(
      join(root, "CLAUDE.md"),
      "# Project\nNo trailing newline",
      "utf8"
    );
    await init({ root, log });
    const md = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(md).toContain("No trailing newline\n");
    expect(md).toContain(MARKER);
  });

  it("reports what it did, so it is never a silent edit", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# Project\n", "utf8");
    lines = [];
    await init({ root, log });
    expect(flat()).toMatch(/CLAUDE\.md/);
  });
});

describe("status", () => {
  it("says plainly when nothing is recorded", async () => {
    await init({ root, log });
    lines = [];
    await status({ root, log });
    expect(output()).toContain("No memories recorded yet");
  });

  it("counts by status and explains what each means", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    lines = [];
    await status({ root, log });
    expect(output()).toContain("1 memory");
    expect(output()).toContain("not checked yet");
  });

  // "nothing is recorded" and "things are recorded but drifted" call for
  // opposite responses, so they must not read as the same sentence.
  it("distinguishes drift from absence, and says what to do about it", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    await verify({ root, log });
    await writeFile(
      join(root, "src/auth.ts"),
      "export const a = 999;\n",
      "utf8"
    );
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "change"]);
    await verify({ root, log });

    lines = [];
    await status({ root, log });
    expect(output()).toContain("drifted");
    expect(flat()).toContain("withheld from MEMBOOK.md");
    expect(output()).toContain("membook verify --recheck");
  });

  it("--check reports without writing", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    lines = [];
    await status({ root, check: true, log });
    expect(output()).toMatch(/would change|nothing has drifted/);

    const membook = new Membook(root);
    const report = await membook.status();
    expect(report.byStatus["unverified"]).toBe(1);
  });
});

describe("remember", () => {
  /**
   * The first real exercise of the human provenance branch: a person has no
   * agent and no model, and the schema makes inventing them impossible.
   */
  it("records origin authored, author human, with no agent or model", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Deploys are gated on the migration job finishing first.",
      type: "convention",
      paths: ["src/auth.ts"],
      log,
    });

    const membook = new Membook(root);
    const [id] = await membook.store.listIds();
    const { provenance } = (await membook.store.read(id!)).memfile.frontmatter;

    expect(provenance.origin).toBe("authored");
    expect(provenance).toMatchObject({ author: "human" });
    expect(provenance).not.toHaveProperty("agent");
    expect(provenance).not.toHaveProperty("model");
    expect(provenance).not.toHaveProperty("source_hash");
  });

  it("records it unverified, and says so", async () => {
    await init({ root, log });
    lines = [];
    await remember({
      root,
      statement: "Deploys are gated on the migration job.",
      type: "convention",
      paths: ["src/auth.ts"],
      log,
    });
    expect(output()).toContain("unverified");
    expect(flat()).toContain("nothing has checked it");
  });

  /**
   * Found by dogfooding: three memories were written about a doc that had not
   * been committed yet, and every one was invalidated by the next verify pass.
   * This is the most common agent workflow — create a file, record what you
   * learned, before committing — so it has to fail loudly at write time
   * rather than quietly a session later.
   */
  it("refuses to anchor to a file that does not exist at HEAD", async () => {
    await init({ root, log });
    await writeFile(
      join(root, "src/uncommitted.ts"),
      "export const x = 1;\n",
      "utf8"
    );
    lines = [];

    await expect(
      remember({
        root,
        statement: "Something about a file that has not been committed.",
        type: "gotcha",
        paths: ["src/uncommitted.ts"],
        log,
      })
    ).rejects.toThrow();

    expect(await new Membook(root).store.listIds()).toHaveLength(0);
  });

  it("accepts the same path once it is committed", async () => {
    await init({ root, log });
    await writeFile(
      join(root, "src/now-committed.ts"),
      "export const x = 1;\n",
      "utf8"
    );
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "add file"]);

    await remember({
      root,
      statement: "Something about a file that is committed.",
      type: "gotcha",
      paths: ["src/now-committed.ts"],
      log,
    });
    expect(await new Membook(root).store.listIds()).toHaveLength(1);
  });

  it("blocks a credential and does not write it", async () => {
    await init({ root, log });
    const { FAKE_SECRETS } = await import("@membook/core");
    lines = [];
    await remember({
      root,
      statement: `Publish with ${FAKE_SECRETS.githubToken} from CI.`,
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    expect(output()).toContain("Not recorded");
    expect(await new Membook(root).store.listIds()).toHaveLength(0);
  });
});

describe("review", () => {
  async function seed(): Promise<void> {
    await init({ root, log });
    await remember({
      root,
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    lines = [];
  }

  it("lists what needs a decision", async () => {
    await seed();
    await review({ root, list: true, log });
    expect(output()).toContain("needs a human decision");
  });

  /**
   * The human-ratification story: a person reading the code and confirming
   * the statement IS a verification, and the strongest kind available.
   */
  it("ratifying marks it verified at HEAD", async () => {
    await seed();
    await review({ root, log, ask: async () => "k" });

    const membook = new Membook(root);
    const [id] = await membook.store.listIds();
    const fm = (await membook.store.read(id!)).memfile.frontmatter;
    expect(fm.status).toBe("verified");
    expect(fm.verified).toBeDefined();

    const head = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    expect(fm.anchors[0]!.commit).toBe(head);
  });

  it("deleting removes the file", async () => {
    await seed();
    await review({ root, log, ask: async () => "d" });
    expect(await new Membook(root).store.listIds()).toHaveLength(0);
  });

  /**
   * A human decision is the only ground truth in the log, and re-check
   * accuracy is computable only against it. Found by dogfooding: `review`
   * wrote statuses through the store and recorded nothing at all, so every
   * ratification — the strongest signal available — was invisible.
   *
   * These assert on the log FILE, not on a spy: the original bug was an
   * event that was faithfully constructed and then handed to a null sink.
   */
  it("records a ratification as ground truth", async () => {
    await seed();
    await review({ root, log, ask: async () => "k" });

    const events = await readEvents(root);
    const reviewed = events.filter((e) => e.event === "review");
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.action).toBe("ratify");
    expect(reviewed[0]!.from).toBe("unverified");
  });

  it("records a deletion, with the status the human overrode", async () => {
    await seed();
    await review({ root, log, ask: async () => "d" });

    const reviewed = (await readEvents(root)).filter(
      (e) => e.event === "review"
    );
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.action).toBe("delete");
    // Recorded before the delete, or the status would be unrecoverable.
    expect(reviewed[0]!.from).toBe("unverified");
  });

  it("records nothing when the human skips", async () => {
    await seed();
    await review({ root, log, ask: async () => "s" });
    expect(
      (await readEvents(root)).filter((e) => e.event === "review")
    ).toHaveLength(0);
  });

  it("skipping leaves it alone", async () => {
    await seed();
    await review({ root, log, ask: async () => "s" });
    const membook = new Membook(root);
    const [id] = await membook.store.listIds();
    expect((await membook.store.read(id!)).memfile.frontmatter.status).toBe(
      "unverified"
    );
  });

  it("quitting stops without touching anything", async () => {
    await seed();
    await review({ root, log, ask: async () => "q" });
    const membook = new Membook(root);
    const [id] = await membook.store.listIds();
    expect((await membook.store.read(id!)).memfile.frontmatter.status).toBe(
      "unverified"
    );
  });

  it("says so when nothing is pending", async () => {
    await init({ root, log });
    lines = [];
    await review({ root, log, ask: async () => "s" });
    expect(output()).toContain("Nothing is waiting");
  });
});

describe("verify", () => {
  it("refuses to guess without a model, and says why", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    await verify({ root, log });
    await writeFile(
      join(root, "src/auth.ts"),
      "export const a = 999;\n",
      "utf8"
    );
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "change"]);

    lines = [];
    await verify({ root, log });
    expect(output()).toContain("stale");
    expect(flat()).toContain("absence of further change is not evidence");
  });

  it("--dry-run writes nothing", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    lines = [];
    await verify({ root, dryRun: true, log });
    expect(output()).toContain("Nothing was written");
    const membook = new Membook(root);
    expect((await membook.status()).byStatus["unverified"]).toBe(1);
  });
});

/**
 * The unit tests above inject `ask`, which bypasses readline entirely — and
 * that is precisely how a real bug got through: created eagerly, the reader
 * drained piped stdin during setup and silently discarded the answer. These
 * drive the built binary, so the terminal path is actually exercised.
 */
describe("the real binary", () => {
  const bin = join(import.meta.dirname, "..", "dist", "cli.js");
  const built = existsSync(bin);
  const runIf = built ? it : it.skip;

  runIf("ratifies from piped input rather than losing the answer", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Deploys are gated on the migration job finishing first.",
      type: "convention",
      paths: ["src/auth.ts"],
      log,
    });

    const { stdout } = await execa("node", [bin, "-C", root, "review"], {
      input: "k\n",
    });
    expect(stdout).toContain("1 ratified");

    const membook = new Membook(root);
    const [id] = await membook.store.listIds();
    expect((await membook.store.read(id!)).memfile.frontmatter.status).toBe(
      "verified"
    );
  });

  runIf("treats the end of input as quit, not as a crash", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Deploys are gated on the migration job.",
      type: "convention",
      paths: ["src/auth.ts"],
      log,
    });

    const result = await execa("node", [bin, "-C", root, "review"], {
      input: "",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("readline was closed");
  });

  runIf("prints help without a repository", async () => {
    const { stdout } = await execa("node", [bin, "--help"]);
    expect(stdout).toContain("membook");
    expect(stdout).toContain("review");
  });
});

/**
 * A local Ollama was asked for `gpt-4o-mini` twelve times across four runs
 * before the telemetry made the cause obvious: the env var existed but
 * nothing surfaced its name. The override has to reach the request AND the
 * attribution string — attribution is how the mismatch was diagnosed at all.
 */
describe("model override", () => {
  const withEnv = async <T>(
    env: Record<string, string | undefined>,
    fn: () => Promise<T> | T
  ): Promise<T> => {
    const saved = Object.fromEntries(
      Object.keys(env).map((k) => [k, process.env[k]])
    );
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("--model reaches the attribution string", async () => {
    await withEnv(
      {
        OPENAI_API_KEY: "test-key",
        ANTHROPIC_API_KEY: undefined,
        MEMBOOK_MODEL: undefined,
      },
      () => {
        const checker = recheckerFromEnv(root, undefined, "qwen2.5-coder:3b");
        expect(checker!.name).toBe("llm:openai-compatible:qwen2.5-coder:3b");
      }
    );
  });

  it("falls back to MEMBOOK_MODEL when no flag is given", async () => {
    await withEnv(
      {
        OPENAI_API_KEY: "test-key",
        ANTHROPIC_API_KEY: undefined,
        MEMBOOK_MODEL: "from-env",
      },
      () => {
        expect(recheckerFromEnv(root)!.name).toBe(
          "llm:openai-compatible:from-env"
        );
      }
    );
  });

  it("prefers the flag over the environment", async () => {
    await withEnv(
      {
        OPENAI_API_KEY: "test-key",
        ANTHROPIC_API_KEY: undefined,
        MEMBOOK_MODEL: "from-env",
      },
      () => {
        expect(recheckerFromEnv(root, undefined, "from-flag")!.name).toBe(
          "llm:openai-compatible:from-flag"
        );
      }
    );
  });

  it("keeps the provider default when neither is set", async () => {
    await withEnv(
      {
        OPENAI_API_KEY: "test-key",
        ANTHROPIC_API_KEY: undefined,
        MEMBOOK_MODEL: undefined,
      },
      () => {
        expect(recheckerFromEnv(root)!.name).toBe(
          "llm:openai-compatible:gpt-4o-mini"
        );
      }
    );
  });

  it("overrides the anthropic model too", async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: "test-key", MEMBOOK_MODEL: undefined },
      () => {
        expect(
          recheckerFromEnv(root, undefined, "claude-haiku-4-5")!.name
        ).toBe("llm:anthropic:claude-haiku-4-5");
      }
    );
  });

  it("is offered by the CLI, so it can be found without reading source", async () => {
    const bin = join(import.meta.dirname, "..", "dist", "cli.js");
    if (!existsSync(bin)) return;
    const { stdout } = await execa("node", [bin, "verify", "--help"]);
    expect(stdout).toContain("--model");
  });
});

/**
 * Retrieval precision is the binding constraint, and before this command it
 * was unobservable without an agent choosing to ask. These tests are about
 * what a human is told, especially when the answer is empty — an empty result
 * has two very different causes and they call for opposite responses.
 */
describe("recall", () => {
  async function seed(): Promise<void> {
    await init({ root, log });
    await remember({
      root,
      statement:
        "Auth tokens refresh on the request boundary, not on a timer, or sessions expire mid-flight.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    lines = [];
  }

  it("serves a relevant memory with its anchor and score", async () => {
    await seed();
    await recall({ root, query: "auth token refresh boundary", log });
    expect(flat()).toContain("request boundary");
    expect(output()).toContain("src/auth.ts");
    expect(output()).toContain("score");
  });

  it("says plainly when nothing is recorded", async () => {
    await seed();
    await recall({ root, query: "kubernetes ingress annotations", log });
    expect(flat()).toContain("Nothing recorded for that query");
  });

  // The distinction the whole product turns on. A human told "nothing known"
  // when the truth is "known but drifted" will go and re-derive it.
  it("distinguishes drifted from unknown, and offers the flag", async () => {
    await seed();
    await writeFile(join(root, "src/auth.ts"), "export const a = 2;\n", "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "change auth"]);
    await verify({ root, log });
    lines = [];

    await recall({ root, query: "auth token refresh boundary", log });
    expect(flat()).toContain("Nothing usable for that query");
    expect(flat()).toContain("stale");
    expect(flat()).toContain("--include-stale");
    expect(flat()).not.toContain("Nothing recorded");
  });

  /**
   * Caught on a live repo minutes after this command was written: only `stale`
   * was counted, so a memory whose anchored file had been DELETED reported as
   * "nothing recorded" — the very confusion the command exists to prevent,
   * one status over. Invalidated memories are never served, but their
   * existence is a fact the reader needs.
   */
  it("reports an invalidated memory rather than claiming nothing is known", async () => {
    await seed();
    await git(root, ["rm", "-q", "src/auth.ts"]);
    await git(root, ["commit", "-m", "delete auth"]);
    await verify({ root, log });
    lines = [];

    await recall({ root, query: "auth token refresh boundary", log });
    expect(flat()).toContain("Nothing usable for that query");
    expect(flat()).toContain("invalidated");
    expect(flat()).not.toContain("Nothing recorded");
  });

  it("serves the drifted memory when asked", async () => {
    await seed();
    await writeFile(join(root, "src/auth.ts"), "export const a = 2;\n", "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "change auth"]);
    await verify({ root, log });
    lines = [];

    await recall({
      root,
      query: "auth token refresh boundary",
      includeStale: true,
      log,
    });
    expect(flat()).toContain("request boundary");
  });

  // Same log the MCP path writes to: a human checking retrieval is a recall
  // event, and excluding it would understate how much recall actually happens.
  it("records the recall, so hit rate counts human queries too", async () => {
    await seed();
    await recall({ root, query: "auth token refresh boundary", log });

    const events = (await readEvents(root)).filter((e) => e.event === "recall");
    expect(events).toHaveLength(1);
    expect(events[0]!.served).toBe(1);
  });

  it("redacts a credential typed into the query", async () => {
    await seed();
    const { FAKE_SECRETS } = await import("@membook/core");
    await recall({
      root,
      query: `why does ${FAKE_SECRETS.githubToken} not work`,
      log,
    });

    const events = (await readEvents(root)).filter((e) => e.event === "recall");
    expect(events[0]!.query).toBe("[redacted]");
  });
});

/**
 * Seeding is the cold-start fix: without it a fresh `init` produces an empty
 * book and the tool is worth nothing until an agent volunteers to write
 * something, which measurement says does not happen.
 *
 * The tests that matter are about what it REFUSES, and about the fact that
 * everything it writes is unverified and lands in front of a human.
 */
describe("seed", () => {
  const provider = (replies: string[]): ModelProvider => {
    let i = 0;
    return {
      name: "fake",
      model: "fake-model",
      async complete() {
        const text = replies[i] ?? replies.at(-1) ?? "";
        i += 1;
        return { text, inputTokens: 5, outputTokens: 5 };
      },
    };
  };

  const memories = (items: unknown[]): string =>
    JSON.stringify({ memories: items });

  async function withDoc(body: string): Promise<void> {
    await init({ root, log });
    await writeFile(join(root, "ARCHITECTURE.md"), body, "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "docs"]);
    lines = [];
  }

  const LONG = `# Architecture\n\n${"Context about this project. ".repeat(40)}`;

  it("records a candidate as unverified, for a human to decide", async () => {
    await withDoc(LONG);
    await seed({
      root,
      log,
      provider: provider([
        memories([
          {
            statement:
              "Requests are authenticated at the edge, never inside a service.",
            type: "decision",
            paths: ["ARCHITECTURE.md"],
            confidence: 0.9,
          },
        ]),
      ]),
    });

    const membook = new Membook(root);
    const [id] = await membook.store.listIds();
    const fm = (await membook.store.read(id!)).memfile.frontmatter;
    expect(fm.status).toBe("unverified");
    expect(flat()).toContain("membook review");
  });

  // `origin: distilled` requires a source_hash, and it must be the hash of
  // exactly what the model read — that is what makes the memory auditable.
  it("records distilled provenance hashing what the model read", async () => {
    await withDoc(LONG);
    await seed({
      root,
      log,
      provider: provider([
        memories([
          {
            statement:
              "Requests are authenticated at the edge, never inside a service.",
            type: "decision",
            paths: ["ARCHITECTURE.md"],
            confidence: 0.9,
          },
        ]),
      ]),
    });

    const membook = new Membook(root);
    const [id] = await membook.store.listIds();
    const { provenance } = (await membook.store.read(id!)).memfile.frontmatter;
    expect(provenance.origin).toBe("distilled");
    const { sourceHash } = await import("@membook/core");
    if (provenance.origin === "distilled") {
      expect(provenance.source_hash).toBe(sourceHash(LONG));
    }
  });

  it("writes nothing on a dry run", async () => {
    await withDoc(LONG);
    await seed({
      root,
      log,
      dryRun: true,
      provider: provider([
        memories([
          {
            statement: "Requests are authenticated at the edge.",
            type: "decision",
            paths: ["ARCHITECTURE.md"],
            confidence: 0.9,
          },
        ]),
      ]),
    });

    expect(await new Membook(root).store.listIds()).toHaveLength(0);
    expect(flat()).toContain("Dry run");
  });

  it("refuses a candidate anchored to a file that does not exist", async () => {
    await withDoc(LONG);
    await seed({
      root,
      log,
      provider: provider([
        memories([
          {
            statement: "The scheduler retries with jitter, not a fixed delay.",
            type: "gotcha",
            paths: ["src/scheduler-that-does-not-exist.ts"],
            confidence: 0.9,
          },
        ]),
      ]),
    });

    expect(await new Membook(root).store.listIds()).toHaveLength(0);
    expect(flat()).toContain("cited a file that does not exist");
  });

  it("treats keeping nothing as a correct outcome, not a failure", async () => {
    await withDoc(LONG);
    await seed({ root, log, provider: provider([memories([])]) });

    expect(flat()).toContain("Nothing worth recording");
    expect(flat()).toContain("Rejection is the default");
  });

  it("says what to do when no model is configured", async () => {
    await withDoc(LONG);
    const saved = {
      a: process.env["ANTHROPIC_API_KEY"],
      o: process.env["OPENAI_API_KEY"],
    };
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["OPENAI_API_KEY"];
    try {
      await expect(seed({ root, log })).rejects.toThrow();
    } finally {
      if (saved.a !== undefined) process.env["ANTHROPIC_API_KEY"] = saved.a;
      if (saved.o !== undefined) process.env["OPENAI_API_KEY"] = saved.o;
    }
  });

  it("skips a stub too short to say anything", async () => {
    await init({ root, log });
    await writeFile(join(root, "NOTES.md"), "# Notes\n\nTBD.\n", "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "stub"]);
    lines = [];

    await seed({ root, log, provider: provider([memories([])]) });
    expect(flat()).toContain("No documentation found");
  });

  /** The whole point: seed feeds review, and review produces ground truth. */
  it("hands its output to review, which ratifies it", async () => {
    await withDoc(LONG);
    await seed({
      root,
      log,
      provider: provider([
        memories([
          {
            statement:
              "Requests are authenticated at the edge, never inside a service.",
            type: "decision",
            paths: ["ARCHITECTURE.md"],
            confidence: 0.9,
          },
        ]),
      ]),
    });
    lines = [];

    await review({ root, log, ask: async () => "k" });

    const membook = new Membook(root);
    const [id] = await membook.store.listIds();
    expect((await membook.store.read(id!)).memfile.frontmatter.status).toBe(
      "verified"
    );
    const reviewed = (await readEvents(root)).filter(
      (e) => e.event === "review"
    );
    expect(reviewed[0]!.action).toBe("ratify");
  });
});

/**
 * The write side of the volition problem. `remember` asks an agent to notice
 * it learned something, judge it durable, phrase it, and pick anchors — four
 * judgements at the moment it is trying to finish. Distillation moves the bar
 * to "say what happened" and makes those judgements here, where rejection is
 * the default.
 */
describe("distill", () => {
  const provider = (replies: string[]): ModelProvider => {
    let i = 0;
    return {
      name: "fake",
      model: "fake-model",
      async complete() {
        const text = replies[i] ?? replies.at(-1) ?? "";
        i += 1;
        return { text, inputTokens: 5, outputTokens: 5 };
      },
    };
  };

  const memories = (items: unknown[]): string =>
    JSON.stringify({ memories: items });

  const NOTES = `Spent the session on the auth module. ${"Details about what happened. ".repeat(
    10
  )}`;

  it("records a candidate as unverified", async () => {
    await init({ root, log });
    lines = [];
    await distill({
      root,
      log,
      readInput: async () => NOTES,
      provider: provider([
        memories([
          {
            statement:
              "Token refresh must happen on the request boundary; a timer drifts and expires sessions mid-flight.",
            type: "gotcha",
            paths: ["src/auth.ts"],
            confidence: 0.9,
          },
        ]),
      ]),
    });

    const membook = new Membook(root);
    const [id] = await membook.store.listIds();
    expect((await membook.store.read(id!)).memfile.frontmatter.status).toBe(
      "unverified"
    );
  });

  /**
   * Notes are not a repo file, so unlike seeding there is NO fallback anchor.
   * Every anchor must come from the model and survive grounding, or the
   * memory would be unverifiable forever.
   */
  it("discards a candidate citing a file that does not exist", async () => {
    await init({ root, log });
    lines = [];
    await distill({
      root,
      log,
      readInput: async () => NOTES,
      provider: provider([
        memories([
          {
            statement: "The scheduler retries with jitter, not a fixed delay.",
            type: "gotcha",
            paths: ["src/imaginary.ts"],
            confidence: 0.9,
          },
        ]),
      ]),
    });

    expect(await new Membook(root).store.listIds()).toHaveLength(0);
    expect(flat()).toContain("cited a file that does not exist");
  });

  it("treats an empty session as a correct outcome", async () => {
    await init({ root, log });
    lines = [];
    await distill({
      root,
      log,
      readInput: async () => NOTES,
      provider: provider([memories([])]),
    });

    expect(flat()).toContain("Nothing worth recording");
    expect(await new Membook(root).store.listIds()).toHaveLength(0);
  });

  it("refuses notes too short to contain a memory", async () => {
    await init({ root, log });
    lines = [];
    await expect(
      distill({
        root,
        log,
        readInput: async () => "fixed a typo",
        provider: provider([memories([])]),
      })
    ).rejects.toThrow();
  });

  // A failed distillation must cost the user nothing, and must not be
  // reported as "nothing worth recording" — those are different facts.
  it("distinguishes a model failure from an empty result", async () => {
    await init({ root, log });
    lines = [];
    await distill({
      root,
      log,
      readInput: async () => NOTES,
      provider: provider(["not json", "still not json"]),
    });

    expect(flat()).toContain("did not return anything usable");
    expect(flat()).not.toContain("Nothing worth recording");
    expect(await new Membook(root).store.listIds()).toHaveLength(0);
  });

  it("writes nothing on a dry run", async () => {
    await init({ root, log });
    lines = [];
    await distill({
      root,
      log,
      dryRun: true,
      readInput: async () => NOTES,
      provider: provider([
        memories([
          {
            statement: "Token refresh happens on the request boundary.",
            type: "gotcha",
            paths: ["src/auth.ts"],
            confidence: 0.9,
          },
        ]),
      ]),
    });

    expect(await new Membook(root).store.listIds()).toHaveLength(0);
    expect(flat()).toContain("Dry run");
  });

  it("does not record something already known", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Token refresh happens on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    lines = [];

    await distill({
      root,
      log,
      readInput: async () => NOTES,
      provider: provider([
        memories([
          {
            statement: "Token refresh happens on the request boundary.",
            type: "gotcha",
            paths: ["src/auth.ts"],
            confidence: 0.9,
          },
        ]),
      ]),
    });

    expect(await new Membook(root).store.listIds()).toHaveLength(1);
    expect(flat()).toContain("already recorded");
  });
});

/**
 * The hook removes the agent's choice to ask, which measurement says is the
 * failure point. Its non-negotiable property is that it can never break a
 * session: a memory tool that wedges someone's editor is not a memory tool.
 */
describe("recall hook", () => {
  const event = (prompt: string): string => JSON.stringify({ prompt });

  async function seeded(): Promise<void> {
    await init({ root, log });
    await remember({
      root,
      statement:
        "Auth tokens refresh on the request boundary, not on a timer, or sessions expire mid-flight.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    lines = [];
  }

  it("injects a relevant memory", async () => {
    await seeded();
    await hookPrompt({
      root,
      log,
      readInput: async () => event("why do auth tokens refresh oddly here"),
    });
    expect(flat()).toContain("request boundary");
    expect(flat()).toContain("Membook");
  });

  it("stays silent when it has nothing to say", async () => {
    await seeded();
    await hookPrompt({
      root,
      log,
      readInput: async () => event("write me a haiku about kubernetes"),
    });
    expect(output()).toBe("");
  });

  it("ignores a prompt too short to be a query", async () => {
    await seeded();
    await hookPrompt({ root, log, readInput: async () => event("hi") });
    expect(output()).toBe("");
  });

  // Unrequested context has to be trustworthy: the agent cannot tell where an
  // injected line came from, so it cannot discount a stale one.
  it("never injects a stale memory", async () => {
    await seeded();
    await writeFile(join(root, "src/auth.ts"), "export const a = 3;\n", "utf8");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-m", "change auth"]);
    await verify({ root, log });
    lines = [];

    await hookPrompt({
      root,
      log,
      readInput: async () => event("why do auth tokens refresh oddly here"),
    });
    expect(output()).toBe("");
  });

  it("caps how much it injects", async () => {
    await init({ root, log });
    for (let i = 0; i < 8; i += 1) {
      await remember({
        root,
        statement: `Auth boundary rule number ${i}: tokens refresh on the request boundary every time.`,
        type: "gotcha",
        paths: ["src/auth.ts"],
        log,
      });
    }
    lines = [];

    await hookPrompt({
      root,
      log,
      readInput: async () => event("auth tokens refresh request boundary"),
    });
    expect(
      output()
        .split("\n")
        .filter((l) => l.startsWith("- "))
    ).toHaveLength(HOOK_MAX_HITS);
  });

  it("says nothing on malformed input rather than failing", async () => {
    await seeded();
    await expect(
      hookPrompt({ root, log, readInput: async () => "not json" })
    ).resolves.toBeUndefined();
    expect(output()).toBe("");
  });

  it("says nothing in a repository with no memories at all", async () => {
    await expect(
      hookPrompt({
        root,
        log,
        readInput: async () => event("anything at all about this project"),
      })
    ).resolves.toBeUndefined();
    expect(output()).toBe("");
  });
});

describe("init --hooks", () => {
  const settingsPath = (): string => join(root, ".claude/settings.json");

  it("does not install hooks unless asked", async () => {
    await init({ root, log });
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("installs the hook when asked, and says so", async () => {
    await init({ root, log, hooks: true });
    const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(JSON.stringify(settings)).toContain("membook hook prompt");
    expect(flat()).toContain("recall hook");
  });

  it("is idempotent", async () => {
    await init({ root, log, hooks: true });
    await init({ root, log, hooks: true });
    const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("preserves settings that are already there", async () => {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(
      settingsPath(),
      JSON.stringify({ model: "opus", hooks: { Stop: [{ existing: true }] } }),
      "utf8"
    );

    await init({ root, log, hooks: true });
    const settings = JSON.parse(await readFile(settingsPath(), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  // Someone else's settings file is not ours to reformat, and clobbering it to
  // add a feature they can live without would be indefensible.
  it("refuses to rewrite a settings file it cannot parse", async () => {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(settingsPath(), "{ this is not json", "utf8");

    await init({ root, log, hooks: true });
    expect(await readFile(settingsPath(), "utf8")).toBe("{ this is not json");
    expect(flat()).toContain("could not be parsed");
  });
});

describe("book and reindex", () => {
  it("book reports what it carried and what it withheld", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    lines = [];
    await book({ root, log });
    expect(output()).toContain("Wrote MEMBOOK.md");
  });

  /**
   * How much the book carried and how much it withheld are the numbers the
   * honesty claim rests on. Found by dogfooding: `book` opened an
   * uninstrumented Membook, so on every human run the event was built and
   * dropped, and the log showed the book had never been compiled.
   */
  it("book records what it carried, so the claim is checkable", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    await book({ root, log });

    const events = (await readEvents(root)).filter((e) => e.event === "book");
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)!.carried).toBe(1);
    expect(events.at(-1)!.tokens).toBeGreaterThan(0);
  });

  it("reindex rebuilds from the files", async () => {
    await init({ root, log });
    await remember({
      root,
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
      log,
    });
    await rm(join(root, ".membook/index"), { recursive: true, force: true });
    lines = [];
    await reindex({ root, log });
    expect(output()).toContain("Rebuilt the index from 1 memory");
  });
});
