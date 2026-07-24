# CLAUDE.md — Membook

> This file is the build context for the Membook repository. It is written to be read by coding agents (Claude Code, Cursor, Codex) and humans alike. Keep it under control: stable decisions live here; session learnings go in `.membook/` once the tool can eat its own dog food.

## What Membook is

Membook is a **verifiable memory engine for coding agents**, MIT-licensed, local-first, distributed on npm (`npx membook init`). It captures knowledge from agent sessions, distills it into typed memories, **anchors every memory to checkable reality (git commits, paths, symbols)**, detects staleness by diffing anchors against HEAD, and serves all agents through one MCP server. Canonical storage is plain markdown files committed to the repo; a SQLite index is a disposable cache. Tagline: *memory that stays true.*

The differentiator is the **verification loop** — no product in the market verifies memories against code state (validated by deep research, July 2026). The commercial future (NOT this repo, yet) is a self-hosted org-graph server for regulated enterprises. This repo is the free core: single-repo, laptop-only, forever MIT.

**Positioning discipline:** we sell prevented wrong-path loops and reclaimed engineering hours, never token savings (prompt caching makes saved tokens nearly free — research-validated). All claims must be falsifiable via built-in local instrumentation.

## Non-negotiable architecture decisions (do not relitigate)

1. **Files are the truth; the database is a cache.** Canonical memories = one markdown file each in `.membook/memories/`. SQLite (+sqlite-vec, FTS5) is derived, disposable, rebuilt bit-perfect by `membook reindex`. Never store canonical state in the DB.
2. **No daemon.** MCP server spawns on stdio per session and exits. CLI runs and exits. Nothing resident, no ports, no background processes.
3. **Plain `git` CLI via execa** for all git operations (diff, log --follow, rev-parse). No libgit2 bindings, no isomorphic-git.
4. **The anchor is the product.** Every memory carries ≥1 anchor: `{path, symbol?, line_range?, commit}` where commit = last-verified SHA. Verification = `git diff --name-status <commit>..HEAD` intersected with anchor paths; untouched → free re-verify, touched → single targeted LLM re-check → verified | stale | invalidated. Anchors are pluggable by design (git first; lockfile-hash and API-contract anchors come in v0.2).
5. **Secret scanning on the write path is launch-blocking.** Gitleaks-class regex scan of every distillation output before anything is written under `.membook/`. A leaked secret in a committed memory file is a product-killing failure.
6. **Local-only instrumentation from day one.** Log recall events, hits/misses, staleness flips, verification outcomes to a local file. No network telemetry, ever.
7. **Boot pack ("the compiled book") is hard-capped at ~2,000 tokens**, greedy-ranked by expected-value-per-token, stable ordering (prompt-cache-friendly), emitted as `MEMBOOK.md` at repo root so agents WITHOUT Membook installed still benefit (AGENTS.md-style zero-integration interop).
8. **MIT everywhere.** Stated in every package.json. Genuine openness is a marketed differentiator vs Elastic-licensed competitors.

## The Memfile standard

- Individual memories: `*.mem.md` — YAML frontmatter (machine layer) + markdown body (human statement). Renders on GitHub, diffs in PRs, greps by suffix.
- Frontmatter fields: `memfile: 1` (spec version), `id`, `type` (decision | gotcha | convention | map | deadend), `status` (unverified | verified | stale | invalidated), `scope` (repo | user | team), `anchors[]`, `confidence`, `created`, `verified`, `provenance {session, agent, model, source_hash}`, `supersedes?`.
- Compiled book: generated `MEMBOOK.md` at repo root. Never hand-edited; regenerated.
- The spec lives in `@membook/spec` as Zod definitions + exported JSON Schema + validator, published independently. Design it as a standard; market it as "our format, free to implement." Deterministic serialization (stable key order) so diffs stay clean.
- Filenames: content-addressed short ids, e.g. `m-4f2a.mem.md`.

## Repository layout (pnpm monorepo)

```
membook/
├── CLAUDE.md                  # this file
├── package.json               # pnpm workspaces, MIT
├── packages/
│   ├── spec/                  # @membook/spec — BUILD FIRST. Zod schema, anchor grammar, validator, golden examples
│   ├── core/                  # @membook/core — engine: store, index, distill, anchor, verify, retrieve. Zero I/O opinions, fully unit-testable
│   ├── mcp/                   # @membook/mcp — thin stdio MCP server wrapping core (tools: remember, recall, session_digest)
│   └── cli/                   # membook — CLI binary wrapping core (init, status, review, verify, reindex)
├── fixtures/                  # fixture git repos for the invalidation test harness
└── .membook/                  # dogfood: this repo's own memories, once functional
```

## Stack (decided)

TypeScript strict, ESM-only, Node ≥20 (Bun-compatible, not Bun-targeted). pnpm workspaces. better-sqlite3 (synchronous, WAL) + sqlite-vec + FTS5 (BM25). gray-matter + yaml for frontmatter; Zod validation on read AND write (malformed files fail loudly at write time). fastembed-js local embeddings (bge-small class ONNX, downloaded once, offline after; embedding dims pinned in index metadata — model swap triggers clean reindex). Distillation via thin provider adapters (Anthropic + OpenAI-compatible, plain fetch, ~100 lines each — NO LangChain or agent frameworks); structured output validated against spec with retry-on-parse-failure; rejection threshold lives in a versioned prompt file in-repo. commander + picocolors for CLI (no TUI). vitest; tsup builds; changesets; GitHub Actions matrix macOS/Linux (build Windows, don't gate on it).

## v0.1 scope — build in this order

1. **@membook/spec** — schema, anchor grammar, validator, 5+ golden example files (one per memory type). *Accept: malformed file fails validation loudly on read and write.*
2. **Store + index in core** — file CRUD, deterministic serialization, SQLite index, `reindex`. *Accept: delete DB → reindex → retrieval results identical.*
3. **MCP server** — remember / recall (hybrid: vector + BM25 + recency + path-proximity to files the agent is touching, capped response) / session_digest. *Accept: end-to-end session in Claude Code and Cursor against a real repo.*
4. **Verify pass + fixture harness** — the crown jewel. Fixture git repos programmatically mutated (edit, rename via `--follow`, delete, revert) asserting correct verified/stale/invalidated transitions. *Accept: THE SIGNATURE DEMO — agent stores a gotcha anchored to a file; file is renamed; `membook status` reports 1 stale; next session's MEMBOOK.md carries the corrected memory.*
5. **Boot pack generator** → `MEMBOOK.md`.
6. **Distillation + secret scanning + instrumentation.**
7. **Dogfood** on a real active repo for 2 weeks. *Release gate: cold `npx membook init` works on a clean machine; signature demo runs unrehearsed; instrumentation shows non-zero hit rate and ≥1 genuine staleness catch; zero secrets ever written.*

## Explicitly OUT of v0.1 (do not build, do not scaffold "for later")

Passive transcript capture; org graph / server / sync / RBAC; non-git verifiers (v0.2, committed); graph-provider integration; Codex/Windsurf/Cline verification; registry; any UI; Windows CI gating; benchmark publication; the digest-skill distillation path (prototype OK, not a gate).

## Conventions

- Conventional commits. Small PRs even solo (the repo's own PR-reviewed memory workflow is the product's story — model it).
- Tests colocated `*.test.ts`; fixture harness under `fixtures/` with helpers to spawn temp git repos.
- Errors: fail loudly with actionable messages; never silently skip a malformed memory — quarantine to `.membook/quarantine/` and report in `status`.
- Every LLM call: validated structured output, one retry with repair prompt, then quarantine. Log token counts to instrumentation.
- No new runtime dependencies without strong justification — install weight is a feature (`npx membook init` must stay fast).
- Naming in code: "memory" (the record), "anchor", "book" (compiled boot pack), "verify pass", "distill". Avoid "note", "fact", "knowledge item".

## Context that saves you research

- Naming history: Lore (collision: Epic Games VCS) → Lorekit (collision: existing MCP project) → Mnema/Orma explored → **Membook** (npm `membook` + `membook-mcp` verified free July 2026; distant collisions only: Finnish association SaaS, retired AR app). Fallbacks documented: Mnema, Samskara, Smruti, Smarak.
- Closest architectural twin: EverMind EverOS (markdown-first + SQLite + hybrid retrieval). Our storage is sound but NOT novel — the verification loop is the only moat. Never cut scope from verification to polish storage.
- Closest coding-memory competitor: ByteRover Cipher (Elastic 2.0, team cloud sync, no verification). Native platform memory (Claude Code auto-memory default-on, Codex Memories) absorbs single-user value — v0.1 exists to prove the loop and seed the standard, not to win single-user.
- Economics (research-corrected): break-even reuse probability for writing a memory ≈ 3–6% — write generously, but retrieval precision is the binding constraint (a wrong retrieval risks a poisoned loop, ~7× per-step error inflation per published research). Hence aggressive distillation rejection.
