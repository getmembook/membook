import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Membook } from "@membook/core";
import { init } from "./commands/init.js";
import { status } from "./commands/status.js";
import { review } from "./commands/review.js";
import { book, reindex, remember, verify } from "./commands/misc.js";

let root: string;
let lines: string[];
const log = (line: string): void => void lines.push(line);
const output = (): string => lines.join("\n");
// Assertions are about wording, not line breaks: wrap() is layout.
const flat = (): string => output().replace(/\s+/g, " ");

async function git(dir: string, args: string[]): Promise<void> {
  await execa("git", args, { cwd: dir });
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
