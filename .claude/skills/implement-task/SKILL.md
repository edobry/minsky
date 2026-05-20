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
Step 8: Create PR (IN-PROGRESS → IN-REVIEW)
Step 9: Hand off to verify

### 0. Entry gate: check task status

**This is the first and mandatory mechanical step.** Call `mcp__minsky__tasks_status_get` with the task ID.

Evaluate the returned status:

- **TODO or PLANNING** → halt immediately. Do NOT call `session_start`. Respond:
  > "Task mt#X is in `<STATUS>` state. Run `/plan-task mt#X` first to bring it to READY before implementing."
- **BLOCKED or CLOSED** → halt. Explain the status and ask the user how to proceed.
- **READY** → proceed to step 1 below. This skill owns the READY → IN-PROGRESS transition.
- **IN-PROGRESS** → a session may already exist. Retrieve it with `mcp__minsky__session_get` and continue from step 3.
- **IN-REVIEW** → PR already created. Remind user to use `/verify-task mt#X` for next steps.
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

3. **Probe-before-defer (mt#1819).** Scan the draft PR body, the spec's `## Outcome` section (if you've added one this session), and any "Live verification" / "Operator follow-up" subsections you're about to ship for the trigger-phrase patterns below. If any pattern matches, run the canonical tooling probe BEFORE the PR is created — don't post a deferral you haven't probed.

   **Trigger-phrase patterns** (match as patterns, not literal strings — `X` stands for any service/tool/account name):

   - "deferred to operator" / "deferred to user"
   - "requires X access" — e.g., "requires Railway access", "requires GitHub access", "requires admin token", "requires production access"
   - "user must do this" / "operator follow-up"
   - "outside agent context" / "not available from agent context"

   **Canonical probe sequence:**

   - CLI probe — `which <cli> && <cli> whoami` for the relevant tool (~5 sec).
   - Skill probe — search the available-skills system-reminder for `<service>:*` (e.g., `railway:use-railway`, `cloudflare:wrangler`).
   - Repo probe — check `scripts/<service>/`, `services/<service>/<service>.config.ts`, or similar.
   - Memory probe — `mcp__minsky__memory_search` for the service keyword.

   **If a probe returns "tooling is available"**, proceed with the action ONLY when it's in-scope under the current task's acceptance criteria AND safe (no destructive side-effects the spec hasn't authorized, no scope-expansion beyond what was planned). The probe just unblocks the assumption-of-unavailability; it doesn't override scope/safety gates.

   **If all probes fail OR the action is out-of-scope/unsafe even with tooling available**, replace the bare deferral with one that names the probe results AND the scope/safety basis inline: e.g., `"Probed: which gh → not on PATH; no GitHub-org-admin skill; no scripts/gh-admin/; no memory matches. Deferred — requires user with GitHub org-admin access."` or `"Probed: railway CLI available and authenticated. Action out-of-scope for this task (spec §Out of scope explicitly lists Railway env-var changes as a separate concern). Deferred."`. A bare deferral without inline probe results AND scope/safety basis fails this check.

   Origin: mt#1811 (2026-05-13) — PR #1100 body and the mt#1811 spec's `## Outcome` section both declared "deferred — requires Railway access" while the `railway` CLI was on PATH, the `railway:use-railway` skill was loaded, and the relevant memory was injected mid-session. User pushback ("Are you sure you need me for that?") triggered the probe; total fix time was <5 minutes. This step is the implement-task-pipeline enforcement of the broader `User Preferences §Probe before deferring` rule.

**Reactive phase (when iterating on reviewer findings):**

4. **Anti-rationalization.** When responding to a reviewer comment: did you change behavior, or did you just add a doc comment justifying the existing behavior? Documentation alone does not count as a fix. Verify the fix aligns with the _parent task's_ design intent (read the parent spec, not just the immediate ticket's text). Common failure mode: reviewer says "this default is wrong"; implementer adds a JSDoc explaining why the default is OK; reviewer flags it again because the value didn't change.

5. **Class-not-instance.** When the reviewer flags one specific site (e.g., "`glob` is unwrapped"), scan the implementation for other sites of the _same class_ (e.g., other unwrapped I/O like `fs.readFile`) and patch them all in one round. The reviewer-bot does cross-cutting audits; matching the comprehensive scan up-front is what converges iteration.

Origin: cascaded reviewer iteration on mt#1258 (PR #796 abandoned across 3+ rounds) and mt#1350 (PR #847, 5 reviewer rounds), plus mt#1811 (PR #1100 deferred-without-probing) for the probe-before-defer step. See `feedback_cascade_defense_in_implementer_prompt.md` and `feedback_probe_before_defer_at_action_time` for the pattern history.

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

### 8. Create PR (IN-PROGRESS → IN-REVIEW)

**This step owns the IN-PROGRESS → IN-REVIEW transition.**

Use `mcp__minsky__session_pr_create` to create the pull request:

- Title is description-only (no conventional commit prefix, no task ID)
- Body includes Summary, Key Changes, Testing sections
- The tool automatically rebases on main and sets task status to IN-REVIEW

### 9. Hand off to verify

After PR creation, **stop working on the session**. Do not continue committing.

Suggest to the user:

> "PR created. Run `/verify-task mt#X` to verify the implementation against all success criteria before merging."

**Do NOT** auto-run `/verify-task`, do NOT attempt to merge. Verification and merge are owned by the `/verify-task` skill and the review process.

### 10. Post-merge deploy verification (when the task touches a deployed service)

When the merged PR changes code that runs in a deployed service (anything under `services/<svc>/` that has a `deploy.config.ts`, or any source that the deploy image bundles via the project Dockerfile), do NOT stop at merge. The merge triggers an auto-deploy on Railway (or whatever platform the service declares); that deploy can fail in ways no pre-merge check catches — Dockerfile breakage, missing env var, schema migration error, container crash on start. Verify the post-merge deploy succeeded before reporting the task done.

**Primary mechanism: `mcp__minsky__deployment_wait-for-latest`.** Block-and-return on the latest deployment for the configured service. Returns the terminal `DeploymentRecord` (SUCCESS / FAILED / CANCELLED / CRASHED). Platform-neutral; the tool routes to the platform declared in `services/<svc>/deploy.config.ts` (Railway is the v1 concrete adapter). See `docs/deployment-platforms.md` for the abstraction.

**Follow-ups for inspection (not for waiting):**

- `mcp__minsky__deployment_status(service?)` — snapshot of the latest deployment without blocking.
- `mcp__minsky__deployment_logs(deploymentId, type?, lines?, service?)` — fetch build or runtime logs for a specific deployment. Block-and-return; streaming is out of scope for v1 (see mt#1725).

**Anti-patterns to avoid:**

- Polling the application's HTTP endpoint in a Bash loop.
- `ScheduleWakeup` with a guessed interval.
- Shelling out to `railway logs --build` from Bash — use the MCP tool.

**When the deploy fails:** call `deployment_logs(deploymentId, type: "build")` on the failed deployment ID, inspect the failure, and either fix-forward in a new PR or surface to the user with the logs attached.

This step does NOT change the task's DONE status — that's still owned by the at-merge handler. Post-merge deploy verification is a quality gate on the deploy itself, not the task lifecycle.

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
