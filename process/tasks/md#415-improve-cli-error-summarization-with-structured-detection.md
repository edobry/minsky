# Improve CLI Error Summarization with Structured Detection

## Status
BACKLOG

## Context
The CLI currently suppresses stderr/stdout and only prints a generic "Command failed" message, making it difficult to understand failure causes (e.g., linter errors, git errors). We want concise, high-signal summaries without dumping massive logs.

## Goals
- Provide a short, meaningful error summary for common tools (eslint, bun test, git) without parsing brittle free-form text.
- Prefer structured outputs/exit codes when available; otherwise, capture and truncate the first stderr line with guidance to re-run with `--debug`.
- Configurable verbosity under `logger` and `cli.errors`.

## Proposed Approach
- For tools we invoke directly, use structured modes:
  - eslint: `--format json` then summarize counts.
  - bun test: `--reporter json` (or minimal) then summarize failures.
  - git: detect common exit codes; include first stderr line if present.
- Add fallback: capture first line of stderr and truncate to 200 chars with suffix `…`.
- Add config flag: `cli.errors.mode: "concise" | "full" | "auto"` (default `concise`), and enable `--debug` to show full stderr/stdout.

## Acceptance Criteria
- When a command fails, CLI prints a one-line summary (e.g., "Linter errors in 3 files") and a hint: "rerun with --debug for details".
- Full logs appear when `--debug` is provided or `cli.errors.mode` is `full`.
- All existing commands continue to work; behavior is additive.

## Follow-ups
- Add unit tests for the error summarizer.
- Wire to session commands that wrap git and test/lint.

## References
- Related discussion: md#253 session
