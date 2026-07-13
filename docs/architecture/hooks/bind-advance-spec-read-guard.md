# Bind/Advance Spec-Read Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A PreToolUse hook on `mcp__minsky__tasks_status_set` (READY transition),
`mcp__minsky__session_start`, and `mcp__minsky__tasks_dispatch` (existing-task mode
only, mt#2657) that blocks advancing a task to READY, or binding a session to it,
when that task's spec was **never surfaced in-session**. This is Seam 1 of the
"task-hijack" guard (mt#2515, under parent mt#2511): bind / advance / complete a
task you never read.

**Hook file:** `.claude/hooks/check-task-spec-read.ts`

**mt#2657 note — `tasks_dispatch` coverage.** `tasks_dispatch` collapses
task-status-walk + `session_start` + prompt-generation into one call. When
dispatching an EXISTING task (a `taskId` param is present), the command performs
the same advance/bind internally, IN-PROCESS — invisible to this hook if it only
matched `tasks_status_set`/`session_start`, since a PreToolUse event fires once per
TOP-LEVEL harness tool call, not per internal domain-function call. Guarding
`tasks_dispatch` directly is how the one-call path composes this guard rather than
silently bypassing it. New-task mode (`title`, no `taskId`) is NOT guarded — a
freshly created task has no pre-existing spec to have skipped reading.

**How it works:**

1. Resolves the target task id from `tool_input` — `taskId` for `tasks_status_set`
   (only when `status == "READY"`; other transitions pass) and for `tasks_dispatch`
   (only when `taskId` is present — existing-task mode), `task` (falling back
   to `taskId`) for `session_start`. Ids are normalised (lowercase, strip `#` /
   whitespace) so `mt#2515` / `MT#2515` / `mt2515` compare equal.
2. Resolves the transcript CANDIDATE set via `resolveTranscriptCandidates` in
   `.claude/hooks/transcript.ts` (mt#2637): the given `transcript_path`, plus —
   when the hook input carries a non-empty `agent_id` (present only for
   subagent-originated tool calls, per the upstream hooks reference) — the
   dispatched agent's own per-agent file at
   `<session-dir>/subagents/agent-<agentId>.jsonl`, plus every sibling
   `agent-*.jsonl` under that `subagents/` dir as a fallback. When the given
   path is itself a per-agent file, the PARENT session's top-level transcript
   is added too (tree semantics in both directions), and all candidates are
   deduped. This exists
   because the harness passes background-Agent-dispatched subagents the
   PARENT session's top-level transcript path, not their own file — which
   false-positive-blocked every dispatched implementer whose orchestrator had
   not itself read the spec (mt#2637, observed on the mt#2612/mt#2614
   dispatches).
3. `parseTranscript()`s each candidate in order and scans **all** lines (via
   `findToolUseInputs`) for a `mcp__minsky__tasks_spec_get` — or a
   `mcp__minsky__tasks_get` with `includeSpec: true` — tool_use whose `taskId`
   matches the target, short-circuiting on the first hit (sibling files are
   only read on the would-deny path).
4. If no spec-surfacing call for the target exists anywhere in the session's
   conversation TREE (parent + dispatched agents), the call is denied;
   otherwise it passes. A spec read by the orchestrator legitimizes its
   subagents' binds and vice versa; the mt#2191 originating incident (no read
   anywhere) still denies.

**Why full-transcript, not last-turn.** Claude Code records `tool_result` blocks
as user-role lines, so a turn slice keyed on user-role boundaries silently drops
tool calls from earlier turns (mt#2255 / memory `a3e60471`). The spec is
typically read in an earlier turn than the READY/`session_start` call, so the
guard scans every line rather than a turn window. The scan is a single O(n) pass,
well within the 10s PreToolUse budget.

**On hit:** the hook denies with `permissionDecision: "deny"` and a checklist
message (absorbed from the subsumed mt#979): read the spec in full, verify its
file:line references, sketch the approach, note scope/blockers — then call
`tasks_spec_get` for the task and re-attempt.

**Fail-open posture:** the entrypoint is wrapped in try/catch; any error — or a
missing `transcript_path` — exits 0 = allow. A non-READY `tasks_status_set`, an
unguarded tool, or an unresolvable id also passes silently.

**Override mechanism:** Set `MINSKY_SKIP_SPEC_READ_CHECK=1` (or `true` / `yes`)
to allow advancing/binding a genuinely-unread task. The override emits an audit
line to stdout (non-JSON, so Claude Code's hook-output parser ignores it —
matching the sibling-hook audit convention) naming the env-var value, tool, session
id, and ISO timestamp.

**Env-var registration:** `MINSKY_SKIP_SPEC_READ_CHECK` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override
env-var name's source of truth lives in the hook file as the exported constant
`OVERRIDE_ENV_VAR` so the hook, test, and this rule cannot drift.

**Subsumes mt#979.** mt#979 ("block READY without spec analysis") proposed an
always-block-first-attempt pause and explicitly put spec-read _detection_ out of
scope as "too brittle." That judgment predated the mt#2255 transcript helper;
detection is now feasible, so this guard delivers mt#979's intent (and only
blocks when the spec was genuinely unread). mt#979 is CLOSED as subsumed.

**Originating incident:** mt#2191 session `935e6a4c` (2026-05-31, "F0" of the
forensic catalogue): a Slidev-deck session bound itself to the unrelated naming
task mt#2191, advanced it TODO → PLANNING → READY, and shipped the deck under it
(PR #1438) — without ever calling `tasks_spec_get mt#2191`. The merge auto-DONE'd
the naming task; the false DONE is irreversible.

**Cross-references:**

- mt#2515 — this guard's tracking task (Seam 1, bind/advance)
- mt#2637 — subagent-aware transcript resolution (fixes the background-dispatch
  false positive; adds `resolveTranscriptCandidates` to `transcript.ts`)
- mt#2511 — parent (task-hijack guard); mt#2514 — Seam 2 (merge-time
  PR-task-correspondence guard in `applyPostMergeStateSync`)
- mt#979 — subsumed (this guard adds the spec-read detection it deemed too brittle)
- mt#2195 — Guessed-Session-Path Guard (sibling PreToolUse guard from the same
  mt#2191 session)
- mt#2255 / memory `a3e60471` — the role=user tool_result turn-boundary hazard
  this guard sidesteps by scanning the full transcript
- discipline memory `57c9e939` — "the merge AUTO-marks DONE; auto-DONE is
  irreversible" (the structural escalation target)
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
- mt#2657 — one-call dispatch for existing tasks (`tasks_dispatch` `taskId` mode);
  extended this guard to cover the collapsed call rather than bypassing it
