# Growth-Justification Merge Gate

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A PreToolUse hook (mt#2874) on `mcp__minsky__session_pr_merge` that PRICES always-loaded
context growth at the SOURCE — the PR that causes it — rather than only surfacing it at
merge time when the aggregate corpus (`CLAUDE.md`) crosses a global threshold.

## Why this exists

mt#2802 shipped an aggregate size-budget check (`rules compile --check`) that reports
`CLAUDE.md`'s total size on every compile and hard-fails `--check` mode once it crosses a
warn/fail threshold (currently 115K warn / 140K fail). That check makes regrowth
_visible_, but it puts the _cost_ of hitting the ceiling on whichever agent happens to be
the one who merges the PR that tips the corpus over — not on the author whose PR actually
added the content. A PR that adds 3,000 bytes of always-loaded rule text to `hook-files.mdc`
looks the same as a one-line typo fix to every gate EXCEPT the aggregate check, and that
check doesn't fire until the corpus is already near its ceiling — sometimes weeks after
the growth landed (see mt#2801/mt#2873/mt#2874's own originating incident: `hook-files.mdc`
regrew from a freshly-trimmed 14,995 bytes to 15,868 bytes across two ordinary guard-PRs in
under a day, with no signal at either merge).

This gate closes that gap: it prices growth **at the PR that causes it**, not at the PR
that happens to cross the aggregate line.

## Trigger

Both conditions must hold:

1. The PR's diff touches at least one file under `.minsky/rules/**` (added, modified,
   removed, or renamed into/out of the directory).
2. The compiled `CLAUDE.md`'s size grows by MORE than `GROWTH_THRESHOLD_BYTES` (2,000
   bytes) between the PR's merge-base and its head.

**Unit note (R1 fix — was previously mislabeled "chars"):** this gate measures BYTES —
GitHub's contents API `.size` field, the same server-side byte count `wc -c` reports — NOT
`content.length` (JS string length / UTF-16 code units), which is what the SIBLING mt#2802
aggregate size-budget module (`size-budget.ts`) measures and correctly calls "chars." The
two units diverge for any multi-byte UTF-8 character (em dashes, arrows — common in this
repo's rule prose): one UTF-16 code unit but 3 bytes each. Every identifier in this hook
(`GROWTH_THRESHOLD_BYTES`, `deltaBytes`, `headSizeBytes`/`baseSizeBytes`) and every deny
message says "bytes" precisely because that's what's actually being compared.

**Reductions never trigger.** `deltaBytes = headSizeBytes - baseSizeBytes`; the gate only
evaluates the marker requirement when `deltaBytes > GROWTH_THRESHOLD_BYTES`. A PR that
trims `CLAUDE.md` — even a large trim — is always silently allowed, regardless of whether
it also touches `.minsky/rules/**`. This is deliberate: penalizing a trim would create a
perverse incentive against exactly the corrective work this gate exists to encourage.

**Non-rules-touching PRs are always silent**, even if `CLAUDE.md` somehow grows for other
reasons (e.g. a docs-target change) — the trigger is a conjunction, not either condition
alone.

## Delta computation

The gate compares `CLAUDE.md`'s size **at the PR's head** against its size **at the
merge-base** of the PR's base branch and head SHA — NOT against the base branch's current
tip. Using the merge-base (rather than, say, `origin/main`'s current HEAD) isolates what
THIS PR's diff contributed: if unrelated sibling PRs landed on `main` after this PR
branched, their growth must not be attributed to this PR.

Both sizes come from GitHub's REST API, not a local recompile:

1. `GET /repos/{repo}/compare/{base}...{head}` → `.merge_base_commit.sha` (ONE call) —
   resolves the merge-base SHA.
2. `GET /repos/{repo}/contents/CLAUDE.md?ref={sha}` → `.size` (ONE call per ref, TWO calls
   total: head + merge-base) — the contents API's `size` field is already byte-counted
   server-side (matching `wc -c`), so no base64-decoding of the file content is needed just
   to measure its length.

Total: up to 3 `gh api` calls, but only for a PR that already touches `.minsky/rules/**` —
the hook short-circuits before any of these calls for the common case (a PR that doesn't
touch the rules directory at all).

A `CLAUDE.md` that doesn't exist at one of the two refs (e.g. a merge-base predating the
file, which is not expected in this repo but is handled defensively) resolves to size `0`
at that ref rather than a fetch failure — a `404` from the contents API (matched on gh's
literal `(HTTP 404)` status suffix, not a loose "not found" substring — see
`fetchFileSizeAtRef`'s doc comment for the empirically-verified gh error formats and the
residual repo-vs-file ambiguity, which is safe for this hook's actual call sites since both
refs it passes are always pre-validated real commits) is distinguished from a genuine
transport error and treated as "absent, size 0."

## Timeout

Registered at `timeout: 90` in `.claude/settings.json` (bumped from the sibling
Execution-Evidence/Deploy-Verification gates' 60s during review — R1 fix). This gate makes
MORE sequential `gh` calls than those two siblings: `fetchPrContext` (up to 2 meta-resolution
attempts + a files fetch, ~35s worst-case sum) PLUS `fetchMergeBaseSha` (10s) PLUS TWO
`fetchFileSizeAtRef` calls (10s each) = ~65s theoretical worst-case sum of per-call
timeouts. The siblings run at 60s against their own ~35s worst case (25s of slack); 90s
gives this gate the same 25s of absolute slack over its own 65s worst case.

## Marker acceptance (mt#2648)

Same accepted-forms class as the sibling `Execution evidence:` / `Deploy verification:`
markers: case-insensitive, either

- a plain label line WITH a required colon — `Size-budget justification: <content>`, or
- a Markdown heading of any level 1-6 with an OPTIONAL trailing colon —
  `## Size-budget justification` / `### Size-budget justification:`.

A `No Size-budget justification:` negation does NOT qualify. The marker must be followed
by non-empty content (inline on the same line, or on a subsequent line before the next
heading) — a bare heading with nothing under it does not count as justification.

## Deny message

States the measured delta, reproduces the rule-admission ladder (kept byte-consistent
with the `key-architecture.mdc` bullet and the `create-rule` skill — see mt#2874 PR body
for the cross-check), lists the touched rules files, and names all three unblock paths
(add the marker, move the content down the ladder, or the operator override).

## Escape hatch

`MINSKY_SKIP_SIZE_JUSTIFICATION=1` — operator override, audit-logged to stdout (task,
timestamp; the env var's VALUE is never echoed). Registered in `HOOK_ONLY_ENV_VARS`
(`packages/domain/src/configuration/sources/environment.ts`) per the
`custom/no-unregistered-minsky-env-var` rule (mt#1788).

## Fail-open posture

Unresolvable repo/PR, an unresolvable merge-base, or a `CLAUDE.md` size fetch failure
(genuine transport error, not a 404) all fail OPEN with a warning — the gate never blocks
on inability to check. This mirrors every sibling `session_pr_merge` gate's posture
(Execution-Evidence, Deploy-Verification, Out-of-Band).

## Hook file

`.claude/hooks/require-growth-justification-before-merge.ts` (source:
`.minsky/hooks/require-growth-justification-before-merge.ts`, compiled per mt#2304). Reuses
`deriveRepoFromGit` / `fetchPrContext` / `formatContextFailureWarnings` from the shared
`./pr-context` module (mt#2617), plus two new functions added to that module for this gate:
`fetchMergeBaseSha` and `fetchFileSizeAtRef`.

## Cross-references

- mt#2874 — this hook's tracking task (also ships the per-rule 15K ceiling extension to
  the mt#2802 aggregate check, and the rule-admission ladder in the `create-rule` skill +
  `key-architecture.mdc`)
- mt#2802 — the aggregate size-budget check this gate complements (fixes the incentive
  mismatch: cost-at-merge vs cost-at-growth-source)
- mt#2617 — shared PR-data fetch layer (`pr-context.ts`)
- mt#2648 — marker-acceptance forms shared with the execution-evidence and
  deploy-verification gates
- mt#1876 — the "would removal cause an agent to skip a check it runs every turn?"
  criterion the deny message's ladder cites for `alwaysApply: true`
- mt#2873 — sibling trim task whose 14,995-byte baseline this gate's originating incident
  (overnight regrowth to 15,868 bytes) motivated
