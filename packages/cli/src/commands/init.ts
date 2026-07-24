import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Membook, isGitRepository, repoPaths } from "@membook/core";
import { die, heading, dim, ok, wrap } from "../output.js";

/**
 * Everything Membook needs gitignored. Only `memories/` and `MEMBOOK.md` are
 * committed — the rest is derived and disposable by design.
 */
const IGNORE_BLOCK = [
  "# Membook: the index is a disposable cache, never canonical.",
  "# .membook/memories/ and MEMBOOK.md ARE committed — files are the truth.",
  ".membook/index/",
  ".membook/quarantine/",
  ".membook/telemetry/",
];

async function ensureGitignore(
  root: string
): Promise<"added" | "present" | "created"> {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) {
    await writeFile(path, `${IGNORE_BLOCK.join("\n")}\n`, "utf8");
    return "created";
  }
  const current = await readFile(path, "utf8");
  if (current.includes(".membook/index/")) return "present";
  const separator = current.endsWith("\n") ? "" : "\n";
  await writeFile(
    path,
    `${current}${separator}\n${IGNORE_BLOCK.join("\n")}\n`,
    "utf8"
  );
  return "added";
}

export interface InitOptions {
  root: string;
  /** Write output through this, so tests can capture it. */
  log?: (line: string) => void;
}

export async function init(options: InitOptions): Promise<void> {
  const { root } = options;
  const log =
    options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  if (!(await isGitRepository(root))) {
    die(
      "Not a git repository.",
      "Membook anchors every memory to a commit, so it needs one. Run `git init` first."
    );
  }

  const paths = repoPaths(root);
  const alreadyHad = existsSync(paths.memories);
  await mkdir(paths.memories, { recursive: true });
  const ignore = await ensureGitignore(root);

  // Write the book immediately, even though it is empty. It is the file
  // other agents discover by convention, and an empty one that explains
  // itself is better than a missing one that explains nothing.
  const membook = new Membook(root);
  await membook.writeBook();

  log("");
  log(heading("Membook is set up."));
  log("");
  log(
    ok(
      alreadyHad
        ? ".membook/memories/ already existed, left alone"
        : "Created .membook/memories/ — your memories live here, in git"
    )
  );
  log(
    ok(
      ignore === "present"
        ? ".gitignore already covers the derived files"
        : `${
            ignore === "created" ? "Created" : "Updated"
          } .gitignore for the index, quarantine and telemetry`
    )
  );
  log(ok("Wrote MEMBOOK.md — agents read this even without Membook installed"));
  log("");
  log(heading("Connect your agent"));
  log("");
  log(dim("  claude mcp add membook -- npx -y @membook/mcp"));
  log("");
  log(
    wrap(
      "Or point any MCP client at `npx -y @membook/mcp`. The server spawns per session and exits with it — no daemon, no ports.",
      76
    )
  );
  log("");
  log(heading("Then"));
  log("");
  log(dim("  membook status    what is known, and how far to trust it"));
  log(dim("  membook verify    re-check memories against the current code"));
  log(
    dim("  membook review    ratify or reject memories a human has not seen")
  );
  log("");
  log(
    wrap(
      "Commit .membook/memories/ and MEMBOOK.md. Memories are reviewed in pull requests like any other change — that is the point of keeping them as files.",
      76
    )
  );
  log("");
}
