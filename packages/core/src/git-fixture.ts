import { execa } from "execa";
import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Helpers for spawning throwaway git repositories the verify tests can
 * mutate — edit, rename, delete, revert — to assert every anchor transition
 * against real git behaviour rather than a mock.
 *
 * Rename detection is the whole reason the engine shells out to git, so
 * faking it here would test nothing.
 *
 * Test-only: not exported from the package entrypoint, so it never ships.
 */
export class GitFixture {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(): Promise<GitFixture> {
    const root = await mkdtemp(join(tmpdir(), "membook-git-"));
    const fixture = new GitFixture(root);
    await fixture.git(["init", "--initial-branch=main"]);
    // Local config only: fixtures must not depend on — or be slowed by — the
    // developer's global identity, and signing would demand a key.
    await fixture.git(["config", "user.name", "Fixture"]);
    await fixture.git(["config", "user.email", "fixture@example.test"]);
    await fixture.git(["config", "commit.gpgsign", "false"]);
    // Keep Membook's own storage out of the fixture's history. `commit()`
    // stages everything, and sweeping `.membook/` in means a `git revert`
    // would roll back the memory files along with the source change — the
    // fixture would be mutating the thing under test.
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(
      join(root, ".git", "info", "exclude"),
      ".membook/\n",
      "utf8"
    );
    return fixture;
  }

  async git(args: string[]): Promise<string> {
    const { stdout } = await execa("git", args, {
      cwd: this.root,
      stripFinalNewline: true,
    });
    return stdout;
  }

  async write(path: string, content: string): Promise<void> {
    const full = join(this.root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async commit(message: string): Promise<string> {
    await this.git(["add", "-A"]);
    await this.git(["commit", "-m", message, "--allow-empty"]);
    return this.head();
  }

  /** Write a file and commit it in one step. */
  async commitFile(
    path: string,
    content: string,
    message?: string
  ): Promise<string> {
    await this.write(path, content);
    return this.commit(message ?? `add ${path}`);
  }

  async edit(path: string, content: string): Promise<string> {
    await this.write(path, content);
    return this.commit(`edit ${path}`);
  }

  async rename(from: string, to: string): Promise<string> {
    await mkdir(dirname(join(this.root, to)), { recursive: true });
    await this.git(["mv", from, to]);
    return this.commit(`rename ${from} -> ${to}`);
  }

  async remove(path: string): Promise<string> {
    await this.git(["rm", "-q", path]);
    return this.commit(`delete ${path}`);
  }

  /** Delete outside git's index, then stage the deletion. */
  async removeUntracked(path: string): Promise<string> {
    await unlink(join(this.root, path));
    return this.commit(`delete ${path}`);
  }

  async revertLast(): Promise<string> {
    await this.git(["revert", "--no-edit", "HEAD"]);
    return this.head();
  }

  async head(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
