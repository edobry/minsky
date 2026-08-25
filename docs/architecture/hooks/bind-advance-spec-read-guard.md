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
3. `parseTranscript()`s each candidate in order and scans **all** lines for
   EITHER a spec-surfacing READ (via `findToolUseInputs`, unchanged since
   mt#2637: a `mcp__minsky__tasks_spec_get` — or a `mcp__minsky__tasks_get`
   with `includeSpec: true` — tool_use whose `taskId` matches the target) OR a
   same-transcript spec-AUTHORSHIP action (mt#2814, see below),
   short-circuiting on the first hit (sibling files are only read on the
   would-deny path).
4. If neither a spec-surfacing call nor a same-transcript authorship action
   for the target exists anywhere in the session's conversation TREE (parent +
   dispatched agents), the call is denied; otherwise it passes. A spec read or
   authorship by the orchestrator legitimizes its subagents' binds and vice
   versa; the mt#2191 originating incident (no read anywhere) still denies.

**Same-transcript spec-authorship credit (mt#2814).** A spec READ is not the
only way a session can have engaged a task's identity and content — WRITING
it is at least as strong a signal. `specWasAuthored()` credits, as
read-equivalent, any of the following occurring **in the same transcript
tree** as the guarded call:

- `mcp__minsky__tasks_create` with a non-empty `spec` input, whose result
  BOTH explicitly confirms success AND reports the created task's id
  (`taskId`) matching the target. Because `tasks_create` never receives a
  `taskId` as INPUT — the backend mints one — the correlation goes through
  the RESULT: `findCreatedResourceIds()` (added to `transcript.ts`) pairs
  each `tool_use` block's Claude-Code-stamped `id` (`toolu_...`) against the
  later `tool_result` block carrying the same `tool_use_id`, JSON-parses that
  result's text content, and returns the FULL parsed result object alongside
  the extracted `taskId`. An uncorrelated call (no result yet), a non-JSON
  result (the command's own error path — `tasks.create` throws when `spec`
  is missing), or a result lacking the field all resolve to "no created id"
  rather than throwing.
  - **Server-side confirmation (PR #1982 review).** The local `spec` input
    alone is not trusted as proof a spec was persisted — that's what the
    CALLER asked for, not confirmation the domain layer accepted it.
    `specWasAuthored()` additionally requires `result.success === true` in
    the correlated JSON. This is the strongest signal actually available in
    the transcript: the success response
    (`createSuccessResponse({ taskId, task, ... })`) does not echo the spec
    content back, but `TasksCreateCommand.execute` only reaches its success
    path AFTER `createTaskFromTitleAndSpec` persists the spec — any failure
    (including the empty-spec `ValidationError`) throws before a `taskId` is
    minted, so `success === true` co-occurring with a matching `taskId` is
    not obtainable except via a real, accepted creation.
- `mcp__minsky__tasks_spec_patch` whose `taskId` input matches the target.
- `mcp__minsky__tasks_spec_search_replace` whose `taskId` input matches the
  target.
- `mcp__minsky__tasks_edit` whose `taskId` input matches the target AND which
  carries a non-empty spec-writing operation — `specContent`, `spec`, or
  `specFile` (the set `edit-commands.ts`'s `hasSpecOperation` recognizes; the
  full-spec-replacement path `tasks_spec_patch`'s fail-closed message points
  callers to). A metadata-only `tasks_edit` (status/kind/title/tags, no
  spec-writing field) is NOT credited. Added by mt#2558.

**Result-parsing robustness (PR #1982 review).** `extractToolResultText()`
(the helper that reads a `tool_result` block's text before JSON-parsing it)
is deliberately not pinned to `{ type: "text" }` exactly — it accepts ANY
block carrying a string `text` field, and recurses one level into a block
that nests its text under its own `content` array (an embedded-resource-style
wrapper). This guards against a differently-tagged or more deeply nested
content shape silently under-crediting authorship and perpetuating the very
false-positive class this change fixes.

Evidence motivating this change: 3+ false-positive fires across two
conversations in one week (session `ac4f5675`: mt#2774 and mt#2776, both
self-authored same-session via `tasks_create`; session `a9c1a09b`: mt#2749,
edited in-session via `tasks_spec_search_replace`), each costing a redundant
`tasks_spec_get` round-trip that re-fetched content the session had just
written moments earlier.

**Partial-edit decision (mt#2814's open question, resolved here).** The
originating spec left open whether a SMALL `tasks_spec_patch` (a one- or
two-line fix) should count in full, or only after some minimum edit size or
patch-count threshold. **Decision: ANY same-transcript `tasks_spec_patch` /
`tasks_spec_search_replace` call targeting the task counts, with no minimum
edit size and no patch-count threshold.** Rationale:

- This guard's stated purpose (see the header above) is **task-hijack
  prevention** — the mt#2191 failure mode was a session that had NEVER
  engaged the target task's identity at all, advancing/binding a completely
  unrelated task by accident. It is explicitly NOT a read-completeness
  gate (verifying the agent absorbed the FULL spec before acting) — that
  concern belongs to `/plan-task`'s planning-gate discipline, a different
  layer with a different enforcement point.
- A `tasks_spec_patch` / `tasks_spec_search_replace` call structurally
  REQUIRES the caller to name the target task id and supply content
  addressed to it. That is unambiguous identity engagement with the
  CORRECT task regardless of the edit's size — a one-line typo fix and a
  200-line rewrite are equally strong evidence the session is not
  accidentally hijacking an unrelated task. Introducing a size/count
  threshold would add an arbitrary, hard-to-calibrate knob that does not
  correspond to any distinguishing signal in the actual failure mode
  (mistaken identity, not incomplete reading).
- Symmetry with `tasks_create`: the spec-body SIZE supplied to `tasks_create`
  is likewise never checked (any non-empty `spec` string counts) — a
  patch-size threshold would treat the two credited authorship paths
  inconsistently for no principled reason.
- Cross-session authorship still blocks (see below), which is the boundary
  that actually matters for task-hijack prevention: a same-transcript patch
  proves THIS session engaged the correct id; a stale patch from a
  different, unrelated transcript proves nothing about the CURRENT session's
  engagement.

**Cross-session isolation (regression-tested).** Authorship recorded in a
DIFFERENT session's transcript still does NOT satisfy the check — this is
structural, not a special case the authorship logic has to implement itself.
`resolveTranscriptCandidates()` only ever walks the GIVEN transcript's own
conversation tree (the given path, its per-agent subagent files, and the
parent-session file in the reverse direction) — a prior, unrelated session's
`.jsonl` file is never a candidate for the CURRENT session's scan. The same
tree-scoping that already isolated the spec-READ check (mt#2637) isolates the
spec-AUTHORED check identically, with no additional code required. Confirmed
by fires like session `bdf8f782`'s mt#2738 (spec authored in one session,
advanced unread in a later, separate session) — per the mt#2814 spec, this
class should STILL block, and it does.

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

## The ask seam (mt#4551) — the same premise, advisory

The three tools above are ACTIONS ON a task. `asks_create` and `asks_edit` are a
RECOMMENDATION ABOUT one: the payload names a task id, and the principal reads it
as a work candidate. The guard's premise — this session never engaged the task's
content — fails identically there, so the same transcript scan runs; only the
remedy differs.

**Advisory, not deny, and the reason is an asymmetry rather than a hedge.** An
unread reference costs a re-read. A denied `asks_create` can strand an
escalation, including a `severity: "incident"` one — the only channel that
reaches the principal's phone. A flip to deny is operator-reserved per ADR-032
and routes through the disposition ask `/calibration-review` files. The output is
`additionalContext` with no `permissionDecision`, the shape `check-branch-fresh.ts`
uses for its warnings.

**Where ids are read from:** the `question`, each option's `label` and
`description`, and each `contextRefs` entry's `ref` (a bare string or an object;
the entry's `kind` is not consulted). `parentTaskId` is deliberately excluded —
it names the task an ask was filed FROM, which the filing session has almost
always just been working, so reading it would fire on the ordinary case rather
than the recommending one.

**One transcript pass, not one per id.** `unreadAskTaskIds` parses each candidate
transcript once and tests every still-pending id against it, draining as they are
credited and stopping early when nothing is left. Calling
`specWasSurfacedInAnyTranscript` per id would re-parse the same file once per
reference; a six-reference ask is ordinary. `MAX_ASK_TASK_REFS` (20) bounds a
pathological payload — it is a backstop, not a tuning knob.

**Why the READ and not the verdict.** The obvious alternative is to read the
falsification out of the spec's prose. It was measured at planning and rejected:
a fixed phrase set (`do not implement`, `do not build`, `do not re-open`,
`CLOSED as falsified`, `falsified` in a heading), with fenced blocks and inline
code spans elided per ADR-024's Rung 1, fires on **94 of 897 active tasks with
roughly one true positive**. Two reasons it cannot be tightened into working:

- It cannot separate a verdict on the WHOLE TASK from a live directive about part
  of one — mt#390's "Out of scope … do not implement", mt#446's "do not build
  independently of the sibling embeddings tasks", mt#3594's "Do NOT build a
  second symbol-matching layer".
- It cannot tell whose task the verdict is about — 32 of the 94 fires sit on a
  line naming a DIFFERENT task id.

That is ADR-024's paraphrase axis, and mt#4168's _"key on the TOOL CALL, never on
a phrase set"_ is the correction this leg applies. The read is machine-recorded,
so this leg has no matcher to tune and never joins the recall arms race. The
residual it accepts — an agent that reads a falsified spec and recommends it
anyway — is **mt#4561**, which changes what a failed gate (o) WRITES rather than
trying to read prose back out.

**Originating incident (2026-08-25).** `ask#10163`'s first revision led with
"Build the cheap-model triage pilot (mt#3473)", described as approved at ask#6603
and never built (the pre-edit body is preserved in the ask's
`metadata.originalContent`). mt#3473's spec had recorded since 2026-08-01 that the
pilot was measured and killed — 8 of 16 pushes its classifier called `trivial`
carried a real BLOCKING finding — and its closing line reads _"do not implement
the Summary/Success Criteria above as written."_ The filing conversation
(`cbafdfe3-8d61-4e73-a679-e6f7ce9948a4.jsonl`) made 20 spec-surfacing reads across
14 distinct task ids; mt#3473 was not among them. It DID read mt#2718, the
umbrella whose prose supplied the stale "never built" claim. A dispatched advisor
caught it, not any check.

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

**Calibration note (mt#2814, 2026-07-16).** Before the same-transcript
authorship credit shipped, the guard's false positive fired on effectively
**every status walk of the 2026-07-15/16 gap-analysis orchestration session**:
12+ subtasks were authored via `tasks_create` (with a full spec body) and then
advanced to READY / bound in the SAME transcript, and each one needed a
redundant `tasks_spec_get` round-trip purely to satisfy the guard on content
the session had just written itself. This is the recurrence pattern that
justified generalizing beyond the original mt#2191 read-only detection: a
session authoring-then-advancing its own subtasks is a routine, expected
orchestration shape (`/orchestrate`'s parent+subtask decomposition), not a
task-hijack risk — the false-positive rate on this legitimate pattern had
become the dominant cost of running the guard at all. The three prior fires
recorded in this task's originating spec (session `ac4f5675`: mt#2774 and
mt#2776; session `a9c1a09b`: mt#2749) established the pattern; the
2026-07-15/16 session's 12+ fires in a single conversation is the volume
evidence that made it urgent.

**Cross-references:**

- mt#2515 — this guard's tracking task (Seam 1, bind/advance)
- mt#2637 — subagent-aware transcript resolution (fixes the background-dispatch
  false positive; adds `resolveTranscriptCandidates` to `transcript.ts`)
- mt#2814 — same-transcript spec-authorship credit (`tasks_create`-with-spec /
  `tasks_spec_patch` / `tasks_spec_search_replace`); adds `specWasAuthored()`
  and `findCreatedResourceIds()`; documents the partial-edit decision above
- mt#2558 — extends `specWasAuthored()` to credit `tasks_edit` carrying a
  spec-writing operation (`specContent` / `spec` / `specFile`) as authorship
- mt#2511 — parent (task-hijack guard); mt#2514 — Seam 2 (merge-time
  PR-task-correspondence guard in `applyPostMergeStateSync`)
- mt#979 — subsumed (this guard adds the spec-read detection it deemed too brittle)
- mt#2195 — Guessed-Session-Path Guard (sibling PreToolUse guard from the same
  mt#2191 session)
- mt#2255 / memory `a3e60471` — the role=user tool_result turn-boundary hazard
  this guard sidesteps by scanning the full transcript
- discipline memory `57c9e939` — "the merge AUTO-marks DONE; auto-DONE is
  irreversible" (the structural escalation target)
- mt#2806 — parent umbrella for the 2026-07-15/16 gap-analysis orchestration
  session's guard-health findings (this false-positive class among them)
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
- mt#2657 — one-call dispatch for existing tasks (`tasks_dispatch` `taskId` mode);
  extended this guard to cover the collapsed call rather than bypassing it
