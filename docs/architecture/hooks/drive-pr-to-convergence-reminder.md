# Drive-PR-To-Convergence Reminder

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A PostToolUse hook on `mcp__minsky__session_pr_create` injects an
`additionalContext` system-reminder when PR creation succeeds, instructing
the agent to drive the PR to convergence (via `session_pr_wait-for-review`
or a Chinese-wall reviewer subagent on webhook-miss) and explicitly
forbidding deferral language ("ping me when done", "let me know when
merged", "ready for your review/merge") as turn-closing. This is the
structural escalation (mt#1793) of two adjacent corpus rules — the
`§User does not review PRs in the loop` rule and its "Slow-ask variant"
sub-section — both of which failed memory-tier and corpus-tier
enforcement in originating incidents.

**Hook file:** `.claude/hooks/drive-pr-to-convergence.ts` — a thin binding since mt#4374. It owns
the result-envelope shape (absent `tool_result`, a non-object envelope, a truthy-but-not-`true`
`success`) and nothing else.

**Decision:** `decidePrConvergenceReminder` in
`packages/domain/src/detectors/pr-convergence-reminder.ts`, which also holds the reminder text
itself. It takes `{ toolName, succeeded }` — plain values — so the reminder's content and the rule
about when it fires can be tested without constructing a hook payload.

**Behavior:**

- Fires on PostToolUse for `mcp__minsky__session_pr_create` only.
- Inspects `tool_result.success`; emits the reminder when strictly `true`. Note (mt#3308): the
  harness actually delivers the result as `tool_response` (for MCP tools, a content envelope
  with the JSON stringified inside) — `readInput`'s `normalizeToolResult` synthesizes
  `tool_result` from it, which is what makes this inspection see real data; before that
  normalization shipped, this reminder had never fired in production.
- Silent on failure paths (the agent gets the error from the tool surface
  itself, no need to add noise) and non-matching tools (defensive).
- Reminder text names: the required next action
  (`session_pr_wait-for-review`), the webhook-miss fallback (`/merge-coordination`
  §7a diagnosis ladder), the success branches (APPROVE → merge,
  CHANGES_REQUESTED → fix per §7 Convergence Checklist), and the
  forbidden deferral phrases verbatim.

**Originating incidents:**

- 2026-05-12 PR #1076 (mt#1791) — agent created PR and ended turn with
  "ping me to wire the SDK once merged and you've set the key." User
  had to poke: "so you just sat there." This is the canonical
  slow-ask-variant incident.
- 2026-04-22 PR #677 (mt#1057) — agent created PR and ended turn without
  driving convergence; required user-initiated correction. Originated
  mt#1066's `require-review-after-pr-create.ts` proposal (PR #684); this
  hook supersedes mt#1066's narrower single-skill slice.

**Always exit 0.** The hook is informational; it must never block the tool
call's success surfacing. Reads `ToolHookInput` from stdin; emits
`HookOutput` JSON with `hookSpecificOutput.additionalContext` when firing,
silent otherwise.

**No override mechanism.** Unlike block-class hooks, this hook only
injects context — never denies. There's nothing to override; the agent
can ignore the reminder, but doing so re-creates the very failure pattern
the hook exists to prevent.

**Tracking task:** mt#1793. **Supersedes:** mt#1066 / PR #684
(`require-review-after-pr-create.ts`, task CLOSED).

**Cross-references:**

- `decision-defaults.mdc §User does not review PRs in the loop` — the
  corpus rule this hook enforces, including the "Slow-ask variant"
  sub-section added 2026-05-12 R4.
- `feedback_drive_pr_to_convergence_dont_end_on_ping_me` — bridge memory
  (retire when this hook ships).
- `feedback_user_does_not_review` — sibling memory at the same surface.
- `feedback_self_authored_pr_merge_constraints` — diagnostic ladder for
  the webhook-miss fallback referenced in the reminder.
- `feedback_bot_authored_pr_convergence` — bypass-merge mechanism the
  reminder points at on convergence.
