import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceManifestError, parseWorkspaceManifest } from "./workspace.js";

const MANIFEST = `workspace: stag-main
members:
  payments-service:
    path: ~/dev/payments
    remote: git@github.com:acme/payments-service.git
  platform-gateway:
    path: ~/dev/gateway
`;

describe("workspace manifest", () => {
  it("parses the documented shape", () => {
    const manifest = parseWorkspaceManifest(MANIFEST);
    expect(manifest.workspace).toBe("stag-main");
    expect(Object.keys(manifest.members)).toEqual([
      "payments-service",
      "platform-gateway",
    ]);
    expect(manifest.members["payments-service"]!.remote).toBe(
      "git@github.com:acme/payments-service.git"
    );
    expect(manifest.members["platform-gateway"]!.remote).toBeUndefined();
  });

  it("parses the golden example", async () => {
    const source = await readFile(
      join(import.meta.dirname, "../examples/workspace.yaml"),
      "utf8"
    );
    expect(() =>
      parseWorkspaceManifest(source, "workspace.yaml")
    ).not.toThrow();
  });

  // Member names travel in committed files and end up as cache keys, so the
  // grammar is standard-surface: lowercase, no separators that serialized
  // anchor forms would have to escape.
  it("rejects names that would not survive as identifiers", () => {
    for (const name of ["Payments", "a/b", "a:b", "-lead", "", "a b"]) {
      const source = `workspace: w\nmembers:\n  "${name}":\n    path: /x\n`;
      expect(() => parseWorkspaceManifest(source), name).toThrow(
        WorkspaceManifestError
      );
    }
  });

  it("rejects an empty resolution table", () => {
    expect(() => parseWorkspaceManifest("workspace: w\nmembers: {}\n")).toThrow(
      /at least one member/
    );
  });

  it("rejects unknown keys loudly", () => {
    const source = `workspace: w\nmembers:\n  a:\n    path: /x\n    branch: main\n`;
    expect(() => parseWorkspaceManifest(source)).toThrow(
      WorkspaceManifestError
    );
  });

  it("rejects unparseable YAML as such, naming the file", () => {
    try {
      parseWorkspaceManifest("workspace: [unclosed", "workspace.yaml");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceManifestError);
      expect((error as WorkspaceManifestError).file).toBe("workspace.yaml");
      expect((error as Error).message).toMatch(/unparseable YAML/);
    }
  });

  it("lists every issue, with paths", () => {
    const source = `workspace: W!\nmembers:\n  a:\n    path: ""\n`;
    try {
      parseWorkspaceManifest(source);
      expect.unreachable("should have thrown");
    } catch (error) {
      const issues = (error as WorkspaceManifestError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(issues.join("\n")).toMatch(/workspace/);
      expect(issues.join("\n")).toMatch(/members\.a\.path/);
    }
  });
});
