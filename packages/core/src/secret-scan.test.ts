import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import { computeMemoryId, type MemoryInput } from "@membook/spec";
import { MemoryStore } from "./store.js";
import { repoPaths } from "./paths.js";
import { WriteBlockedError } from "./errors.js";
import {
  SecretScanGuard,
  scanForSecrets,
  entropy,
  redact,
} from "./secret-scan.js";
import { tempRepo } from "./test-helpers.js";
import { FAKE_SECRETS as F } from "./fake-secrets.js";

let root: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ root, cleanup } = await tempRepo());
});

afterEach(async () => {
  await cleanup();
});

const COMMIT = "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";

function memoryFor(body: string): MemoryInput {
  return {
    memfile: 2,
    id: computeMemoryId(body),
    type: "gotcha",
    status: "unverified",
    scope: "repo",
    confidence: 0.9,
    created: "2026-07-21T16:42:00Z",
    anchors: [{ path: "src/a.ts", commit: COMMIT }],
    provenance: {
      origin: "authored",
      author: "agent",
      session: "s",
      agent: "claude-code",
      model: "claude-opus-4-8",
    },
  };
}

/**
 * The asymmetry that shapes every judgement call: a false positive costs a
 * human glance, a false negative commits a credential forever.
 */
describe("INVARIANT: real credentials never reach disk", () => {
  const secrets: Array<[string, string]> = [
    ["aws-access-key", `Deploy with ${F.awsKey} and it works.`],
    [
      "github-token",
      `Use ${F.githubToken} for the release.`,
    ],
    ["slack-token", `Webhook uses ${F.slackToken}.`],
    ["stripe-key", `Billing key ${F.stripeKey}.`],
    // AIza + exactly 35 characters, as Google actually issues them.
    ["google-api-key", `Maps needs ${F.googleKey}.`],
    ["openai-key", `Set ${F.openAiKey} in the env.`],
    ["anthropic-key", `Set ${F.anthropicKey} in the env.`],
    [
      "npm-token",
      `Publish with ${F.npmToken}.`,
    ],
    [
      "private-key",
      `The file starts ${F.privateKeyHeader} and so on.`,
    ],
    [
      "jwt",
      `Send ${F.jwt} as the bearer.`,
    ],
    [
      "connection-string-password",
      `Connect to postgres://admin:${F.dbPassword}@db.internal:5432/prod for the dump.`,
    ],
    ["assigned-secret", `Set api_key = "${F.assignedValue}" before booting.`],
  ];

  it.each(secrets)("blocks a %s", async (rule, body) => {
    const store = new MemoryStore(repoPaths(root), {
      guards: [new SecretScanGuard()],
    });
    await expect(store.write(memoryFor(body), body)).rejects.toThrow(
      WriteBlockedError
    );
    expect(scanForSecrets(body).map((f) => f.rule)).toContain(rule);
  });

  it("writes nothing at all when it blocks", async () => {
    const paths = repoPaths(root);
    const store = new MemoryStore(paths, { guards: [new SecretScanGuard()] });
    const body = `Deploy with ${F.awsKey} and it works.`;
    await expect(store.write(memoryFor(body), body)).rejects.toThrow();
    await expect(readdir(paths.memories)).rejects.toThrow();
  });

  it("scans frontmatter too, not only the statement", async () => {
    // A secret pasted into an anchor path is committed just the same.
    const store = new MemoryStore(repoPaths(root), {
      guards: [new SecretScanGuard()],
    });
    const body = "An innocent statement.";
    const memory = memoryFor(body);
    memory.anchors = [
      {
        path: `src/${F.githubToken}.ts`,
        commit: COMMIT,
      },
    ];
    await expect(store.write(memory, body)).rejects.toThrow(WriteBlockedError);
  });

  it("names the rule that fired", async () => {
    const store = new MemoryStore(repoPaths(root), {
      guards: [new SecretScanGuard()],
    });
    const body = `Deploy with ${F.awsKey}.`;
    try {
      await store.write(memoryFor(body), body);
      expect.unreachable("should have thrown");
    } catch (error) {
      const err = error as WriteBlockedError;
      expect(err.guard).toBe("secret-scan");
      expect(err.findings[0]!.rule).toBe("aws-access-key");
    }
  });
});

describe("redaction", () => {
  it("never echoes the full secret back", () => {
    const secret = F.awsKey;
    const findings = scanForSecrets(`Key is ${secret}.`);
    expect(findings[0]!.message).not.toContain(secret);
  });

  it("shows enough to locate it", () => {
    expect(redact(F.awsKey)).toMatch(/^AKIA\*+$/);
  });
});

/**
 * The scanner is deny-biased, not indiscriminate. If ordinary engineering
 * prose could not be written, nobody would keep it switched on — and a
 * scanner that gets disabled protects nothing.
 */
describe("ordinary memories still get written", () => {
  const innocent = [
    "Load better-sqlite3 after setting PRAGMA journal_mode WAL, or sessions deadlock.",
    "The auth token refreshes on the request boundary, not on a timer.",
    "Store the api_key in the environment, never in the repository.",
    "Rotate credentials quarterly; the password policy lives in the ops runbook.",
    "Use process.env.GITHUB_TOKEN rather than hardcoding anything.",
    "Connect to postgres://localhost:5432/dev for local work.",
    'Set api_key = "<your-key-here>" in the sample config.',
    'The example uses token: "changeme" and must be replaced before deploy.',
  ];

  it.each(innocent)("allows: %s", async (body) => {
    const store = new MemoryStore(repoPaths(root), {
      guards: [new SecretScanGuard()],
    });
    await expect(store.write(memoryFor(body), body)).resolves.toBeDefined();
  });
});

describe("entropy", () => {
  it("scores random strings above prose", () => {
    expect(entropy("9fKq2mZx7Lp4Rv8Tn3Wb")).toBeGreaterThan(
      entropy("aaaaaaaaaaaa")
    );
  });

  it("is zero for a single repeated character", () => {
    expect(entropy("aaaa")).toBe(0);
  });
});

describe("the guard seam", () => {
  it("drops in without changing any call site", async () => {
    // Same MemoryStore constructor the no-op guard used since step 2.
    const store = new MemoryStore(repoPaths(root), {
      guards: [new SecretScanGuard()],
    });
    const body = "A perfectly ordinary durable fact.";
    await expect(store.write(memoryFor(body), body)).resolves.toBeDefined();
  });
});
