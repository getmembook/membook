#!/usr/bin/env node
import { Command } from "commander";
import { MEMORY_TYPES, type MemoryType } from "@membook/spec";
import { init } from "./commands/init.js";
import { status } from "./commands/status.js";
import { review } from "./commands/review.js";
import { book, reindex, remember, verify } from "./commands/misc.js";
import { die } from "./output.js";

const program = new Command();

program
  .name("membook")
  .description(
    "Memory that stays true — durable project knowledge, anchored to code and checked against it."
  )
  .version("0.1.0")
  .option(
    "-C, --cwd <path>",
    "run as if started in this directory",
    process.cwd()
  );

const root = (): string => program.opts<{ cwd: string }>().cwd;

program
  .command("init")
  .description("set this repository up for Membook")
  .action(async () => {
    await init({ root: root() });
  });

program
  .command("status")
  .description("what is known, and how far to trust it")
  .option("--check", "also diff anchors against HEAD, without writing")
  .action(async (opts: { check?: boolean }) => {
    await status({ root: root(), ...(opts.check ? { check: true } : {}) });
  });

program
  .command("verify")
  .description("re-check memories against the current code")
  .option("--dry-run", "report what would change, write nothing")
  .option(
    "--recheck",
    "ask a model about drifted memories (needs ANTHROPIC_API_KEY or OPENAI_API_KEY)"
  )
  .action(async (opts: { dryRun?: boolean; recheck?: boolean }) => {
    await verify({
      root: root(),
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.recheck ? { recheck: true } : {}),
    });
  });

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
  .command("book")
  .description("regenerate MEMBOOK.md")
  .action(async () => {
    await book({ root: root() });
  });

program
  .command("remember")
  .description("record a memory yourself")
  .argument("<statement>", "the memory: terse, self-contained, claim first")
  .requiredOption(
    "-p, --path <path...>",
    "repo-relative file this is about (repeatable)"
  )
  .option("-t, --type <type>", `one of: ${MEMORY_TYPES.join(", ")}`, "gotcha")
  .option("-s, --symbol <symbol>", "specific function or class, if any")
  .option("-c, --confidence <n>", "0 to 1", "0.9")
  .action(
    async (
      statement: string,
      opts: {
        path: string[];
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
      const confidence = Number(opts.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        die(`Confidence must be a number between 0 and 1.`);
      }
      await remember({
        root: root(),
        statement,
        type: opts.type as MemoryType,
        paths: opts.path,
        ...(opts.symbol !== undefined ? { symbol: opts.symbol } : {}),
        confidence,
      });
    }
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  die((error as Error).message);
});
