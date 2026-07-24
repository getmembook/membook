# Distillation Prompt — v0 (stub)

> This file is versioned and reviewed like code. The model-facing prompt for
> end-of-session distillation lives here. Changes to this file change product
> behaviour and require the same review rigor as a code change.

## Contract (to implement in build step 6)

- Input: session transcript (or digest) + existing memory ids/titles for dedup.
- Output: JSON array of candidate memories conforming to @membook/spec.
- Rejection is the default: emit a memory ONLY for durable, project-specific,
  non-obvious knowledge (decision | gotcha | convention | map | deadend).
- Every memory MUST name the files/symbols it is about (anchor candidates).
- Never include credentials, tokens, connection strings, or personal data.
- Statements: imperative, terse, self-contained, ≤ 2 sentences.
