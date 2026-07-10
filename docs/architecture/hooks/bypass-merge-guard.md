# Bypass-Merge Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A PreToolUse hook on `Bash` and `mcp__minsky__session_exec` blocks ALL invocations
of `gh api -X PUT /repos/.../pulls/.../merge`. The standard merge path is
`mcp__minsky__session_pr_merge` after reviewer-bot APPROVE; the `gh api PUT` bypass
is retired as a default mechanism (mt#1869).

**Preferred bypass: in-band audited `session_pr_merge` `forceBypass` (mt#2215).** When a
merge is blocked by a reviewer convergence failure — a verified false-positive
`CHANGES_REQUESTED` (see mt#2211), reviewer CoT-leakage, or self-reversal — use the
audited in-band mode instead of the raw `gh api PUT`:

```
mcp__minsky__session_pr_merge(task: "mt#<id>", forceBypass: true,
  bypassReason: "<evidence: which review is a verified false-positive and why>")
```

`forceBypass` requires a non-empty `bypassReason`, requires ≥1 prior review round, refuses
when a required status check is failing (where status-check data is available) and when any
non-approval merge blocker is active (draft / conflict / closed), and requires a present
(non-DISMISSED) `CHANGES_REQUESTED` review (the reviewer-ABSENT/webhook-miss case is
`acceptStaleReviewerSilence` instead). It auto-dismisses the blocking review using
`bypassReason` as evidence, writes the canonical audit signature
(`Bot self-approval bypass per feedback_self_authored_pr_merge_constraints`) plus the reason
into the merge-commit body, always uses `merge_method=merge`, and runs in-band so Minsky's
session cleanup still fires. This is the path `/verify-task`'s bypass-merge closeout reads.
The raw `gh api PUT` below remains only as the last-resort fallback when the in-band path is
unavailable.

**Hook file:** `.claude/hooks/block-subagent-bypass-merge.ts`

**Two denial tiers:**

- **Subagent invocations** (detected via non-empty `agent_id` field): always blocked,
  no override available. Subagents must report the PR URL + bot status to the parent.
- **Main-agent invocations** (`agent_id` null/undefined): blocked by default. Override
  with `MINSKY_FORCE_BYPASS=1` when `session_pr_merge` has failed AND the bypass
  conditions per `feedback_self_authored_pr_merge_constraints` are met (R>=1 review
  rounds + reviewer convergence failure: CoT leakage, self-reversal, or webhook
  silence >5min). The override is audit-logged to stderr.

**Override mechanism:** Set `MINSKY_FORCE_BYPASS=1` (or `true` / `yes`) in your
environment before invoking the tool:

```bash
MINSKY_FORCE_BYPASS=1 minsky session exec ...
```

The override emits an audit-log line to stderr naming the matched command and ISO
timestamp. Use only when `session_pr_merge` has genuinely failed and the documented
bypass conditions are met.

**Tracking tasks:** mt#1671 (original subagent-only guard), mt#1869 (extension to all
agents). **Originating incidents:** PR #990 / mt#1636 (2026-05-08, subagent bypass at
R0); 2026-05-26 cadence measurement (6/7 bot PRs bypass-merged despite reviewer APPROVE
being available).

**Relationship to `block-git-gh-cli.ts`:** That sibling hook enforces `merge_method=merge`
on the same endpoint (mt#1228). Both hooks run on every `Bash`/`session_exec` call;
this hook's denial fires first in the matcher order.
