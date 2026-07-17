# Required-Checks Bypass-Merge Gate

> Extracted from `.minsky/rules/hook-files.mdc` — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled
> rule corpus carries only a terse index entry; this file is the durable
> detail.

`.claude/hooks/require-checks-on-bypass-merge.ts` (source:
`.minsky/hooks/require-checks-on-bypass-merge.ts`, mt#1951) is layer 2 of
the two-layer required-checks-status defense: `require-review-before-merge.ts`
(mt#1938) enforces `evaluateRequiredChecksStatus` on the `session_pr_merge`
MCP-tool surface; this hook applies the SAME logic (imported directly, one
source of truth) to the raw `gh api -X PUT .../pulls/<N>/merge` bypass
surface (Bash / `session_exec`), which the MCP-tool matcher does not cover.
PreToolUse on `Bash`/`session_exec`: matches a `gh api PUT .../pulls/<N>/merge`
segment, resolves the PR's HEAD SHA + base branch, then denies unless every
branch-protection-required status check has concluded `success` on that
HEAD.

## "Cannot read" vs "read and failed" (mt#2888)

The 2026-07-16 GitHub-degradation incident exposed a gap: when the
check-runs or branch-protection FETCH ITSELF fails (gh transport/parse
failure — the "cannot read" class), this hook's denial text was
indistinguishable from the "read successfully but a check is genuinely
red/pending" class ("read and failed") — both produced
`evaluateRequiredChecksStatus`'s generic "Unable to query ... investigate
before retrying. Override after manual verification:
MINSKY_SKIP_REQUIRED_CHECKS=1" text. Read literally, that phrasing nudges
toward bypass on a TRANSPORT failure — dangerous, because the transport
failure could be masking a genuinely failing build (confirmed during the
2026-07-16 incident: the "persistent 503" was hiding a real CI failure on
one PR).

mt#2888 splits the two classes explicitly. After
`evaluateRequiredChecksStatus` returns a denial, the hook checks whether
the underlying `protectionParseResult` or `allRunsParseResult` itself
failed (`!ok`) — that's the "cannot read" signal:

- **"Read and failed"** (both parses succeeded; `evaluateRequiredChecksStatus`
  found a genuinely failing/pending/missing required check): denial text
  UNCHANGED — the original `gateResult.reason` (fix the CI or wait), no D8
  grant consultation, no change in behavior.
- **"Cannot read"** (a parse failed — CI status is UNKNOWN, not confirmed
  red): the hook FIRST consults the mt#2658 D8 guard-grant store
  (`.minsky/hooks/guard-grant-store.ts`, reason-mandatory, TTL'd,
  scope-bound to `owner/repo#prNumber`, guard name
  `require-checks-on-bypass-merge`). A valid grant permits with an audit
  line naming the grant's reason. No valid grant produces a DISTINCT denial
  text that explicitly states the read failed (not the build), instructs
  against treating it as a bypass signal, and names TWO recoveries: (a)
  retry once GitHub API health is confirmed (githubstatus.com), or (b) if
  independently verified green via another channel (e.g. the GitHub UI),
  issue a scoped grant via `bun scripts/grant-guard-override.ts --guard
require-checks-on-bypass-merge --scope <owner>/<repo>#<prNumber> --reason
'<evidence>'`. The legacy `MINSKY_SKIP_REQUIRED_CHECKS=1` launch-time env
  var remains available for operator-terminal use (unreachable mid-session
  for an agent — the exact class mt#2658's grant-file channel was built
  for, per `guard-grant-store.ts`'s own motivation doc).

Before reaching either branch, `checkRunsFetch` is wired through
`pr-context.ts`'s `fetchCheckRunsRaw`, which itself retries via the
`minsky forge check_runs_list` CLI on a gh transport-class failure (see
`pr-data-fetch-layer.md`'s "Forge-CLI fallback" section) — so the "cannot
read" class is now reached only when BOTH `gh` AND the forge-CLI fallback
fail, narrowing the window this gate's escape valve exists for.

## Escape valve summary

| Class      | Mechanism                                                      | Reachable mid-session by an agent?      |
| ---------- | -------------------------------------------------------------- | --------------------------------------- |
| Legacy     | `MINSKY_SKIP_REQUIRED_CHECKS=1`                                | No (launch-time env var)                |
| mt#2658 D8 | `guard-grant-store.ts`, guard `require-checks-on-bypass-merge` | Yes (`scripts/grant-guard-override.ts`) |

## Cross-references

- mt#1951 — this hook's tracking task; mt#1938 — layer 1 (`session_pr_merge`
  surface, `require-review-before-merge.ts`), shares
  `evaluateRequiredChecksStatus` as the single source of truth
- mt#2888 — the cannot-read/read-and-failed split + D8 escape valve (this
  doc); mt#2887/mt#2892 — subsumed sibling incident filings
- mt#2658 — the D8 guard-grant-store mechanism this hook now consumes;
  `.minsky/hooks/guard-grant-store.ts` — the store; `scripts/grant-guard-
override.ts` — the issuance script
- `.claude/hooks/require-checks-on-bypass-merge.ts` (source
  `.minsky/hooks/require-checks-on-bypass-merge.ts`) — implementation;
  `.minsky/hooks/require-checks-on-bypass-merge.test.ts` — tests
- `pr-data-fetch-layer.md` — the shared fetch layer + forge-CLI fallback
  this gate's `checkRunsFetch` is wired through
- `block-subagent-bypass-merge.ts` — sibling hook denying subagent
  invocations of the same matched surface unconditionally, before this
  gate's logic ever runs
