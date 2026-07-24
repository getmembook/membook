import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DISTILL_SYSTEM, distill, sourceHash } from "./distill.js";
import { SEED_SYSTEM } from "./seed.js";
import { FAKE_SECRETS } from "./fake-secrets.js";
import { ProviderError, type ModelProvider } from "./provider.js";
import type { Instrumentation, MembookEvent } from "./instrumentation.js";

/** A provider that replies with whatever the test hands it, in order. */
function fakeProvider(replies: string[]): ModelProvider & { calls: number } {
  let index = 0;
  return {
    name: "fake",
    model: "fake-model",
    calls: 0,
    async complete() {
      this.calls += 1;
      const text = replies[index] ?? replies.at(-1) ?? "";
      index += 1;
      return { text, inputTokens: 10, outputTokens: 10 };
    },
  };
}

function failingProvider(): ModelProvider {
  return {
    name: "fake",
    model: "fake-model",
    async complete(): Promise<never> {
      throw new ProviderError("provider is down", 503);
    },
  };
}

class Recorder implements Instrumentation {
  readonly events: MembookEvent[] = [];
  record(event: MembookEvent): void {
    this.events.push(event);
  }
}

const reply = (memories: unknown[]): string => JSON.stringify({ memories });

const ONE = [
  {
    statement: "Deployment authenticates with OIDC, never a client secret.",
    type: "decision",
    paths: ["DEPLOYMENT.md"],
    confidence: 0.9,
  },
];

const source = { path: "DEPLOYMENT.md", content: "# Deployment\n\nOIDC only." };
const anyPathExists = async (): Promise<boolean> => true;
const noPathExists = async (): Promise<boolean> => false;

describe("distill", () => {
  it("keeps a well-formed, grounded candidate", async () => {
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply(ONE)]),
      pathExists: anyPathExists,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.type).toBe("decision");
    expect(result.failed).toBe(false);
  });

  it("hashes exactly what the model read", async () => {
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply([])]),
      pathExists: anyPathExists,
    });
    expect(result.sourceHash).toBe(sourceHash(source.content));
    expect(result.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts an empty answer as a correct one", async () => {
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply([])]),
      pathExists: anyPathExists,
    });
    expect(result.candidates).toEqual([]);
    expect(result.failed).toBe(false);
  });

  /**
   * THE GROUNDING GATE. Asked to cite files, a model will invent plausible
   * ones. An anchor to a path that does not exist can never be verified, so
   * the memory would be permanently unfalsifiable — the precise thing this
   * product exists to prevent.
   */
  it("discards a candidate whose anchors do not exist", async () => {
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply(ONE)]),
      pathExists: noPathExists,
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("ungrounded-anchor");
  });

  it("keeps only the anchors that are real", async () => {
    const mixed = [
      {
        statement: "Deployment authenticates with OIDC, never a client secret.",
        type: "decision",
        paths: ["DEPLOYMENT.md", "src/invented.ts"],
        confidence: 0.9,
      },
    ];
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply(mixed)]),
      pathExists: async (p) => p === "DEPLOYMENT.md",
    });

    expect(result.candidates[0]!.paths).toEqual(["DEPLOYMENT.md"]);
  });

  it("drops a candidate carrying a credential, and does not echo it", async () => {
    const leaky = [
      {
        statement: `Deploy using ${FAKE_SECRETS.githubToken} from CI.`,
        type: "gotcha",
        paths: ["DEPLOYMENT.md"],
        confidence: 0.9,
      },
    ];
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply(leaky)]),
      pathExists: anyPathExists,
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("secret");
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRETS.githubToken);
  });

  it("suppresses a statement already recorded", async () => {
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply(ONE)]),
      pathExists: anyPathExists,
      existing: ["deployment authenticates with OIDC never a client secret"],
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejected[0]!.reason).toBe("duplicate");
  });

  it("reads JSON out of a fenced reply", async () => {
    const fenced = "Here you go:\n```json\n" + reply(ONE) + "\n```";
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([fenced]),
      pathExists: anyPathExists,
    });
    expect(result.candidates).toHaveLength(1);
  });

  it("asks once more when the reply is unparseable, then succeeds", async () => {
    const provider = fakeProvider(["not json at all", reply(ONE)]);
    const result = await distill(source, SEED_SYSTEM, {
      provider,
      pathExists: anyPathExists,
    });

    expect(provider.calls).toBe(2);
    expect(result.repaired).toBe(true);
    expect(result.candidates).toHaveLength(1);
  });

  it("gives up after one repair rather than spending tokens forever", async () => {
    const provider = fakeProvider(["nope", "still nope", reply(ONE)]);
    const result = await distill(source, SEED_SYSTEM, {
      provider,
      pathExists: anyPathExists,
    });

    expect(provider.calls).toBe(2);
    expect(result.failed).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  // A distillation that fails must cost the user nothing. There is no safe
  // fallback that invents memories, so the only honest answer is none.
  it("returns nothing when the provider is down, rather than throwing", async () => {
    const result = await distill(source, SEED_SYSTEM, {
      provider: failingProvider(),
      pathExists: anyPathExists,
    });

    expect(result.failed).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it("rejects an unknown memory type", async () => {
    const bogus = [{ ...ONE[0]!, type: "hunch" }];
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply(bogus), reply(bogus)]),
      pathExists: anyPathExists,
    });
    expect(result.candidates).toEqual([]);
  });

  it("caps how many candidates one source may yield", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      statement: `A distinct durable claim number ${i} about this project.`,
      type: "convention",
      paths: ["DEPLOYMENT.md"],
      confidence: 0.7,
    }));
    const result = await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply(many)]),
      pathExists: anyPathExists,
      maxPerSource: 3,
    });
    expect(result.candidates).toHaveLength(3);
  });

  it("logs what it kept and what it refused", async () => {
    const recorder = new Recorder();
    await distill(source, SEED_SYSTEM, {
      provider: fakeProvider([reply(ONE)]),
      pathExists: noPathExists,
      instrumentation: recorder,
    });

    const event = recorder.events[0] as { event: string; rejected: number };
    expect(event.event).toBe("distill");
    expect(event.rejected).toBe(1);
  });

  it("logs the source path but never its content", async () => {
    const recorder = new Recorder();
    await distill(
      { path: "DEPLOYMENT.md", content: "a very secret internal document" },
      SEED_SYSTEM,
      {
        provider: fakeProvider([reply([])]),
        pathExists: anyPathExists,
        instrumentation: recorder,
      }
    );

    const line = JSON.stringify(recorder.events[0]);
    expect(line).toContain("DEPLOYMENT.md");
    expect(line).not.toContain("very secret internal document");
  });
});

/**
 * The prompt file claims to be "versioned and reviewed like code". That is
 * only true if the code actually uses what the file says — otherwise the
 * reviewed artifact and the shipped behaviour drift apart silently, and the
 * review is theatre.
 */
describe("the prompts match their reviewed files", () => {
  const systemSection = async (name: string): Promise<string> => {
    const file = await readFile(
      join(import.meta.dirname, `../../../prompts/${name}`),
      "utf8"
    );
    const marker = "## System prompt\n\n";
    const start = file.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    return file.slice(start + marker.length).trim();
  };

  it("seed is character-identical to prompts/seed.md", async () => {
    expect(await systemSection("seed.md")).toBe(SEED_SYSTEM.trim());
  });

  it("distill is character-identical to prompts/distill.md", async () => {
    expect(await systemSection("distill.md")).toBe(DISTILL_SYSTEM.trim());
  });

  /**
   * The two prompts do different jobs and must not quietly converge: a session
   * is mostly narration, documentation is mostly prose someone chose to keep.
   * If these ever became the same text, one of them would be wrong.
   */
  it("keeps the session prompt distinct from the documentation one", () => {
    expect(DISTILL_SYSTEM).not.toBe(SEED_SYSTEM);
    expect(DISTILL_SYSTEM).toMatch(/narrative form/);
    expect(SEED_SYSTEM).toMatch(/roadmap items/);
  });
});

/**
 * `git ls-files` emits POSIX separators on every platform. Matching on
 * `path.sep` therefore stops excluding anything on Windows — and Membook
 * would seed memories from its own memory files, which are markdown and
 * tracked. Caught by reading the Windows advisory job, not by a test failing.
 */
describe("seed source selection", () => {
  it("excludes Membook's own files using a POSIX separator", async () => {
    const { findSeedSources } = await import("./seed.js");
    const { tempRepo } = await import("./test-helpers.js");
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { execa } = await import("execa");

    const { root, cleanup } = await tempRepo();
    try {
      // tempRepo() is a bare directory; findSeedSources reads `git ls-files`.
      await execa("git", ["init", "--initial-branch=main"], { cwd: root });
      await execa("git", ["config", "user.name", "Fixture"], { cwd: root });
      await execa("git", ["config", "user.email", "f@e.test"], { cwd: root });
      await execa("git", ["config", "commit.gpgsign", "false"], { cwd: root });

      const long = `# Title\n\n${"Real documentation content. ".repeat(40)}`;
      await mkdir(join(root, ".membook/memories"), { recursive: true });
      await writeFile(join(root, ".membook/memories/m-0001.mem.md"), long);
      await writeFile(join(root, "MEMBOOK.md"), long);
      await writeFile(join(root, "ARCHITECTURE.md"), long);
      await execa("git", ["add", "-A"], { cwd: root });
      await execa("git", ["commit", "-m", "docs"], { cwd: root });

      const paths = (await findSeedSources(root)).map((s) => s.path);
      expect(paths).toContain("ARCHITECTURE.md");
      expect(paths).not.toContain("MEMBOOK.md");
      expect(paths.some((p) => p.startsWith(".membook/"))).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
