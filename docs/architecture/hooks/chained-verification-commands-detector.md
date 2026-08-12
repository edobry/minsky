# chained-verification-commands-detector

> Extracted from `.minsky/rules/hook-observers.mdc` (mt#4032) — full narration, scope boundary,
> and design rationale for this observer. The compiled rule corpus carries only a terse index
> entry; this file is the durable detail.

Flags a `Bash` / `session_exec` command string that chains **two or more verification commands**,
which makes a non-zero exit unattributable to any one of them.

- **Event:** `PreToolUse` on `Bash` and `mcp__minsky__session_exec`
- **Enforcement:** calibration-first — records, never denies.
- **Override:** `MINSKY_SKIP_CHAINED_VERIFICATION_SCAN=1`
- **Source:** `.minsky/hooks/chained-verification-commands-detector.ts`
- **Task:** mt#3910

## Why it exists

`terminal-command-best-practices.mdc §Verification Commands` says: one verification command per
call, output visible. The reason is diagnostic, not stylistic — `bun run lint && bun test` that
exits non-zero tells you a check failed and not WHICH, and the usual response is to re-run both
separately, so the chain saves nothing and costs a round.

That rule shipped at prose tier **twice** — mt#2371 and again mt#2571 — and did not contain its
class either time. R2 is recorded in mem#553. This is its mechanized tier.

## What counts as a verification command

`bun test`, `bun run lint|format|typecheck|validate|build`, `bunx eslint`, `bunx tsc`, `tsgo`.
Two or more of these joined by `;`, `&&`, or `||` in one command string is the fire.

## Deliberately narrow — three things that do NOT fire

- **A SINGLE verification command** wrapped in `echo` labels, or with a `cd` prefix. That is the
  common shape and firing on it would reproduce the mem#719 noise problem, where a detector
  emitting unmatchable output trains readers to discount its true positives.
- **Chained EXPLORATORY commands** — `ls && grep && cat` attributes nothing and loses nothing.
- **A `;` inside quotes.** The split is quote-aware, so quoted punctuation cannot manufacture a
  fire.

A **pipeline is classified by its FIRST stage**, which is also where the sibling pipe-eats-`$?`
footgun lives (memory `d2b5ced3`): `cmd | head; echo $?` reads `head`'s exit code, not `cmd`'s.

## Not an ADR-024 rung

ADR-024's ladder scopes to prose trigger-phrases, where quotation-elision and embedding recall are
the failure modes it exists to manage. Neither applies to parsing a command string: the input is
structured, the match is exact, and there is no paraphrase axis. So this ships calibration-first
without a rung ladder above it.

## Covers / Does NOT cover

**Covers:** two or more verification commands in one command string, joined by `;` / `&&` / `||`.

**Does NOT cover:** the same two commands issued as two separate tool calls in one batch (which is
fine — each exit code is attributable); output suppression (`>/dev/null` on a result you must
read), which is the sibling half of §Verification Commands and has no mechanized tier; and the
bulk-loop suppression shape recorded in mem#574.

## Cross-references

`.minsky/rules/terminal-command-best-practices.mdc §Verification Commands` (the rule this
mechanizes) · mem#553 (R2 at prose tier) · mem#574 (bulk-loop suppression sibling) · mem#719 (the
noise cost of an over-firing detector) ·
`docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md` (and why this is not
one of its rungs).
