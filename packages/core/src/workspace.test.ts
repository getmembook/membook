import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseWorkspaceManifest } from "@membook/spec";
import { GitFixture } from "./git-fixture.js";
import {
  canonicalRemote,
  defaultWorkspacePath,
  resolveWorkspace,
  resolveWorkspaceFile,
} from "./workspace.js";

describe("canonicalRemote", () => {
  // The SSH and HTTPS forms of a repository are the same identity; a
  // resolver that treats them as different rejects correct workspaces.
  it("normalises transport away", () => {
    const forms = [
      "git@github.com:acme/payments.git",
      "https://github.com/acme/payments.git",
      "https://github.com/acme/payments",
      "ssh://git@github.com/acme/payments.git",
      "ssh://git@github.com:2222/acme/payments.git",
      "https://token@GitHub.com/Acme/Payments.git",
      "git://github.com/acme/payments.git",
    ];
    for (const form of forms) {
      expect(canonicalRemote(form), form).toBe("github.com/acme/payments");
    }
  });

  it("keeps different repositories different", () => {
    const a = canonicalRemote("git@github.com:acme/payments.git");
    expect(a).not.toBe(canonicalRemote("git@github.com:acme/gateway.git"));
    expect(a).not.toBe(canonicalRemote("git@gitlab.com:acme/payments.git"));
  });

  // Local filesystems do make case distinctions, so path identities keep
  // their case, unlike hosted ones.
  it("treats filesystem remotes as paths, case preserved", () => {
    expect(canonicalRemote("/srv/Git/payments/")).toBe("/srv/Git/payments");
    expect(canonicalRemote("file:///srv/git/payments.git")).toBe(
      "srv/git/payments"
    );
  });

  it("returns null for nothing", () => {
    expect(canonicalRemote("")).toBeNull();
    expect(canonicalRemote("   ")).toBeNull();
  });
});

describe("resolveWorkspace", () => {
  let fixtures: GitFixture[];
  let scratch: string;

  beforeEach(async () => {
    fixtures = [];
    scratch = await mkdtemp(join(tmpdir(), "membook-ws-"));
  });

  afterEach(async () => {
    for (const f of fixtures) await f.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  async function repo(origin?: string): Promise<GitFixture> {
    const fixture = await GitFixture.create();
    fixtures.push(fixture);
    await fixture.commitFile("src/index.ts", "export {};\n");
    if (origin) await fixture.git(["remote", "add", "origin", origin]);
    return fixture;
  }

  function manifest(
    members: string
  ): ReturnType<typeof parseWorkspaceManifest> {
    return parseWorkspaceManifest(`workspace: test\nmembers:\n${members}`);
  }

  it("confirms identity across transport forms", async () => {
    const payments = await repo("https://github.com/acme/payments.git");
    const resolved = await resolveWorkspace(
      manifest(
        `  payments:\n    path: ${payments.root}\n    remote: git@github.com:acme/payments.git\n`
      )
    );
    expect(resolved.members).toEqual([
      {
        name: "payments",
        path: payments.root,
        state: "resolved",
        identity: "confirmed",
      },
    ]);
  });

  // No origin at all is not a mismatch. A local-only repo is legitimate:
  // resolve by path, say the identity went unconfirmed.
  it("resolves a local-only repo with identity unconfirmed", async () => {
    const local = await repo();
    const resolved = await resolveWorkspace(
      manifest(
        `  local:\n    path: ${local.root}\n    remote: git@github.com:acme/local.git\n`
      )
    );
    expect(resolved.members[0]).toMatchObject({
      state: "resolved",
      identity: "unconfirmed",
    });
  });

  // "Nothing to check" and "checked and passed" are different facts.
  it("reports an undeclared remote as undeclared, not as confirmed", async () => {
    const bare = await repo("https://github.com/acme/bare.git");
    const resolved = await resolveWorkspace(
      manifest(`  bare:\n    path: ${bare.root}\n`)
    );
    expect(resolved.members[0]).toMatchObject({
      state: "resolved",
      identity: "undeclared",
    });
  });

  it("refuses a checkout whose origin names a different repository", async () => {
    const wrong = await repo("git@github.com:acme/gateway.git");
    const resolved = await resolveWorkspace(
      manifest(
        `  payments:\n    path: ${wrong.root}\n    remote: git@github.com:acme/payments.git\n`
      )
    );
    const member = resolved.members[0]!;
    expect(member.state).toBe("remote-mismatch");
    if (member.state === "remote-mismatch") {
      expect(member.declared).toBe("git@github.com:acme/payments.git");
      expect(member.found).toBe("git@github.com:acme/gateway.git");
      expect(member.reason).toContain("wrong repository");
    }
  });

  // Resolution failures are per-member and non-fatal: an absent member must
  // not cost the resolution of a present one.
  it("resolves what it can when a member is missing", async () => {
    const present = await repo();
    const resolved = await resolveWorkspace(
      manifest(
        `  gone:\n    path: ${join(scratch, "nowhere")}\n  here:\n    path: ${
          present.root
        }\n`
      )
    );
    expect(resolved.members.map((m) => [m.name, m.state])).toEqual([
      ["gone", "absent"],
      ["here", "resolved"],
    ]);
    const gone = resolved.members[0]!;
    if (gone.state === "absent") {
      expect(gone.reason).toContain("on this machine");
    }
  });

  it("distinguishes a directory that is not a repository from an absent one", async () => {
    const plain = join(scratch, "plain");
    await mkdir(plain);
    const resolved = await resolveWorkspace(
      manifest(`  plain:\n    path: ${plain}\n`)
    );
    expect(resolved.members[0]).toMatchObject({
      state: "not-a-repository",
    });
  });

  it("orders members by name regardless of manifest order", async () => {
    const resolved = await resolveWorkspace(
      manifest(
        `  zebra:\n    path: ${join(scratch, "z")}\n  alpha:\n    path: ${join(
          scratch,
          "a"
        )}\n`
      )
    );
    expect(resolved.members.map((m) => m.name)).toEqual(["alpha", "zebra"]);
  });

  it("expands ~ against the injected home", async () => {
    const home = await repo();
    const resolved = await resolveWorkspace(
      manifest(`  tilde:\n    path: ~/checkout\n`),
      { home: home.root }
    );
    expect(resolved.members[0]!.path).toBe(join(home.root, "checkout"));
    expect(resolved.members[0]!.state).toBe("absent");
  });

  // A committed meta-repo manifest carries its members with it: relative
  // paths resolve against the manifest's own directory.
  it("resolves a manifest file with relative member paths", async () => {
    const member = await repo();
    // The fixture and the scratch dir share a parent, so from the manifest's
    // directory the member is one level up under its own basename.
    const file = join(scratch, "workspace.yaml");
    await writeFile(
      file,
      `workspace: meta\nmembers:\n  member:\n    path: ${join(
        "..",
        basename(member.root)
      )}\n`,
      "utf8"
    );
    const resolved = await resolveWorkspaceFile(file);
    expect(resolved.members[0]!.path).toBe(member.root);
    expect(resolved.members[0]!.state).toBe("resolved");
  });

  it("defaults the manifest to ~/.membook/workspace.yaml", () => {
    expect(defaultWorkspacePath("/home/dev")).toBe(
      "/home/dev/.membook/workspace.yaml"
    );
  });
});
