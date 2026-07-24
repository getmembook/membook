import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, MAX_RECALL_HITS } from "./server.js";
import { FAKE_SECRETS as F } from "@membook/core";

let root: string;
let client: Client;

/** A real git repo, since `remember` anchors to HEAD. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "membook-mcp-"));
  const git = (args: string[]) => execa("git", args, { cwd: dir });
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/auth.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(dir, "src/db.ts"), "export const db = 1;\n", "utf8");
  await git(["add", "-A"]);
  await git(["commit", "-m", "init"]);
  return dir;
}

/** Connect a real MCP client to the server over an in-memory pair. */
async function connect(dir: string): Promise<Client> {
  const server = createServer({
    root: dir,
    agent: "test-agent",
    model: "test-model",
    session: "sess-test",
    now: () => new Date("2026-07-24T12:00:00Z"),
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    c.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return c;
}

async function callText(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

beforeEach(async () => {
  root = await makeRepo();
  client = await connect(root);
});

afterEach(async () => {
  await client.close();
  await rm(root, { recursive: true, force: true });
});

describe("tool surface", () => {
  it("exposes recall, remember and session_digest", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "recall",
      "remember",
      "session_digest",
    ]);
  });

  it("marks the read-only tools as read-only", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName["recall"]!.annotations?.readOnlyHint).toBe(true);
    expect(byName["session_digest"]!.annotations?.readOnlyHint).toBe(true);
    expect(byName["remember"]!.annotations?.readOnlyHint).toBe(false);
  });

  it("tells the agent when NOT to record something", async () => {
    const { tools } = await client.listTools();
    const remember = tools.find((t) => t.name === "remember")!;
    expect(remember.description).toMatch(/Do NOT record/);
  });
});

describe("remember", () => {
  it("stores a memory anchored to HEAD", async () => {
    const text = await callText("remember", {
      statement: "Auth tokens refresh on the request boundary, not on a timer.",
      type: "gotcha",
      paths: ["src/auth.ts"],
    });

    expect(text).toMatch(/Remembered as m-[0-9a-f]{4}/);
    expect(text).toContain("src/auth.ts");
    expect(text).toContain("unverified");
  });

  it("records it as unverified, because nothing has checked it yet", async () => {
    await callText("remember", {
      statement: "Auth tokens refresh on the request boundary.",
      type: "gotcha",
      paths: ["src/auth.ts"],
    });
    expect(await callText("session_digest", {})).toContain("1 unverified");
  });

  it("refuses a memory with no anchor", async () => {
    const result = await client.callTool({
      name: "remember",
      arguments: {
        statement: "Floating claim about nothing in particular.",
        type: "gotcha",
        paths: [],
      },
    });
    expect(result.isError).toBe(true);
  });

  // The scanner is launch-blocking, and this is the surface agents write
  // through. A guard that had to be opted into would protect nobody.
  it("blocks a credential by default, with no guard configured", async () => {
    const result = await client.callTool({
      name: "remember",
      arguments: {
        statement:
          `Publish releases with ${F.githubToken} from CI.`,
        type: "gotcha",
        paths: ["src/auth.ts"],
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/secret-scan|GitHub token/);
    // And it must not echo the credential back into logs or transcripts.
    expect(text).not.toContain(F.githubToken);
  });

  it("reports a rejected write rather than failing silently", async () => {
    const result = await client.callTool({
      name: "remember",
      arguments: {
        statement: "Bad anchor.",
        type: "gotcha",
        paths: ["/etc/passwd"],
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text?: string }>;
    expect(content[0]!.text).toMatch(/Not remembered/);
  });
});

describe("recall", () => {
  beforeEach(async () => {
    await callText("remember", {
      statement:
        "Auth tokens refresh on the request boundary, not on a timer, or sessions expire mid-flight.",
      type: "gotcha",
      paths: ["src/auth.ts"],
    });
    await callText("remember", {
      statement:
        "The database connection pool is capped at ten in development to surface leaks early.",
      type: "decision",
      paths: ["src/db.ts"],
    });
  });

  it("finds a relevant memory", async () => {
    const text = await callText("recall", {
      query: "auth token refresh boundary",
    });
    expect(text).toContain("request boundary");
    expect(text).toContain("src/auth.ts");
  });

  it("labels the memory type and id", async () => {
    const text = await callText("recall", {
      query: "auth token refresh boundary",
    });
    expect(text).toMatch(/\[gotcha \(unverified\)\] m-[0-9a-f]{4}/);
  });

  it("says plainly when it knows nothing, rather than returning noise", async () => {
    const text = await callText("recall", {
      query: "kubernetes ingress annotations",
    });
    expect(text).toMatch(/No memories recorded/);
  });

  it("does not pad the answer with weak matches", async () => {
    // Only one memory is about auth; the pool memory must not tag along.
    const text = await callText("recall", {
      query: "auth token refresh boundary",
    });
    expect(text).not.toContain("connection pool");
  });

  it("ranks by the files the agent is working on", async () => {
    const text = await callText("recall", {
      query: "development leaks early capped",
      paths: ["src/db.ts"],
    });
    expect(text).toContain("connection pool");
  });

  it("never exceeds the cap", async () => {
    const { tools } = await client.listTools();
    const recall = tools.find((t) => t.name === "recall")!;
    const schema = recall.inputSchema as {
      properties: { limit?: { maximum?: number } };
    };
    expect(schema.properties.limit?.maximum).toBe(MAX_RECALL_HITS);
  });
});

describe("stale memories are withheld, but their absence is explained", () => {
  beforeEach(async () => {
    await callText("remember", {
      statement:
        "Auth tokens refresh on the request boundary, not on a timer, or sessions expire mid-flight.",
      type: "gotcha",
      paths: ["src/auth.ts"],
    });
    // Change the anchored file, then let verify mark it stale.
    await writeFile(
      join(root, "src/auth.ts"),
      "export const a = 999;\n",
      "utf8"
    );
    await execa("git", ["add", "-A"], { cwd: root });
    await execa("git", ["commit", "-m", "rewrite auth"], { cwd: root });
    const { Membook } = await import("@membook/core");
    await new Membook(root).verify();
  });

  it("withholds the stale memory by default", async () => {
    const text = await callText("recall", {
      query: "auth token refresh boundary",
    });
    expect(text).not.toContain("request boundary");
  });

  it("explains that something was withheld and why", async () => {
    // The difference between "we know nothing" and "we know something we no
    // longer trust" is the whole product. An agent told only the former will
    // confidently re-derive a broken answer.
    const text = await callText("recall", {
      query: "auth token refresh boundary",
    });
    expect(text).toMatch(/stale/);
    expect(text).toMatch(/include_stale/);
  });

  it("serves it on request, flagged", async () => {
    const text = await callText("recall", {
      query: "auth token refresh boundary",
      include_stale: true,
    });
    expect(text).toContain("request boundary");
    expect(text).toMatch(/⚠ stale/);
    expect(text).toMatch(/not verified against current code/);
  });
});

describe("session_digest", () => {
  it("reports an empty repository honestly", async () => {
    expect(await callText("session_digest", {})).toMatch(
      /No memories recorded/
    );
  });

  it("counts memories by status", async () => {
    await callText("remember", {
      statement: "A durable fact about the auth module.",
      type: "gotcha",
      paths: ["src/auth.ts"],
    });
    const text = await callText("session_digest", {});
    expect(text).toMatch(/1 memory: 1 unverified/);
  });

  it("checks anchors without writing when asked to verify", async () => {
    await callText("remember", {
      statement: "A durable fact about the auth module.",
      type: "gotcha",
      paths: ["src/auth.ts"],
    });

    const text = await callText("session_digest", { verify: true });
    expect(text).toMatch(/would change status/);
    expect(text).toMatch(/unverified→verified/);

    // Dry run: the memory on disk is untouched.
    expect(await callText("session_digest", {})).toMatch(/1 unverified/);
  });
});
