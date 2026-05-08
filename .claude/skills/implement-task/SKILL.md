---
name: implement-task
description: >-
  Full implementation lifecycle for a Minsky task: read spec, plan, code, test,
  verify, commit, and create PR. All work happens in session workspaces with
  absolute paths. Use when implementing a task, starting development, or
  beginning work in a session.
user-invocable: true
---

# Implement Task

Step-by-step implementation lifecycle for a task within a Minsky session. Covers status-gating, session creation through PR creation.

**Owned lifecycle transitions:**

- READY → IN-PROGRESS: this skill owns this transition via `session_start`
- IN-PROGRESS → IN-REVIEW: this skill owns this transition via `session_pr_create`

## Triggers

This skill activates on: "implement mt#X", "start coding mt#X", "build mt#X", "start working on mt#X".

These triggers are intentionally READY-state verbs — the skill guards against acting on tasks that are not yet READY.

## Arguments

Optional: task ID (e.g., `/implement-task mt#123`). If omitted, uses the current session's task.

## Process

Step 0: Entry gate: check task status
Step 0a: Late parallel-work spot-check
Step 1: Retrieve relevant memory context
Step 2: Read and verify the task spec
Step 3: Start a session (READY → IN-PROGRESS)
Step 4: Understand architectural context
Step 5: Plan the implementation
Step 6: Develop
Step 7: Verify implementation
Step 7a: Ship verification artifact for structural changes (when in scope)
Step 7b: TOCTOU / concurrency sweep for check-then-act code (mandatory when applicable)
Step 8: Create PR (IN-PROGRESS → IN-REVIEW)
Step 9: Drive PR to convergence (IN-REVIEW → merge)

### 0. Entry gate: check task status

**This is the first and mandatory mechanical step.** Call `mcp__minsky__tasks_status_get` with the task ID.

Evaluate the returned status:

- **TODO or PLANNING** → halt immediately. Do NOT call `session_start`. Respond:
  > "Task mt#X is in `<STATUS>` state. Run `/plan-task mt#X` first to bring it to READY before implementing."
- **BLOCKED or CLOSED** → halt. Explain the status and ask the user how to proceed.
- **READY** → proceed to step 1 below. This skill owns the READY → IN-PROGRESS transition.
- **IN-PROGRESS** → a session may already exist. Retrieve it with `mcp__minsky__session_get` and continue from step 3.
- **IN-REVIEW** → PR already created. Resume the §9 convergence loop (wait for the reviewer-bot, iterate to merge). Note: per mt#1551, `/verify-task` is a closeout wrapper for the bypass-merge path only; the standard `session_pr_merge` path auto-sets DONE without `/verify-task` firing.
- **DONE** → task is complete. No action needed.

### 0a. Late parallel-work spot-check

The PLANNING → READY gate already ran the full parallel-work check (`/plan-task` gate
criterion g). But READY → IN-PROGRESS may happen hours or days later, and new PRs may
have landed in the gap. Re-run an abbreviated check before `session_start`.

**Step ordering note:** §0a needs the spec's `## Scope` → `In scope` file list to know
what to check against. If the spec has not yet been loaded into context, fetch it now via
`mcp__minsky__tasks_spec_get` (the same call §2 makes) so §0a has the file list to work
with. §2 will simply re-use the loaded spec when it runs.

Then run both sweeps:

1. **Open-PR sweep** — `mcp__github__list_pull_requests` with `state: "open"`. Scan titles
   and branches for any PR whose scope plausibly overlaps the spec's `## Scope` → `In scope`
   files. Spot-check suspicious matches with `mcp__github__pull_request_read` method `get_diff`.
2. **Recently-merged sweep** — `mcp__minsky__git_log` for the last 24 hours; check for any
   merge that touched files this task plans to modify. A fix that landed overnight is just
   as bad as one in flight.

If either sweep hits, **halt before `session_start`** and surface the finding to the user
(task ID or PR number, file overlap, recommendation: wait / coordinate / reframe / proceed
with explicit acknowledgment).

This is the last-line enforcement of `feedback_check_parallel_work_before_decomposing`.
The full gate ran at PLANNING; this is the spot-check before the session is created.

### 1. Retrieve relevant memory context

Call `memory_search` with the task ID and domain area:

- Query: e.g., `"mt#<id>"` or the feature area (e.g., `"session liveness"`, `"compile pipeline"`)
- Review any returned memories for prior decisions, user preferences, or architectural constraints
- This replaces the always-loaded MEMORY.md preamble — context is fetched on-demand

### 2. Read and verify the task spec

- Fetch the spec: `mcp__minsky__tasks_spec_get` with the task ID
- Read every success criterion and acceptance test
- **Verify spec freshness**: Specs may be stale from prior conversations. Check file:line references against the current codebase before starting.
- Never proceed based on title/database info alone — the full spec is required

### 3. Start a session (READY → IN-PROGRESS)

**This step owns the READY → IN-PROGRESS transition.**

Call `mcp__minsky__session_start` with the task ID. This:

- Creates an isolated session workspace
- Sets task status to IN-PROGRESS

All subsequent file operations must use absolute paths under the session directory returned by `session_start`.

### 4. Understand architectural context

Before writing any code:

- Investigate relevant architectural patterns in the codebase
- Search for documentation about systems being modified
- Understand integration points and workspace routing
- Research unfamiliar concepts mentioned in the spec

### 5. Plan the implementation

- Identify files to modify
- Sketch the changes
- Identify dependencies and potential issues
- Check relevant rules (architecture, testing, code quality)
- Update the task spec with the implementation plan

### 6. Develop

- Make code changes following project coding standards
- Add tests for new functionality
- Commit regularly with `mcp__minsky__session_commit`:
  - Use meaningful messages referencing the task ID
  - Group related changes in logical commits
- All file edits must use absolute paths under the session directory
- **Run commands in the session** using `mcp__minsky__session_exec(task: "mt#<id>", command: "<cmd>")` — e.g., `bun test`, `bun run format:check`, `git status`. Never use `git -C <path>` or shell `cd` workarounds.

### 7. Verify implementation

Before declaring complete:

- **Verify outcomes, not actions.** Never treat a command succeeding (exit 0, API 200) as proof the desired effect occurred. Read back the result: query the setting you changed, count rows after a migration, call the tool you registered.
- If the task spec has acceptance tests, **execute them** — don't just re-read the spec
- Verify rule compliance (architecture, testing, code quality rules)

#### Convergence checklist (mandatory before §8)

Before invoking step §8 (Create PR), walk through this checklist; if any check fails, fix the gap before creating the PR.

**Preventive phase (before first PR creation):**

1. **Trust-boundary defensive coverage.** Every site where external input enters the system needs a runtime guard or wrapper. Grep for each category below and confirm each hit has a `try/catch` wrapper, a `safe*` helper, or a runtime type guard (Zod, manual `typeof`, etc.) on the result:

   - File I/O: `fs.readFile`, `fs.readdir`, `fs.stat`, `fs.writeFile`, `glob`, `fs.mkdir`
   - Network: `fetch`, HTTP calls, RPC clients, MCP calls
   - Database: every query (connection loss, schema mismatch, constraint violation)
   - Subprocess: `exec`, `spawn`, `child_process.*`
   - Deserialization: `JSON.parse`, type casts (`as Foo`) on parsed data, parsing user input
   - Configuration: `process.env.X`, config-file reads
   - Request bodies, webhook payloads, anything from the network boundary

2. **Portable defaults.** No defaults bind to a specific user, machine, or host. No `homedir()`-derived absolutes baked into defaults; no user-specific paths embedded as constants. Mental model: "would this work on a fresh machine for a new user?"

**Reactive phase (when iterating on reviewer findings):**

3. **Anti-rationalization.** When responding to a reviewer comment: did you change behavior, or did you just add a doc comment justifying the existing behavior? Documentation alone does not count as a fix. Verify the fix aligns with the _parent task's_ design intent (read the parent spec, not just the immediate ticket's text). Common failure mode: reviewer says "this default is wrong"; implementer adds a JSDoc explaining why the default is OK; reviewer flags it again because the value didn't change.

4. **Class-not-instance.** When the reviewer flags one specific site (e.g., "`glob` is unwrapped"), scan the implementation for other sites of the _same class_ (e.g., other unwrapped I/O like `fs.readFile`) and patch them all in one round. The reviewer-bot does cross-cutting audits; matching the comprehensive scan up-front is what converges iteration.

Origin: cascaded reviewer iteration on mt#1258 (PR #796 abandoned across 3+ rounds) and mt#1350 (PR #847, 5 reviewer rounds). See `feedback_cascade_defense_in_implementer_prompt.md` for the pattern history.

### 7a. Ship verification artifact for structural changes (when in scope)

**Decision rule — is this change structural?**

A change is structural if its correctness depends on live external behavior that no unit test can fully verify. Examples:

- New persistence backend path (new DB provider, new table layout, schema migration semantics)
- New model-output channel (output tools, structured-output schema, new tool call format)
- New external-system probe (health check against a live API, feature-flag read from a hosted store)
- New deploy-target wiring (Railway service, container start-up, environment variable resolution)
- Schema migration with semantic changes (not additive-only column adds)

Counter-examples (NOT structural — no artifact needed):

- Pure-function changes with full behavioral test coverage
- Refactors that preserve API surface verified by existing tests
- Adding or updating tests
- Docs-only or config-only changes
- Single-file logic fixes where no external system is involved

**Requirement when structural.** The PR must also ship a verification artifact alongside the code change:

- A smoke script, replay script, e2e probe, or equivalent
- Place under `services/<service>/scripts/` or repo-wide `scripts/` if there is no service subdirectory
- The artifact must:
  - Be runnable from the command line (`bun scripts/smoke-<feature>.ts`, `./scripts/verify-<feature>.sh`, etc.)
  - Gate on required env vars (`OPENAI_API_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`, etc.) — skip gracefully (exit 0 with a clear "SKIP: env var not set" message) when env is absent
  - Emit pass/fail with exit code (0 = pass, non-zero = fail)
  - Produce structured output: stdout JSON or a results file at e.g. `scripts/<purpose>-results.json`

**Live-verification gap pattern.** Subagents typically lack the env vars needed for live execution. The documented pattern is:

1. Subagent ships the artifact in the PR (code + script, but no live output).
2. Main agent (or human operator) runs the live verification after the PR is created, using env vars present in the main context.
3. The live-run output (redacted) is appended to the PR body under a "## Live verification" section.

This pattern was established by mt#1399 (smoke test for output-tools wiring — verified GPT-5 emits tool calls live) and mt#1403 (replay-verification script for cluster verification — verified 0/15 posted-body fires across the original leak corpus). Reference both when describing the verification gap to a reviewer.

**What goes in the PR body.** The PR description's "## Live verification" section must contain either:

- The redacted live-run output from running the artifact, OR
- A documented override: the artifact has not been run because (a) the target has not been deployed yet, (b) the author lacks live-target access per documented policy, or (c) the target has a rate-limit or maintenance-window constraint. "I read the code carefully" is not a valid override.

### 7b. TOCTOU / concurrency sweep for check-then-act code

**Mandatory** when this implementation introduces or modifies a check-then-act pattern. The
sweep is the agent's responsibility — reviewer-bot does NOT reliably catch TOCTOU. It
catches functional and structural concerns; it has not in practice surfaced multi-call
atomicity or decision-action gaps. **Do not defer this to review.**

**When this step applies (any of):**

- Code reads external state and acts on the read (filesystem, API, database, git refs, env).
- Code implements a hook, gate, or guard (any precondition-check-then-permit pattern).
- Code validates a precondition then acts on a downstream resource (lock, ref, file).
- Code spawns a subprocess after a check the subprocess could invalidate.

If none apply, this step is a no-op — record "(N/A — no check-then-act pattern introduced)"
in the PR body and proceed.

**Enumerate the three windows. Every time. For each, document a fix-or-accept decision.**

1. **Read atomicity.** Does the check make multiple separate reads of the underlying
   state? If yes, can the state change between reads (parallel writers, concurrent
   fetches, sibling processes)?

   - **Mitigation:** collapse to a single atomic read.

2. **Decision-action gap.** Between the moment of decision (allow / proceed) and the
   action (push / write / spawn), can the underlying state change in a way that
   invalidates the decision?

   - **Mitigation:** re-check immediately before the action, or compare-and-swap on a
     captured identifier (CAS / version / SHA).

3. **Stale-read at read time.** Was the data already old when read (remote-tracking ref
   not recently fetched, cached config, memoized snapshot, in-process cache)?
   - **Mitigation:** force a fresh read at check time.

**The "small window" rationalization is forbidden.**

> If the race is the same SHAPE of bug the code exists to prevent, the size of the window
> is a UX consideration, not a correctness one. A seconds-class instance of an hours-class
> bug is still the bug.

Do not dismiss a window because "the race is unlikely" or "the window is short." Either
mitigate, or write down an explicit accept-rationale from the list below.

**Accept is valid when ANY of these hold:**

- **Idempotent.** The action produces the same outcome on retry; concurrent execution is
  safe by construction.
- **FF-conflict-preserving.** The action's failure mode on conflict is correctness-preserving
  (e.g., a git push that requires fast-forward — the push rejects, the agent retries against
  the new state, no silent corruption).
- **Irreducible.** No locking / CAS primitive is available in the underlying system; the
  window cannot be closed without external infrastructure.
- **Automatic recovery.** Post-conflict recovery is automatic and observable (the next
  invocation correctly re-reads and re-acts on the updated state).

Document the chosen accept-rationale in a code comment at the race site so the next reader
doesn't have to re-derive it. Naming the rationale is part of the accept; an unannotated
accept reads as overlooked.

**Mitigate is required when ANY of these hold:**

- **Creates redo.** Race outcome forces the user to redo work (wasted iteration on stale
  base, replayed action against changed state).
- **Silent worse-state.** Race outcome silently produces a worse state (agent builds on
  stale base again, action lands but does the wrong thing, no error surface).
- **Observable to consumer.** Race outcome is visible to a downstream consumer (reviewer,
  build system, user-facing log) in a way that creates confusion or work for them.

**If mitigation is non-trivial:** file a follow-up structural task (per the
meta-retrospective principle that residual races deserve named owners) and document the
residual window in a code comment naming the follow-up task. A residual race with a
tracking task is qualitatively different from a residual race that's been forgotten about.

**What goes in the PR body.** Either:

- A "## Concurrency analysis" subsection enumerating the three windows with a one-line
  fix-or-accept decision per window and the chosen accept-rationale (or fix description).
- An explicit "(N/A — no check-then-act pattern introduced)" line if this step doesn't
  apply.

Cross-reference: `feedback_toctou_enumeration_required.md` is the bridge memory carrying
this discipline pre-skill; once this skill section ships, that memory's job becomes
historical record + pointer here. The originating incident (mt#1483 PR #928 round-N-1
detection of `listCommitsAhead` Class-1 race + Class-2 dismissal) is the regression
example for this section.

### 8. Create PR (IN-PROGRESS → IN-REVIEW)

**This step owns the IN-PROGRESS → IN-REVIEW transition.**

Use `mcp__minsky__session_pr_create` to create the pull request:

- Title is description-only (no conventional commit prefix, no task ID)
- Body includes Summary, Key Changes, Testing sections
- The tool automatically rebases on main and sets task status to IN-REVIEW

### 9. Drive PR to convergence (IN-REVIEW → merge)

After PR creation, the next phase is iteration with the reviewer-bot
(`minsky-reviewer[bot]`) until the PR is merge-ready. Per CLAUDE.md "User does
not review PRs in the loop" and `feedback_user_does_not_review` — the user is
NOT the next actor in this loop; the bot is.

**This step does NOT stop the session — it actively waits.** Posting a "PR
created, here's the summary" message and stopping with no wait/poll set up is
idle drift, not hand-off. Originating incident: 2026-05-07 PR #970/mt#1610.

**Default mechanism:** call `mcp__minsky__session_pr_wait-for-review` on the
task. It blocks until the bot posts (typical latency 30s–2min after push) and
returns the review payload, so the agent unblocks automatically with full
context. Pass `reviewer: "minsky-reviewer[bot]"` to filter out other reviewer
identities. Default `since` is call-time, so the tool waits for NEW reviews
only — if the bot already posted on this HEAD before you called, fetch via
`mcp__minsky__session_pr_get` or `mcp__github__pull_request_read get_reviews`
first to surface existing reviews.

**Alternative for genuinely-async multi-day waits:** `ScheduleWakeup` with
delaySeconds in the 1200–1800s range (per the cache-window economics rules).
Prefer the wait tool when latency is minutes-class.

**Forbidden:** idling without one of the above mechanisms. If you choose not
to wait, disclose the choice explicitly to the user and name what you are
waiting on. Per `feedback_post_pr_convergence_idle_drift` (the bridge memory
this section retires), "standing by" without a named mechanism is the failure
mode this section was written to prevent.

**Note:** `mcp__minsky__pr_watch_create` is a tempting candidate but is
**inert today** — its runner is wired to a stub GitHub client, no scheduler
fires it, and `OperatorNotify` targets the local desktop rather than the
agent's conversation context. Don't recommend it until the production gaps
close. See `feedback_survey_event_resumption_toolkit_before_proposing_self_poll_or_user_ping`.

**When the bot posts**, branch on review state:

- **APPROVE** → call `mcp__minsky__session_pr_merge`. The standard merge path
  atomically sets the task to DONE; `/verify-task` does NOT fire on this path.
- **CHANGES_REQUESTED** / **BLOCKING findings** → apply substantive fixes per
  §7's Convergence Checklist (cascade-defense, class-not-instance), push, and
  re-wait. Don't fix one finding at a time and re-trigger; sweep the class
  per `feedback_cascade_defense_in_implementer_prompt`.
- **COMMENT** (informational) → assess whether comments warrant code changes.
  If yes, treat like CHANGES_REQUESTED. If no, this is the convergence-failure
  signal for self-authored bot PRs (see escape valves below).

**Convergence-failure escape valves.** When the standard loop won't terminate
cleanly, escalate to bypass-merge. Each valve has a tracking memory:

- **Self-authored bot PR** (`minsky-ai[bot]` is both author and reviewer
  identity). GitHub structurally blocks self-approval; the bot can only post
  COMMENT, never APPROVE. After R1+R2 substantive fixes, plan
  `gh api PUT /repos/<owner>/<repo>/pulls/<N>/merge -f merge_method=merge`
  with an audit-trail commit message. See `feedback_self_authored_pr_merge_constraints`
  and `feedback_bot_pr_convergence_via_bypass`. After bypass-merge, run
  `/verify-task mt#X` — that path requires the closeout skill since
  `session_pr_merge` did not fire.
- **Round-N self-reversal** of a prior accepted fix → bikeshedding;
  iteration has converged. Bypass with audit note explaining the chosen side.
  See `feedback_reviewer_bot_self_reversal_signal`.
- **CoT-leakage error** twice on the same HEAD → bot won't converge
  automatically. Bypass per `feedback_reviewer_bot_cot_leakage_forces_bypass`.
- **Reviewer-bot silent for >5 min after push** → likely webhook miss. Per
  `feedback_self_authored_pr_merge_constraints`, options are (a) push an empty
  commit to wake the webhook (`session_commit` with `noFiles: true`), (b)
  bypass-merge after substantive fixes already landed, (c) wait one more time.

**Pre-bypass discipline:** before any `gh api PUT /merge` bypass, verify CI
fired and passed on the latest commit per `feedback_verify_ci_fired_before_bypass_merge`.
A bypass + missing-CI is admin override of branch protection, not just
reviewer convergence failure.

**Standard merge wins when it works.** `session_pr_merge` is preferred over
the bypass — it atomically sets DONE, runs the merge gate (which checks for
a posted review with spec-verification section), and produces a clean audit
trail. The bypass exists for the structural-block cases above, not as the
default.

**Do NOT** stop the session before convergence is reached. Do NOT pre-emptively
call `/verify-task` — it only fires on the bypass-merge fallback path.

## Constraints

These constraints apply throughout implementation:

- **Absolute paths only.** Every file operation must use the full session path (e.g., `/Users/edobry/.local/state/minsky/sessions/<id>/src/...`). Relative paths may resolve against the main workspace.
- **Never edit main workspace.** All changes happen in the session. If a bug is found in the main project, create a separate task for it.
- **Never manually set DONE.** Task status flows: TODO → IN-PROGRESS → IN-REVIEW → DONE. DONE is only set after PR merge, never manually from a session.
- **No work without a session.** Implementation work requires an active session for isolation and traceability.
- **Never bypass the entry gate.** Calling `session_start` on a TODO or PLANNING task skips the planning phase and produces unplanned implementation work.
- **Structural changes require a verification artifact.** A fix whose correctness depends on live external behavior (new persistence path, new model-output channel, new external-system probe, new deploy-target wiring, schema migration) must ship alongside a smoke / replay / probe script under `services/<service>/scripts/` or `scripts/`. Subagents ship the artifact; live verification runs from main-agent context where env vars are present.

## Key principles

- **Spec defines scope.** Don't add features or refactor beyond what the spec asks for.
- **The entry gate protects quality.** A task that isn't READY has not been planned. Don't implement unplanned work.
- **Commit incrementally.** Don't save everything for one final commit.
- **Document findings in the spec.** Update the task spec with progress, decisions, and verification outcomes — never create separate summary files.

## Regression examples

**mt#1399 — output-tools wiring (smoke test pattern).** The PR wired GPT-5's output-tools channel. Correctness required live verification that the model emits tool calls in the new format. A smoke script was shipped in the same PR; the main agent ran it post-creation and appended the redacted output to the PR body. No unit test could have caught a misconfigured tool-call schema.

**mt#1403 — cluster verification (replay script pattern).** The PR shipped a content-routing cluster. Correctness required verifying that 0 of 15 items from the original posting-body leak corpus fired through the cluster. A replay-verification script was shipped in the same PR; the main agent ran it against the live corpus and appended a structured JSON results file to the PR body. No unit test covers the full corpus distribution.

Both are the canonical instances of the live-verification gap pattern: subagent ships the artifact, main agent runs it.
