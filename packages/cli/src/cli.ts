#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { MEMORY_TYPES, type MemoryType } from "@membook/spec";
import { init } from "./commands/init.js";
import { status } from "./commands/status.js";
import { review } from "./commands/review.js";
import {
  book,
  migrate,
  recall,
  reindex,
  remember,
  verify,
} from "./commands/misc.js";
import { seed } from "./commands/seed.js";
import { distill } from "./commands/distill.js";
import { hookPrompt } from "./commands/hook.js";
import { die } from "./output.js";

/**
 * Read the version from package.json at runtime rather than hardcoding it.
 * The hardcoded string shipped 0.1.1 introducing itself as 0.1.0 — changesets
 * bumps the manifest, and a constant nobody remembers is wrong by the second
 * release, forever. dist/cli.js sits one level below package.json in the
 * published tarball, so the path holds exactly where the code runs.
 */
const VERSION: string = createRequire(import.meta.url)(
  "../package.json"
).version;

const program = new Command();

program
  .name("membook")
  .description(
    "Memory that stays true — durable project knowledge, anchored to code and checked against it."
  )
  .version(VERSION)
  .option(
    "-C, --cwd <path>",
    "run as if started in this directory",
    process.cwd()
  );

const root = (): string => program.opts<{ cwd: string }>().cwd;

program
  .command("init")
  .description("set this repository up for Membook")
  .option(
    "--hooks",
    "also install a Claude Code hook that recalls memory on every prompt"
  )
  .action(async (opts: { hooks?: boolean }) => {
    await init({
      root: root(),
      ...(opts.hooks === true ? { hooks: true } : {}),
    });
  });

/**
 * Machine-facing, not for humans: invoked by a harness hook, reads the
 * harness's JSON on stdin, and prints memory worth injecting. Hidden from
 * `--help` because typing it does nothing useful.
 */
program
  .command("hook", { hidden: true })
  .description("answer a harness hook (reads JSON on stdin)")
  .argument("<event>", "hook event; only `prompt` is supported")
  .action(async (event: string) => {
    if (event !== "prompt") return;
    await hookPrompt({ root: root() });
  });

program
  .command("status")
  .description("what is known, and how far to trust it")
  .option("--check", "also diff anchors against HEAD, without writing")
  .option(
    "-w, --workspace [manifest]",
    "report workspace members and resolve cross-repo anchors (default: ~/.membook/workspace.yaml)"
  )
  .action(async (opts: { check?: boolean; workspace?: string | true }) => {
    await status({
      root: root(),
      ...(opts.check ? { check: true } : {}),
      ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    });
  });

program
  .command("verify")
  .description("re-check memories against the current code")
  .option("--dry-run", "report what would change, write nothing")
  .option(
    "--recheck",
    "ask a model about drifted memories (needs ANTHROPIC_API_KEY or OPENAI_API_KEY)"
  )
  .option(
    "-m, --model <name>",
    "model to re-check with; overrides MEMBOOK_MODEL and the provider default"
  )
  .option(
    "-w, --workspace [manifest]",
    "resolve cross-repo anchors via a workspace manifest (default: ~/.membook/workspace.yaml)"
  )
  .action(
    async (opts: {
      dryRun?: boolean;
      recheck?: boolean;
      model?: string;
      workspace?: string | true;
    }) => {
      await verify({
        root: root(),
        ...(opts.dryRun ? { dryRun: true } : {}),
        ...(opts.recheck ? { recheck: true } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
      });
    }
  );

program
  .command("review")
  .description("ratify or delete memories no human has decided on")
  .option("--list", "list what needs review and exit, without prompting")
  .action(async (opts: { list?: boolean }) => {
    await review({ root: root(), ...(opts.list ? { list: true } : {}) });
  });

program
  .command("reindex")
  .description("rebuild the search index from the files")
  .action(async () => {
    await reindex({ root: root() });
  });

program
  .command("migrate")
  .description(
    "rewrite memories to the current memfile form, as a diff to review"
  )
  .option("--dry-run", "report what would be rewritten, write nothing")
  .action(async (opts: { dryRun?: boolean }) => {
    await migrate({ root: root(), ...(opts.dryRun ? { dryRun: true } : {}) });
  });

program
  .command("book")
  .description("regenerate MEMBOOK.md")
  .option(
    "-w, --workspace [manifest]",
    "resolve cross-repo anchors via a workspace manifest (default: ~/.membook/workspace.yaml)"
  )
  .action(async (opts: { workspace?: string | true }) => {
    await book({
      root: root(),
      ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    });
  });

program
  .command("distill")
  .description("turn session notes into candidate memories")
  .argument("[file]", "notes file; reads stdin when omitted")
  .option("--dry-run", "show what would be recorded, write nothing")
  .option("--model <model>", "override the model")
  .action(
    async (
      file: string | undefined,
      opts: { dryRun?: boolean; model?: string }
    ) => {
      await distill({
        root: root(),
        ...(file !== undefined ? { file } : {}),
        ...(opts.dryRun === true ? { dryRun: true } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      });
    }
  );

program
  .command("seed")
  .description("distill existing docs into candidate memories")
  .option("--dry-run", "show what would be recorded, write nothing")
  .option("-n, --max-files <n>", "how many documents to read", "12")
  .option("--model <model>", "override the model")
  .action(
    async (opts: { dryRun?: boolean; maxFiles: string; model?: string }) => {
      const maxFiles = Number(opts.maxFiles);
      if (!Number.isInteger(maxFiles) || maxFiles < 1) {
        die("--max-files must be a positive whole number.");
      }
      await seed({
        root: root(),
        maxFiles,
        ...(opts.dryRun === true ? { dryRun: true } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
      });
    }
  );

program
  .command("recall")
  .description("see what an agent would be served for a query")
  .argument("<query>", "what you want to know about")
  .option(
    "-p, --path <path...>",
    "files you are working on; memories anchored to them rank higher"
  )
  .option("--include-stale", "also show memories whose code has drifted")
  .option("-n, --limit <n>", "maximum memories to show", "8")
  .option(
    "-w, --workspace [manifest]",
    "also search workspace members' memories (default: ~/.membook/workspace.yaml)"
  )
  .action(
    async (
      query: string,
      opts: {
        path?: string[];
        includeStale?: boolean;
        limit: string;
        workspace?: string | true;
      }
    ) => {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        die("--limit must be a positive whole number.");
      }
      await recall({
        root: root(),
        query,
        limit,
        ...(opts.path !== undefined ? { paths: opts.path } : {}),
        ...(opts.includeStale === true ? { includeStale: true } : {}),
        ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
      });
    }
  );

program
  .command("remember")
  .description("record a memory yourself")
  .argument("<statement>", "the memory: terse, self-contained, claim first")
  .option(
    "-p, --path <path...>",
    "repo-relative file this is about (repeatable; required unless --scope user)"
  )
  .option(
    "--scope <scope>",
    "repo (anchored to this repository) or user (follows you, never committed)",
    "repo"
  )
  .option("-t, --type <type>", `one of: ${MEMORY_TYPES.join(", ")}`, "gotcha")
  .option("-s, --symbol <symbol>", "specific function or class, if any")
  .option("-c, --confidence <n>", "0 to 1", "0.9")
  .action(
    async (
      statement: string,
      opts: {
        path?: string[];
        scope: string;
        type: string;
        symbol?: string;
        confidence: string;
      }
    ) => {
      if (!(MEMORY_TYPES as readonly string[]).includes(opts.type)) {
        die(
          `Unknown type "${opts.type}".`,
          `Use one of: ${MEMORY_TYPES.join(", ")}`
        );
      }
      if (opts.scope !== "repo" && opts.scope !== "user") {
        die(`Unknown scope "${opts.scope}".`, "Use repo or user.");
      }
      const confidence = Number(opts.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        die(`Confidence must be a number between 0 and 1.`);
      }
      if (opts.scope === "repo" && !opts.path?.length) {
        die(
          "A repo memory needs at least one --path to anchor to.",
          "A preference with no file to point at is user scope: --scope user."
        );
      }
      await remember({
        root: root(),
        statement,
        type: opts.type as MemoryType,
        paths: opts.path ?? [],
        scope: opts.scope,
        ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
        confidence,
      });
    }
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  die((error as Error).message);
});
