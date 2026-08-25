import { defineSkill } from "../../../packages/domain/src/definitions/factories";

export default defineSkill({
  name: "implement-task",
  description:
    "Full implementation lifecycle for a Minsky task: read spec, plan, code, test, verify, commit, create PR, and drive to merge. All work happens in session workspaces via the session-scoped file tools. Use when implementing a task, starting development, or beginning work in a session.",
  userInvocable: true,
  content: `
# Implement Task

Step-by-step implementation lifecycle for a task within a Minsky session. Covers status-gating, session creation, PR creation, and PR-to-merge convergence.

**Owned lifecycle transitions:**

- READY → IN-PROGRESS: this skill owns this transition via \`session_start\`
- IN-PROGRESS → IN-REVIEW: this skill owns this transition via \`session_pr_create\`
- IN-REVIEW → DONE: this skill owns convergence-driving (§9) and the merge call (\`session_pr_merge\` standard path, or \`gh api PUT /merge\` bypass under documented conditions); the at-merge handler sets DONE atomically.

## Triggers

This skill activates on: "implement mt#X", "start coding mt#X", "build mt#X", "start working on mt#X".

These triggers are intentionally READY-state verbs — the skill guards against acting on tasks that are not yet READY.

## Arguments

Optional: task ID (e.g., \`/implement-task mt#123\`). If omitted, uses the current session's task.

## Process

Step 0: Entry gate: check task status
Step 0a: Late parallel-work spot-check
Step 0b: Load the lifecycle toolset bundle
Step 1: Retrieve relevant memory context
Step 2: Read and verify the task spec
Step 3: Start a session (READY → IN-PROGRESS)
Step 4: Understand architectural context
Step 5: Plan the implementation
Step 6: Develop
Step 7: Verify implementation
Step 7a: Ship verification artifact for structural changes (when in scope)
Step 8: Create PR (IN-PROGRESS → IN-REVIEW)
Step 9: Drive PR to convergence (IN-REVIEW → merge)

### 0. Entry gate: check task status

**This is the first and mandatory mechanical step.** Call \`mcp__minsky__tasks_status_get\` with the task ID.

Evaluate the returned status:

- **TODO or PLANNING** → halt immediately. Do NOT call \`session_start\`. Respond:
  > "Task mt#X is in \`<STATUS>\` state. Run \`/plan-task mt#X\` first to bring it to READY before implementing."
- **BLOCKED or CLOSED** → halt. Explain the status and ask the user how to proceed.
- **READY** → proceed to step 1 below. This skill owns the READY → IN-PROGRESS transition.
- **IN-PROGRESS** → a session may already exist. Retrieve it with \`mcp__minsky__session_get\` and continue from step 3.
- **IN-REVIEW** → PR already exists. Drive convergence per §9: call \`mcp__minsky__session_pr_wait-for-review\` with \`reviewer: "minsky-reviewer[bot]"\`, branch on the review state, and proceed to \`session_pr_merge\` (standard path) or the documented bypass conditions. \`/verify-task\` applies ONLY to the bypass-merge closeout path (per the post-mt#1551 architecture); for the standard merge path, the at-merge handler sets DONE atomically and no \`/verify-task\` invocation is needed.
- **DONE** → task is complete. No action needed.

### 0a. Late parallel-work spot-check

The PLANNING → READY gate already ran the full parallel-work check (\`/plan-task\` gate
criterion g). But READY → IN-PROGRESS may happen hours or days later, and new PRs may
have landed in the gap. Re-run an abbreviated check before \`session_start\`.

**Step ordering note:** §0a needs the spec's \`## Scope\` → \`In scope\` file list to know
what to check against. If the spec has not yet been loaded into context, fetch it now via
\`mcp__minsky__tasks_spec_get\` (the same call §2 makes) so §0a has the file list to work
with. §2 will simply re-use the loaded spec when it runs.

Then run both sweeps:

1. **Open-PR sweep** — \`mcp__github__list_pull_requests\` with \`state: "open"\`. Scan titles
   and branches for any PR whose scope plausibly overlaps the spec's \`## Scope\` → \`In scope\`
   files. Titles and branches are a CANDIDATE FILTER, not evidence about files: for any
   candidate you would act on, read its actual changed-file list with
   \`mcp__github__pull_request_read\` method \`get_files\` before recording a collision.

   **A file-level collision claim must cite an observed changed-file list (mt#3806).** The
   evidence is \`get_files\`/\`get_diff\` for an open PR, or \`mcp__minsky__git_log\` with the file
   path filter (\`git_log --path\`) for work that already merged — both sweeps below, and both
   are file-level reads. A task's title, its \`## Scope\` section, or an inference about where
   that kind of code lives is not evidence about which files were touched. \`get_files\` is the
   cheap default — it returns a filename list, which is the whole question here; reserve
   \`get_diff\` for when the hunks actually matter.

   **When the other work has no PR yet, a file-level claim is UNAVAILABLE.** Do not substitute
   prose for the missing list. Record "task-level adjacency, files unknown" and decide on that
   basis — which is a weaker finding than a collision and should not, on its own, halt work.

   Origin (mem#892, 2026-08-05): this step halted on a claimed \`SessionFilmStage.tsx\` collision
   with mt#3792. That PR changed \`PanZoomSVG.tsx\`, its test, and a verify script — the stage was
   never in it. The filename came from mt#3792's title plus an inference about where camera code
   lives. One \`get_files\` call falsified it, and was made only after the principal prompted to
   resume, by which point a turn was spent and a false blocking gap was written into the spec.
2. **Recently-merged sweep** — \`mcp__minsky__git_log\` for the last 24 hours; check for any
   merge that touched files this task plans to modify. A fix that landed overnight is just
   as bad as one in flight.

If either sweep hits, **halt before \`session_start\`** and surface the finding to the user
(task ID or PR number, file overlap, recommendation: wait / coordinate / reframe / proceed
with explicit acknowledgment).

This is the last-line enforcement of \`feedback_check_parallel_work_before_decomposing\`.
The full gate ran at PLANNING; this is the spot-check before the session is created.

### 0b. Load the lifecycle toolset bundle (mt#2822)

Once the entry gate confirms this run is actually going to execute the lifecycle (READY or
IN-PROGRESS), load the whole standard-lifecycle tool set in **one** \`ToolSearch\` call instead
of discovering tools piecemeal at each phase (session start, then commit, then PR, then
wait-for-review, then merge, then deploy-verify — each its own round-trip). Measured baseline
(mt#2822): three recent standard implement→PR→merge→deploy conversations cost 21, 15, and 13
\`ToolSearch\` calls respectively (conversation \`6cac7a30\`, \`ac4f5675\`, \`4b019e33\`) — mostly
fragmented 1-2-tool discovery calls with no decision content, not exploratory search.

Call this once, right after the entry gate, before Step 1. \`tasks_spec_get\` is included
directly (not conditionally) because Step 2 needs it immediately after this step and Step 0a
may not have loaded it yet (it only loads the spec on-demand if \`## Scope\` parsing requires
it):

\`\`\`
ToolSearch(query: "select:mcp__minsky__session_start,mcp__minsky__session_exec,mcp__minsky__session_read_file,mcp__minsky__session_search_replace,mcp__minsky__session_write_file,mcp__minsky__validate_typecheck,mcp__minsky__validate_lint,mcp__minsky__session_commit,mcp__minsky__session_update,mcp__minsky__session_pr_create,mcp__minsky__session_pr_wait-for-review,mcp__minsky__session_pr_checks,mcp__minsky__session_pr_merge,mcp__minsky__session_pr_get,mcp__minsky__forge_check_runs_list,mcp__minsky__deployment_wait-for-latest,mcp__minsky__tasks_spec_get,mcp__minsky__tasks_spec_patch,mcp__minsky__tasks_status_set", max_results: 30)
\`\`\`

(\`max_results\` set above the current 19-tool count with headroom — if this list grows, bump
\`max_results\` in step so a future addition can't silently truncate the returned set below what
was requested.)

**Verified, not assumed (mt#2822):** \`ToolSearch\`'s \`select:\` accepts a long comma-separated
tool list in one call with no observed length limit — 16 names loaded cleanly in one call
during this bundle's own verification, and a naturally-occurring 10-tool \`select:\` call
already appears in production transcript \`4b019e33\` (an agent self-bundling by hand, which is
exactly what this step now does by default).

**Context-cost check (mt#2822 acceptance criterion):** front-loading pays the bundle's full
schema-token cost once, up front, whether or not every tool in it ends up used this run. For a
run that actually executes the standard lifecycle — the case this step targets — nearly every
tool in the bundle gets used, so the schema-token cost is the same as lazy discovery would have
paid anyway; the win is eliminating the ~15-20 extra round-trip envelopes (tool_use + tool_result
framing) and the agent-turn overhead of deciding what to search for next at each phase boundary.
The one real cost: a run that's known in advance to skip a whole phase (e.g. a docs-only PR that
will never call \`deployment_wait-for-latest\`) pays for one or two unused ~300-400-token schemas
it would not have discovered lazily — small relative to the round-trip overhead removed. See the
mt#2822 PR body for the full token comparison.

### 1. Retrieve relevant memory context

Call \`memory_search\` with the task ID and domain area:

- Query: e.g., \`"mt#<id>"\` or the feature area (e.g., \`"session liveness"\`, \`"compile pipeline"\`)
- Review any returned memories for prior decisions, user preferences, or architectural constraints
- This replaces the always-loaded MEMORY.md preamble — context is fetched on-demand

### 2. Read and verify the task spec

- Fetch the spec: \`mcp__minsky__tasks_spec_get\` with the task ID
- Read every success criterion and acceptance test
- **Verify spec freshness**: Specs may be stale from prior conversations. Check file:line references against the current codebase before starting.
- Never proceed based on title/database info alone — the full spec is required

**Ref-drift freshness recheck (mt#2826).** Specs cite other tasks (\`mt#N\`) and PRs (\`PR #N\` /
\`#N\`) whose state can change between spec authoring and implementation entry — in a fast-moving
parallel-agent graph this window is often hours, sometimes overnight (evidence: conversation
eceb6092, mt#2752's spec authored before mt#2766/2767/2768, mt#2441, and mt#2756 all shipped).
Immediately after fetching the spec, call \`mcp__minsky__tasks_spec_freshness\` with the task ID:

- **\`hasDrift: false\`** → proceed silently. No ritual output — this is the common case and must
  not interrupt the flow.
- **\`hasDrift: true\`** → the tool returns a \`drift\` array, one entry per changed ref (\`ref\`,
  \`kind\`, \`currentStatus\`, \`refUpdatedAt\`, \`daysSinceSpecEdit\`). Render it as a table to the user
  and require an explicit disposition, recorded in the transcript, before writing any code:
  - **Amend** — the drift changes what the spec should say (a cited dependency shipped, a blocker
    cleared, a stated assumption no longer holds). Call \`mcp__minsky__tasks_spec_patch\` to update
    the spec with the change and its basis; the amendment itself is the disposition record.
  - **Proceed-acknowledged** — the drift doesn't change the plan (e.g. a cited task finished exactly
    as expected, or the change is immaterial to this task's scope). State the one-line
    acknowledgment in the transcript (e.g. "mt#2812 went DONE 2026-07-16 as expected — no spec
    change needed") and continue.
  - Rendering the drift table and then silently continuing past it — neither amending nor stating
    an acknowledgment — is a process violation of this step.

This is a mechanical, status-timestamp-only check (v1, per the mt#2826 spec's Scope) — it detects
"something about this ref changed since the spec was written," not "the spec's specific claim
about this ref is now false" (semantic staleness is explicitly out of scope for v1; see
\`/plan-task\` gate battery for the authoring-side freshness disciplines this complements, and
mt#2534 for the sibling artifact-content premise-recheck).

### 3. Start a session (READY → IN-PROGRESS)

**This step owns the READY → IN-PROGRESS transition.**

Call \`mcp__minsky__session_start\` with the task ID. This:

- Creates an isolated session workspace
- Sets task status to IN-PROGRESS

All subsequent file operations go through the session-scoped file tools, which take the \`sessionId\` returned by \`session_start\` plus a path RELATIVE to the session root:

| Operation | Tool |
| --- | --- |
| Read a session file | \`mcp__minsky__session_read_file\` |
| Targeted edit | \`mcp__minsky__session_search_replace\` |
| Create or fully rewrite | \`mcp__minsky__session_write_file\` |

A session id plus a relative path cannot silently address the MAIN workspace the way an absolute path can — that is the point of the split. \`mcp__minsky__session_edit_file\` is fast-apply-model-based and carries three documented failure modes in its own description; it is NOT the default, and is for edits spanning many regions. The harness-native \`Read\`/\`Edit\`/\`Write\` remain correct for MAIN-workspace files.

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
- **Testable-design checkpoint (mt#3632), before writing each test.** If observing a behavior
  will require patching a collaborator the code reaches itself — a \`spyOn\` on an
  object/module import rather than a value the function returns or a dependency it was handed —
  STOP. That is design feedback, not a test-writing problem: extract the decision into a
  function that returns the observable (functional core, imperative shell), inject the
  collaborator instead of reaching for it, per \`testing-standards.mdc §Testable Design\`. This
  is a judgment call, not a mechanical gate — its backstops are the reviewer's test-shape checks
  (mt#3631) and the \`no-jest-patterns\` lint rule's \`jestSpyOn\` message (mt#3565/mt#3632). If
  you proceed with a patch anyway, record in the PR body which collaborator and why extraction
  wasn't the right call for this case.
- Add tests for new functionality
- Commit regularly with \`mcp__minsky__session_commit\`:
  - Use meaningful messages referencing the task ID
  - Group related changes in logical commits
- All file edits go through the session-scoped tools (\`session_search_replace\` for a targeted edit, \`session_write_file\` for a create/rewrite) — session id plus a relative path, per §3
- **Run commands in the session** using \`mcp__minsky__session_exec(task: "mt#<id>", command: "<cmd>")\` — e.g., \`bun test\`, \`bun run format:check\`, \`git status\`. Never use \`git -C <path>\` or shell \`cd\` workarounds.

### 7. Verify implementation

Before declaring complete:

- **Verify outcomes, not actions.** Never treat a command succeeding (exit 0, API 200) as proof the desired effect occurred. Read back the result: query the setting you changed, count rows after a migration, call the tool you registered.
- If the task spec has acceptance tests, **execute them** — don't just re-read the spec
- Verify rule compliance (architecture, testing, code quality rules)
- **Typecheck covers every project CI checks (mt#2256, widened by mt#3183).** A default \`mcp__minsky__validate_typecheck\` (no \`workspace\` arg) now covers the same set CI's \`build\` job runs: the root tsconfig, every workspace that declares its own \`typecheck\` script (currently \`services/reviewer\`, whose tsconfig enables \`noUncheckedIndexedAccess\` — stricter-by-scope than root, whose \`include\` set excludes \`services/\`), \`src/cockpit/web\`, and every standalone root-level tsconfig project a \`typecheck:*\` script names via \`-p\` (\`tsconfig.hooks.json\` covering \`.claude/hooks/**\`, \`tsconfig.scripts.json\` covering \`scripts/**\`). So when you touch \`services/*\`, \`scripts/*\`, or \`.claude/hooks/*\`, the default run already covers them — you do NOT need to run \`bun run typecheck:scripts\` / \`typecheck:hooks\` separately. The result's \`workspaces\` field names every project actually checked; read it rather than assuming. **Read \`skippedProjects\` beside it (mt#3895)** — a discovered project whose dependencies are not installed locally is skipped with a reason rather than run, so \`workspaces\` alone is "what ran", not "what exists". Each entry carries the reason and the install that would include it, so read the entry rather than assuming which project it is; CI runs these projects with their own install steps, so coverage is unaffected. (Pass an explicit \`workspace\` to scope the check to a single directory.) Until mt#3183 this claim was true only for workspace-declared scripts: \`scripts/**\` and \`.claude/hooks/**\` type errors passed locally and failed CI. The \`.minsky/hooks\` SOURCE-tree gap this paragraph used to name is CLOSED as of mt#2900 — \`tsconfig.hooks.json\` now includes both the generated \`.claude/hooks\` tree and the \`.minsky/{hooks,skills,agents}\` source, so a source edit is checked without compiling first.
- **Target the SESSION workspace, not main (mt#2336).** \`validate_typecheck\` / \`validate_lint\` default to the MAIN repo (the MCP server's cwd). Pass \`task\` or \`sessionId\` so they validate THIS session's changes — e.g. \`validate_typecheck({ task: "mt#<id>" })\` — otherwise they typecheck/lint main and report a misleading clean result that ignores your edits. (An explicit \`workspace: <session dir>\` also works; with no routing arg they fall back to cwd.) Each result carries a \`validatedWorkspace\` field naming the directory actually checked — confirm it is the session dir, not main. Equivalently, run \`bun run typecheck\` via \`session_exec\` (it runs inside the session).

#### Convergence checklist (mandatory before §8)

Before invoking step §8 (Create PR), walk through this checklist; if any check fails, fix the gap before creating the PR.

**Checklist-authoring discipline (mt#3302).** When a retrospective or task adds a NEW item to this checklist for a code-defect class, name its enforcement tier — ESLint rule / pre-commit or PreToolUse hook / CI check / merge gate / prompt-time prose (checklist item) — per the table in \`/retrospective\` Step 4, and tag the new item's heading with the SAME \`[tier: ...]\` format that skill's \`### Fixes\` template requires, e.g. \`11. **New check name** [tier: CI check]: ...\`. Containment evidence (mt#3295 §Measured corpus results item 4): the prose-only "Spec-decision reconciliation" and "Production-wiring + real-binding verification" items recurred 14x/13 PRs (rising) and ~2x post-ship respectively; the gated "Guard/rule documentation" (compile-check) and "Added a new test file?" execution-evidence items (merge gate) held near-zero. If prose is the right tier for a mechanizable class, state why a deterministic mechanism isn't shipping now and file a tracking task for it.

**Preventive phase (before first PR creation):**

1. **Trust-boundary defensive coverage.** Every site where external input enters the system needs a runtime guard or wrapper. Grep for each category below and confirm each hit has a \`try/catch\` wrapper, a \`safe*\` helper, or a runtime type guard (Zod, manual \`typeof\`, etc.) on the result:

   - File I/O: \`fs.readFile\`, \`fs.readdir\`, \`fs.stat\`, \`fs.writeFile\`, \`glob\`, \`fs.mkdir\`
   - Network: \`fetch\`, HTTP calls, RPC clients, MCP calls
   - Database: every query (connection loss, schema mismatch, constraint violation)
   - Subprocess: \`exec\`, \`spawn\`, \`child_process.*\`
   - Deserialization: \`JSON.parse\`, type casts (\`as Foo\`) on parsed data, parsing user input
   - Configuration: \`process.env.X\`, config-file reads
   - Request bodies, webhook payloads, anything from the network boundary

2. **Portable defaults.** No defaults bind to a specific user, machine, or host. No \`homedir()\`-derived absolutes baked into defaults; no user-specific paths embedded as constants. Mental model: "would this work on a fresh machine for a new user?"

3. **Probe-before-defer (mt#1819).** Scan the draft PR body, the spec's \`## Outcome\` section (if you've added one this session), and any "Live verification" / "Operator follow-up" subsections you're about to ship for the trigger-phrase patterns below. If any pattern matches, run the canonical tooling probe BEFORE the PR is created — don't post a deferral you haven't probed.

   **Trigger-phrase patterns** (match as patterns, not literal strings — \`X\` stands for any service/tool/account name):

   - "deferred to operator" / "deferred to user"
   - "requires X access" — e.g., "requires Railway access", "requires GitHub access", "requires admin token", "requires production access"
   - "user must do this" / "operator follow-up"
   - "outside agent context" / "not available from agent context"

   *Deferring to a later TIME or condition (mt#3200) — same probe, different shape:*

   - "deferred to post-merge" / "deferred until X ships" / "will verify after X"
   - "can't verify until X" / "needs X first" / "blocked on X landing"
   - "verification deferred" with no named actor

   **The probe question is availability-NOW, regardless of what the deferral defers TO.** Origin of this second group: mt#3189 / PR #2282 (2026-07-24) deferred live verification with "deferred to post-merge … the pre-change measurement was taken against merged main, so the post-change comparison needs this merged too." No actor-shaped phrase matched, so no probe fired — and the reason was false: serving a cockpit from the session workspace produced the verification in ~2 minutes. \`minsky-reviewer[bot]\` posted BLOCKING and the finding was legitimate. A deferral to a later time is a claim about your PRESENT capability and needs the same evidence as a deferral to a person.

   **Canonical probe sequence:**

   - CLI probe — \`which <cli> && <cli> whoami\` for the relevant tool (~5 sec).
   - Skill probe — search the available-skills system-reminder for \`<service>:*\` (e.g., \`railway:use-railway\`, \`cloudflare:wrangler\`).
   - Repo probe — check \`scripts/<service>/\`, \`services/<service>/<service>.config.ts\`, or similar.
   - Memory probe — \`mcp__minsky__memory_search\` for the service keyword.

   **If a probe returns "tooling is available"**, proceed with the action ONLY when it's in-scope under the current task's acceptance criteria AND safe (no destructive side-effects the spec hasn't authorized, no scope-expansion beyond what was planned). The probe just unblocks the assumption-of-unavailability; it doesn't override scope/safety gates.

   **If all probes fail OR the action is out-of-scope/unsafe even with tooling available**, replace the bare deferral with one that names the probe results AND the scope/safety basis inline: e.g., \`"Probed: which gh → not on PATH; no GitHub-org-admin skill; no scripts/gh-admin/; no memory matches. Deferred — requires user with GitHub org-admin access."\` or \`"Probed: railway CLI available and authenticated. Action out-of-scope for this task (spec §Out of scope explicitly lists Railway env-var changes as a separate concern). Deferred."\`. A bare deferral without inline probe results AND scope/safety basis fails this check.

   Origin: mt#1811 (2026-05-13) — PR #1100 body and the mt#1811 spec's \`## Outcome\` section both declared "deferred — requires Railway access" while the \`railway\` CLI was on PATH, the \`railway:use-railway\` skill was loaded, and the relevant memory was injected mid-session. User pushback ("Are you sure you need me for that?") triggered the probe; total fix time was <5 minutes. This step is the implement-task-pipeline enforcement of the broader \`User Preferences §Probe before deferring\` rule.

4. **Guard/rule documentation (mt#2208).** If this PR adds or modifies a pre-commit guard, a Claude Code hook (\`.claude/hooks/*\`), an ESLint rule, or any mechanism whose siblings are documented in a \`.minsky/rules/*.mdc\` section (e.g., the pre-commit guards documented in \`hook-files.mdc\`), document the new mechanism in the SOURCE rule and recompile IN THIS PR — before \`session_pr_create\`. Skipping this means the reviewer-bot's \`## Documentation impact\` check returns BLOCKING at review time, costing a full extra round.

   - Edit the canonical source — \`.minsky/rules/<file>.mdc\` — NOT the generated \`CLAUDE.md\` / \`AGENTS.md\` / \`.cursor/rules/\` outputs. Then run \`bun run src/cli.ts compile\`. A bare invocation regenerates every target that already has output on disk — \`claude.md\`, \`agents.md\`, \`claude-rules\`, \`cursor-rules-ts\`, and the skill/agent/hook targets — in one pass, and reports each target it wrote (mt#2803).
   - **Do NOT run \`rules compile\` (mt#3309).** The legacy command was retired by the mt#3058 cutover: a bare \`rules compile\` regenerates NOTHING and still prints \`✅ Success\`. Following it ships a PR whose \`.mdc\` source changed but whose generated outputs did not — precisely the mt#2208 Documentation-impact BLOCKING this item exists to prevent. (Explicit \`rules compile --target claude.md\` still functions today, but it is legacy and goes away with mt#2996; use \`compile\` instead.)
   - **Verify the outputs actually regenerated — do NOT trust the exit code.** A compile command's success signal is not evidence of regeneration: \`rules compile\` printing \`✅ Success\` while writing nothing is exactly how mt#3309 was found. Check all three, every time:
     1. The compile run's per-target report lists every target your change should have touched — it prints \`Target "<name>": N file(s) written\` per target, so a missing target is visible.
     2. \`git status\` shows those generated outputs as modified.
     3. \`grep\` your new section in EACH output the rule feeds, not just one. An \`alwaysApply\` rule lands in \`CLAUDE.md\`, \`AGENTS.md\`, AND \`.cursor/rules/<name>.mdc\`; a path-scoped rule (\`globs\` + \`alwaysApply: false\`) lands in \`.claude/rules/<name>.md\` and \`.cursor/rules/<name>.mdc\` (verified mt#3309). Grepping \`CLAUDE.md\` alone verifies ONE target out of three — it is the spot-check that caught mt#3309, not a sufficient check on its own.
   - Register any new \`MINSKY_*\` env var in \`HOOK_ONLY_ENV_VAR_CATEGORIES\` (mt#1788, mt#3882), giving it a category: \`operator-override\` (a guard/gate/detector consults it as its own override), \`test-fixture\`, or \`tunable\`. \`HOOK_ONLY_ENV_VARS\` is DERIVED from that record's keys — do not edit it directly. Picking \`operator-override\` obliges you to add the same name to \`.minsky/hooks/known-override-env-vars.ts\`; \`known-override-env-vars.test.ts\` fails naming the entry if you don't.
   - **Triage any hook you register in \`.claude/settings.json\` in \`packages/domain/src/rules/enforcement-mapping.ts\` (mt#4367)** [tier: pre-commit gate]. Adding the hook to \`settings.json\` is not the last step: \`enforcement-mapping.test.ts\` asserts that EVERY registered hook is either an \`ENFORCEMENT_MAPPINGS\` mechanism or an explicitly-reasoned \`NON_ENFORCEMENT_CLAUDE_HOOKS\` entry, so a hook in neither place fails the build. Which of the two is not a judgment call: a guard that DENIES — or otherwise IS some rule's enforcement mechanism — goes in \`ENFORCEMENT_MAPPINGS\` with its \`configPath\`; a record-only, log-only, or injection-only observer enforces nothing and goes in \`NON_ENFORCEMENT_CLAUDE_HOOKS\` with a reason (the test requires a non-empty one). Reproduce the check with \`bun scripts/run-related-tests.ts .claude/settings.json\`.
   - **Why that tier, and why this bullet is not the mechanism.** The three registries above are each gated, and this one was not: until mt#4367, \`.claude/settings.json\` appeared in \`enforcement-mapping.test.ts\` only inside comments, so the data-read edge (mt#4224) never formed and the fast related-test gate selected ZERO tests for a settings.json change. \`audit:interceptors\` passes (it checks the interceptor CATALOG, a different registry), and typecheck and lint pass (it is an assertion, not a type or style error) — so the first signal was a full CI run, arriving after the PR had already been APPROVED (mt#1880, two jobs red on one assertion out of 14608 passing tests). mt#4367 named the path as a resolvable literal in that test, which moves the signal to pre-commit. This bullet documents a gate that now fires; it is not prose standing in for one.

   Origin: mt#2208 / PR #1453 (2026-05-31) — the deploy-domain ownership guard shipped without its \`hook-files.mdc\` section (every sibling guard there is documented). The reviewer-bot's Documentation-impact check returned BLOCKING, costing an extra round + a recompile gotcha (the no-\`--target\` invocation regenerated \`AGENTS.md\` but not \`CLAUDE.md\` — historical: mt#2803 fixed that specific unreliability, and the current trap is the different one named in the bullets above). See \`feedback_new_guard_needs_source_rule_doc_at_authoring_time\`.

5. **Spec-decision reconciliation.** Re-read the spec's \`Design Decisions\` / \`Success Criteria\`. For each, confirm the implementation reflects it. If you deviated from a stated decision mid-implementation (e.g., on the basis of a local code convention or comment), you MUST either (a) update the spec to record the change + rationale, or (b) revert to the spec — never leave an unreconciled spec-vs-impl divergence for the reviewer to find (a guaranteed extra round). A convention comment in ONE file is a claim about a local choice, not evidence of a global rule: grep for counter-examples across the broader codebase before letting it override a spec decision (see memory \`d624c862\`).

   **Recording is necessary, not sufficient — and this item no longer carries the enforcement (mt#3587).** Option (a) above says to record the change plus a rationale; it never said the rationale has to be RIGHT, and a confidently-argued wrong one ships looking reconciled. A silent divergence invites checking; a documented one reads as decided, so the remedy makes the failure harder to catch — a plausible contributor to this item's 14x recurrence. The reviewer's spec-verification pass now treats a recorded deviation as a claim to VERIFY rather than a resolution, checked against the diff's actual behavior. Write the rationale so it can be checked: name the mechanism it rests on. Do NOT read this pointer as permission to skip (b) — reverting to the spec is still the right move whenever the deviation was not deliberate. The PLACEMENT half — amending the criterion's own text rather than explaining it elsewhere — is mem#986's rule, and is enforced separately (mt#4213).

   Origin: mt#2415 / PR #1711 R1 (2026-06-16) — the spec's Design Decision said \`project_id\` was a \`uuid FK -> projects.id\`; mid-implementation the decision was overridden to a no-FK plain ref after reading one file's "no FK constraints — plain text refs per project convention" comment, without checking that the agent-transcripts cluster DOES use uuid FKs and without re-reading the spec. The reviewer-bot's Spec-verification table caught the divergence (2 BLOCKING findings), costing a round. This step shifts that catch left to author time. Deciding-time recurrence of memory \`d624c862\`; see \`488d4796\`.

6. **Architectural-pattern community-practice check (mt#2503).** Before committing a significant architectural pattern — a new workspace package, a module/package-boundary restructure, a re-export / proxy / barrel pattern, or a choice between competing structural approaches where the cheaper one is unvalidated — run ONE web search for community practice on the pattern and cite it (one line) before committing the approach. Evaluate the cheaper-effort path for CORRECTNESS, not just scope. This is the implement-execution-time sibling of \`/plan-task\` gate (l) (mt#2445), which covers plan/recommendation time.

   Origin: mt#2108 (2026-05-25/26) — the \`packages/domain/\` extraction chose a barrel re-export to avoid a 224-file import rewrite; it hit an immediate runtime error (\`getConfigValue\` export not found), and a 30-second community-practice search returned unambiguous consensus (Turborepo / Nx / Coder Spirit / WebDong) that barrel re-exports in monorepos are an anti-pattern. R6 of the build-path-as-research family (\`f6607043\`); see \`4012b934\`.

7. **Added a new test file? (mt#2530)** Two already-shipped gates fire at MERGE when a PR adds a NEW test file. Front-load BOTH in the PR body BEFORE \`session_pr_create\`, or they surface reactively as sequential merge blocks — each costing a full round:

   - **(a) No placeholder assertions** in your tests. The Prevent-Placeholder-Tests CI check (mt#1938, \`.github/workflows/test-quality.yml\`) greps the repo for \`expect(true).toBe(true)\` and comment-marked placeholders — so it fires on ANY test file you ADD OR MODIFY (broader scope than (b)); also avoid \`.skip\`, \`.todo\`, and empty test bodies. For a compile-time-only test (e.g. a \`// @ts-expect-error\` type-guard assertion), PAIR the directive with a REAL runtime assertion so the test still exercises executable behavior.
   - **(b) An \`Execution evidence:\` block in the PR body** — the LITERAL heading WITH the colon (the mt#1459 merge gate matches the regex \`/Execution evidence:/\`, NOT a markdown \`## Execution evidence\` heading without the colon). Put it near the PR body's Testing / Test Plan section (mirrors \`/prepare-pr\` §1b) and paste the ACTUAL test-run output for the new test files (\`bun test ... <files>\` — pass/fail counts + file names), not a promise to run them. **Accepted marker forms (case-insensitive; mt#2648, widened mt#3968):** a Markdown heading of any level with an optional trailing colon, or the plain label with a REQUIRED colon — which may also be \`**bold**\` (\`**Execution evidence:**\` or \`**Execution evidence**:\`) and/or preceded by a leading Markdown bullet (\`-\`, \`*\`, or \`+\`); the colon requirement is unchanged by the bold/bullet widening. The mt#1459 gate BLOCKS on **newly ADDED** test files only — a renamed/copied non-test→test conversion counts; MODIFYING an existing test does not reach the blocking floor (this matches \`/prepare-pr\` §1b's "newly created, not just modified" scope). **But as of mt#3244 a modified test file is no longer invisible**: if the PR is bugfix-shaped (a \`fix(\` title type, or a bound task whose spec describes a defect), a separate log-only surface asks for a NEGATIVE CONTROL — see (e) below. If you genuinely cannot run them, use the \`[unverified-tests]\` title-tag escape hatch (\`/prepare-pr\` §1b) with a documented reason instead.
   - **(c) Per-AT coverage (mt#3033, calibration-first).** Independent of (a)/(b)'s file-pattern trigger, the gate additionally cross-references the bound task's \`## Acceptance Tests\`: for each AT it classifies as executable (skipping \`state-ops\`-kind tasks and findings-shaped ATs like "audit produces…" / "decision recorded…"), the \`Execution evidence:\` block should reference that AT by number (\`AT3\`, \`AT#3\`, \`acceptance test 3\`) or a distinctive keyword from its text — or the PR body should carry a \`[atN-deferred: mt#NNNN]\` marker naming a tracked follow-up task for that specific AT. As of mt#3033 this check is **log-only** (per the mt#2263 calibration ladder): an unaddressed AT logs a calibration record and surfaces a WARN in \`additionalContext\`, it does NOT block merge. Address it anyway — the point is real per-AT evidence (or an explicit, tracked deferral) instead of a proxy that silently skips the literal acceptance test, which is exactly the mt#2542 incident this addition exists to catch. Override (should not normally be needed): \`MINSKY_SKIP_AT_COVERAGE=1\`.

     **Three authoring requirements the gate depends on (mt#3200).** The check above can only match evidence written a particular way, and that convention was never stated — so it emitted unmatchable warnings, which trains readers to discount its true positives:

     1. **Use the bound task spec's OWN AT numbering.** Do not renumber in the PR body. A PR that writes its own 1..N list cannot line up with the spec's numbering, so no AT can ever match.
     2. **Put the references, and their evidence, INSIDE the \`Execution evidence:\` block.** The gate scans that block only. Evidence living in a \`## Live verification\` (or any other) section is invisible to it — if it must live elsewhere, cross-reference it from inside the block.
     3. **If an AT genuinely cannot run pre-merge, use the \`[atN-deferred: mt#NNNN]\` marker**, not prose. Prose explaining why an AT was skipped reads as coverage to a human and as nothing to the gate.

     Counter-example — mt#3189 / PR #2282 (2026-07-24) violated (1) and (2) simultaneously: its body carried an "Acceptance tests by number" list using an independent 1–7 numbering, and put real live-verification output under \`## Live verification\`. The gate reported 5 of 6 ATs unaddressed; one was genuinely untested, the rest were unmatchable by construction. Same session, PR #2264 produced a pure false positive the same way. See mem#719 for why that noise is costly: a detector emitting unmatchable output erodes trust in its correct output.

   - **(d) Per-criterion coverage of \`## Success Criteria\` (mt#3350, calibration-first).** The same gate ALSO cross-references the bound task's \`## Success Criteria\` — a different section from (c)'s, and one that until mt#3350 was read by nothing at all. Only the mechanically-EXECUTABLE criteria count: a criterion that names a runnable check plus an expected result (a backticked \`grep\`/\`rg\`/\`wc\`/\`find\`, a \`$ <cmd>\` line, "returns zero hits", "the count is N"). Judgment-shaped criteria are classified and left alone — the classifier's default is NON-executable, the inverse of (c)'s, because a criteria list is mostly prose. For each executable criterion, the \`Execution evidence:\` block should carry that command's ACTUAL output, or reference it by number (\`SC3\`), or the body should carry a dedicated \`## SC3\` section — or an explicit \`[scN-deferred: mt#NNNN]\` marker for that specific criterion. The marker is per-criterion and NUMBERED: \`[sc1-deferred: ...]\` does not excuse criterion 2. Log-only per the mt#2263 ladder. Override: \`MINSKY_SKIP_SC_COVERAGE=1\`.

       **A criterion that names a command IS its own check — run it.** Originating incident (mt#3347): the spec's first criterion was "a repo-wide grep for \`<select\` under \`src/cockpit/web\` returns zero hits outside the primitive itself." It was authored by the agent ~40 minutes before implementation and never run. 21 of 22 call sites migrated; the 22nd was the exact control in the principal's screenshot. It shipped past clean typecheck (5 projects), clean lint (2920 files), 1487 passing tests, a commit and a push. The one-line grep would have settled it in under a second at any point. Per mem#736, self-authorship is an AGGRAVATING factor, not a mitigating one — weight this check UP when you wrote the spec yourself this session, because what you retain is the intent and the divergence lives in the specifics.

   - **(e) Negative control on a bugfix (mt#3244, calibration-first).** If the PR is **bugfix-shaped** — a \`fix(\` conventional-commit type on the title, or a bound task whose spec describes a defect — and it **modifies an existing test file**, the \`Execution evidence:\` block should also record a **negative control**: the changed test run against the UN-FIXED tree, observed FAILING. Revert the fix (or stub the condition), run the test, paste the failure alongside the passing run. **Where the label goes (mt#3511, corrected mt#3584):** on its OWN line, NOT inside a code fence. That is the ONLY placement rule — the label is matched anywhere in the PR body, so it need not sit inside the \`Execution evidence:\` block (beside the run output just reads best). A fenced marker is treated as quoted text and will not match, which is the trap the original wording ("inside the evidence block") set. Accepted forms (case-insensitive): \`Negative control: <what you reverted and what failed>\`, \`Negative control — <subject>\` (em or en dash — use this when the PR has several, each with its own subject), \`Failing-first:\` in either form, or a Markdown heading naming either. A leading \`-\` bullet and surrounding \`**bold**\` are fine — and so is a CRITERION PREFIX (\`sc3 — negative control:\`, \`AT4: negative control — <subject>\`, or \`sc3 — negative control.\` with the run on the lines beneath). Prefixing is what writers do when tying each control to its criterion, and the matcher rejected every such form until mt#3778: the gate had logged 42 consecutive fires with ZERO passes, a quarter of the classifiable ones being real controls it could not see. The failing run itself MAY be fenced beneath the label. If it genuinely cannot be run pre-merge, use \`[negative-control-deferred: mt#NNNN]\` naming a tracking task — prose does not count. Log-only per the mt#2263 ladder. Override: \`MINSKY_SKIP_TEST_FIRST_EVIDENCE=1\`.

     **What a negative control does NOT buy you.** It proves the probe CAN fail. That is worth having, and it is narrower than it feels. Three things it does not establish, each with its own incident:

     - **Right system (mt#3574).** It does not prove the probe is observing the RIGHT SYSTEM — a control run in a substitute runtime is just as blind to a substrate mismatch as the passing run beside it. See item 8's **Substrate direction**.
     - **Right inputs (mt#3579) [tier: prose].** Prose is not the fallback here: whether a test covers a defect CLASS is not statically decidable, so no matcher can answer it and no deterministic mechanism is being deferred. The value is the question being asked beside the artifact it qualifies. It proves the test can fail for the ONE case you reverted. It establishes nothing about coverage of the defect CLASS. Before moving on, name the class in one line and ask which other members of it your tests actually reach — this is the PREVENTIVE form of item 10's class-not-instance scan, applied where it is cheapest and most likely to be skipped, because a red-to-green transition feels like completion. (mt#3539 / PR #2531: the control reverted one oversized value and three tests went red — a genuine control, reported as such. The reviewer then found a case the tests never reached, where the bulk was many small fields and long key names rather than one big value; writing THAT regression surfaced a SECOND defect, envelope overhead, inside the same class the control appeared to cover.)

     - **Right revert (mt#4512) [tier: prose].** Same reason as the bullet above — whether a revert restored the full pre-fix state depends on which lines constitute "the fix," which only the author knows, so no matcher can answer it. **The CONTROL is itself an artifact, and it can be built wrong exactly the way the test can.** A control that does NOT fire is two hypotheses, not one: the test is inert, or the control is unfaithful — and the passing run cannot tell them apart. Reverting only the line you believe is load-bearing leaves a system that is neither pre-fix nor post-fix, and another code path may independently produce the correct behaviour. **Restore the FULL pre-fix state before concluding the test is at fault.** (mt#4502: a control that moved one line passed, because the very method being reordered ALSO reset the counter the assertion read; the full revert then failed correctly and exposed a genuinely inert test underneath it. Two artifacts wrong, one masking the other.)

     The three are independent. mt#3539's control ran in the real runtime against the real code and satisfied the substrate axis completely, and was still blind on the class axis; mt#4502's ran against the right system with the right inputs and was simply not a revert of the whole fix.

     **Why this is not redundant with (b).** (b) asks whether the test RAN; this asks whether it could have FAILED. A test written after the fix and shaped to it passes either way, so a passing run is compatible with the test having been incapable of failing (mem#704: a probe that returns the same result when the system is broken is not verification). Originating incident: three defects shipped in one session (mt#3228 / mt#3234 / mt#3238), each with a test written after the fix, every gate green — one test asserted the bug itself as the correct invariant and was reviewer-APPROVED.

   Origin: mt#2524 (2026-06-19) hit three sequential reactive merge blocks in one session — placeholder assertions, then execution-evidence-missing, then a heading without the colon — each fixed in its own round. mt#2525 (2026-06-21) recurred on the missing \`Execution evidence:\` block at merge. Front-loading removes the reactive rounds. Gates: mt#1459 (\`Execution evidence:\` merge gate, newly-added test files), mt#1460 (/prepare-pr §1b sibling, also newly-created only), mt#1938 (Prevent-Placeholder-Tests CI check, repo-wide grep), mt#3033 (per-AT cross-reference, calibration-first).

8. **Production-wiring + real-binding verification (mt#2508, third direction mt#3574).** Three directions, all required whenever the PR's success criteria include "every X has Y" / "writers set Z on insert" / "mechanism M is wired" claims, OR the diff adds/modifies a testable-factory module (injectable IO deps + a real-wired export):

   - **Caller direction (memory \`dcc77564\`, R1/R2).** Grep the production callsites / construction path and confirm they actually invoke the helper / supply the config. Helper unit tests, CLI flags, and MCP read-commands are NOT production-wiring evidence. Scope "production" to the mechanism's REAL construction/invocation path — factories, DI wiring, the state-transition sites the criterion names; a feature whose only legitimate consumers are batch jobs or offline scripts satisfies the check through THOSE paths (don't reject non-request-path consumers as "not production"). (R1 mt#1071: \`buildAttentionCost\` shipped with 20 passing hermetic tests and ZERO callers at the production ask-close sites its criterion named; R2 mt#2416: the \`currentProjectId\` stamping mechanism shipped but \`createConfiguredTaskService\` never passed it — 18/18 acceptance tests green, inserts stamped NULL.)
   - **Binding direction (memory \`78a6043e\`, R3).** Seam-injected unit tests are NOT evidence for the real-wired BINDING of the seam. Exercise the real-wired export once against the live dependency — a \`scripts/verify-*.ts\` smoke per §7a, or an executed acceptance check — before the PR ships, and paste the output under \`## Live verification\` (or, when a pre-merge live run is genuinely impossible, record the documented override per §7a's "What goes in the PR body" — "I read the code carefully" is not a valid override). Extra red flag when the binding's error handling is fail-open (\`catch → default/empty\`): a never-worked binding is then indistinguishable from "no data" at every downstream surface. (R3 mt#2076 → mt#2757: the reviewer-widget DB layer threw \`NOT_TAGGED_CALL\` on every query for ~5 weeks while rendering healthy zeros, and THREE follow-on features shipped on top of the dead binding — each seam-tested, each reviewer-APPROVED.)
   - **Substrate direction (mt#3574, R4) [tier: prose].** Evidence gathered in a SUBSTITUTE runtime validates the LOGIC, not its REACHABILITY in the real one. When the acceptance criterion depends on a runtime your test environment only approximates — a different browser engine, a different webview, a mocked driver, a local emulator standing in for hosted infra — either exercise the REAL runtime, or label the claim \`UNVERIFIED\` and name the substitution. The discriminating question: **"could the real runtime fail in a way my test environment structurally cannot exhibit?"** If yes, the evidence is silent on that failure mode no matter how rigorous it looks. Note this survives a negative control: a control proves your probe CAN fail, never that it is observing the right system. (R4 mt#3535 → mt#3570: a tray mouse-navigation feature shipped with an execution-evidence block AND a negative control — handler present navigates, handler absent does not — both run in Chromium because that is where JS could be executed. The real webview was WKWebView, which never delivers the event the handler listened for (tauri#10936), so the merged code was unreachable. Chromium delivers it, so no control run there could ever have surfaced the gap.)

     **Taking the label branch requires a REASON, and "I did not try" is not one (mt#2421).** Read the rule above literally and it offers a choice: exercise the real runtime, OR label the claim \`UNVERIFIED\`. Both branches satisfy it, so the cheap one discharges the obligation — which is exactly how mt#3810 shipped fully compliant and still left the principal unable to see their own fix. The agent wrote an accurate, specific UNVERIFIED note for a cockpit render surface that was one headless-browser launch away; producing the evidence, once actually asked for, cost about six tool calls. The label branch exists for the genuinely-unreachable runtime — the R4 tray case, where WKWebView could not be driven from the agent's context at all. A runtime you did not attempt is not a substitution; it is a skipped step. State WHY it was not exercised, in the same sentence as the label. This mirrors §7a's existing "What goes in the PR body" discipline, where \`"I read the code carefully"\` is already named an invalid override — the same closure was simply missing on this branch.

     **For a user-facing surface, the evidence the principal actually needs is a LINK.** Every artifact mt#3810 produced pointed inward — test output, a bundle grep, an API response — for a defect the principal had reported by pasting a screenshot. Nothing required handing them something to open, so nothing was. For a render-path change, put a URL (deployed or localhost) or a screenshot in the PR body; the mt#2421 calibration surface in \`require-execution-evidence-before-merge.ts\` looks for exactly that and WARNs when it is absent. Treat it as part of the deliverable, not a courtesy.

**Reactive phase (when iterating on reviewer findings):**

9. **Anti-rationalization.** When responding to a reviewer comment: did you change behavior, or did you just add a doc comment justifying the existing behavior? Documentation alone does not count as a fix. Verify the fix aligns with the _parent task's_ design intent (read the parent spec, not just the immediate ticket's text). Common failure mode: reviewer says "this default is wrong"; implementer adds a JSDoc explaining why the default is OK; reviewer flags it again because the value didn't change.

10. **Class-not-instance.** When the reviewer flags one specific site (e.g., "\`glob\` is unwrapped"), scan the implementation for other sites of the _same class_ (e.g., other unwrapped I/O like \`fs.readFile\`) and patch them all in one round. The reviewer-bot does cross-cutting audits; matching the comprehensive scan up-front is what converges iteration.

    The PREVENTIVE form of this scan is item 7(e)'s **Right inputs** bullet: asking the class question while authoring a negative control is cheaper than being handed one site by the reviewer and discovering the rest yourself. This item is the reactive half; that one is where the same question costs nothing.

Origin: cascaded reviewer iteration on mt#1258 (PR #796 abandoned across 3+ rounds) and mt#1350 (PR #847, 5 reviewer rounds), plus mt#1811 (PR #1100 deferred-without-probing) for the probe-before-defer step. See \`feedback_cascade_defense_in_implementer_prompt.md\` and \`feedback_probe_before_defer_at_action_time\` for the pattern history.

### 7a. Ship verification artifact for structural changes (when in scope)

**Decision rule — is this change structural?**

A change is structural if its correctness depends on live external behavior that no unit test can fully verify. Examples:

- New persistence backend path (new DB provider, new table layout, schema migration semantics)
- New model-output channel (output tools, structured-output schema, new tool call format)
- New external-system probe (health check against a live API, feature-flag read from a hosted store)
- New deploy-target wiring (Railway service, container start-up, environment variable resolution)
- Schema migration with semantic changes (not additive-only column adds)
- **New external-system integration** (new GitHub App permission/API scope, a new outbound
  credentialed endpoint, a new webhook subscription) — see the dedicated subsection below;
  this class has an ADDITIONAL requirement beyond shipping an artifact (the artifact must be
  capable of exercising the LIVE integration surface, not just a code-level check)

Counter-examples (NOT structural — no artifact needed):

- Pure-function changes with full behavioral test coverage
- Refactors that preserve API surface verified by existing tests
- Adding or updating tests
- Docs-only or config-only changes
- Single-file logic fixes where no external system is involved

**Requirement when structural.** The PR must also ship a verification artifact alongside the code change:

- A smoke script, replay script, e2e probe, or equivalent
- Place under \`services/<service>/scripts/\` or repo-wide \`scripts/\` if there is no service subdirectory
- The artifact must:
  - Be runnable from the command line (\`bun scripts/smoke-<feature>.ts\`, \`./scripts/verify-<feature>.sh\`, etc.)
  - Gate on required env vars (\`OPENAI_API_KEY\`, \`GITHUB_TOKEN\`, \`DATABASE_URL\`, etc.) — skip gracefully (exit 0 with a clear "SKIP: env var not set" message) when env is absent
  - Emit pass/fail with exit code (0 = pass, non-zero = fail)
  - Produce structured output: stdout JSON or a results file at e.g. \`scripts/<purpose>-results.json\`

**Dual-mode / branch-gated scripts (mt#2776) — exercise EACH production branch, not just the safe one.** When the artifact (or any script this PR adds) has mutually-exclusive modes gated by a flag — \`--dry-run\` vs \`--execute\`, \`--check\` vs \`--apply\`, or any \`if (flag) { … }\` branch that only runs in one mode — the live verification MUST exercise EACH branch that runs in production. Running only the SAFE branch (e.g. the dry-run) never executes the other branch's code — its imports, its logic — so a failure there ships unseen. For a DESTRUCTIVE branch, use a BOUNDED invocation (a single item, \`--limit 1\`, a scratch target) so the branch's imports and logic actually run without the full blast radius. "Typecheck + dry-run passed" is NOT evidence the \`--execute\` path works: it is a different code path, and runtime module resolution (bun package-\`exports\`) can reject a dynamic import that tsconfig \`paths\` typechecked clean. Paste the bounded per-branch output alongside the dry-run output in the PR body.

Origin: mt#2760 / mt#2774 (2026-07-14) — \`scripts/backfill-close-stale-asks.ts\` shipped with a \`--execute\` branch importing the unresolvable \`@minsky/domain/ask\` barrel; §7a verification ran only the dry-run (never enters \`if (execute)\`), so the broken import merged and failed the first time the operator ran \`--execute\` (0 asks mutated). A bounded \`--execute\` (single item) pre-merge would have caught it. The structural backstop — the mt#1459 execution-evidence merge gate now also fires on newly-added \`scripts/*.ts\` (mt#2776) — is the enforcement pair to this discipline.

**Live-verification gap pattern.** Subagents typically lack the env vars needed for live execution. The documented pattern is:

1. Subagent ships the artifact in the PR (code + script, but no live output).
2. Main agent (or human operator) runs the live verification after the PR is created, using env vars present in the main context.
3. The live-run output (redacted) is appended to the PR body under a "## Live verification" section.

This pattern was established by mt#1399 (smoke test for output-tools wiring — verified GPT-5 emits tool calls live) and mt#1403 (replay-verification script for cluster verification — verified 0/15 posted-body fires across the original leak corpus). Reference both when describing the verification gap to a reviewer.

**What goes in the PR body.** The PR description's "## Live verification" section must contain either:

- The redacted live-run output from running the artifact, OR
- A documented override: the artifact has not been run because (a) the target has not been deployed yet, (b) the author lacks live-target access per documented policy, or (c) the target has a rate-limit or maintenance-window constraint. "I read the code carefully" is not a valid override.

#### External-system integration changes: live-exercise required, not deploy-SUCCESS

When the task adds or alters an **external-system integration** — a new GitHub App
permission/API scope, a new outbound credentialed endpoint, or a new webhook subscription (the
same trigger class as \`/plan-task\` gate (n)) — deploy-SUCCESS is **necessary but NOT
sufficient** to claim the feature works. Per memory \`b73db534\`: "a deploy-touching change whose
acceptance criterion IS live behavior cannot be reported complete on unit-green + deploy-SUCCESS
while deferring the live exercise." \`deployment_wait-for-latest\` returning SUCCESS only proves
the container started — it does not prove the external precondition (the scope/permission/
credential) is actually granted and the integration call actually succeeds against the live
external system.

**The un-runnable-pre-merge case is UNVERIFIED, not "deferred/done."** A sealed secret, an
App permission not yet granted, or a target not yet deployed makes the live exercise
un-runnable AT PR-creation time — that is a legitimate reason to defer the RUN, but it is NOT a
reason to report the feature as working. State explicitly in the PR body's "## Live
verification" section: **"UNVERIFIED — live exercise deferred to §10 post-deploy because
<reason>. This integration is NOT confirmed working until the §10 live exercise runs and
succeeds."** Do not use language like "verification deferred" alone without the "UNVERIFIED"
label — a bare deferral note reads as a completed step to a skimming reader; it is not.

**Mandatory follow-through.** §10 (Post-merge deploy verification) below MUST, for this change
class, exercise the NAMED integration surface live — the actual API call, the actual webhook
delivery, the actual credentialed request — not just confirm deploy-SUCCESS. The task is not
"done" (in the working-feature sense, independent of the DONE status the at-merge handler sets)
until that live exercise runs and succeeds.

**Originating incident — mt#2435 (2026-07-10/11).** A reviewer-service change added a
\`checks:write\`-scoped \`octokit.rest.checks.create\` call. The PR merged green,
\`deployment_wait-for-latest\` returned SUCCESS, and the task was reported done — but the
\`checks:write\` permission had not actually been granted to the App yet (tracked separately as
mt#2500, still TODO). In production \`POST /check-runs\` returned 403 and \`publishCheckRun\`
degraded silently; the feature was inert for a day+ until a follow-up session (mt#2736) ran the
live check-run POST and the operator granted the permission. Had this subsection's discipline
applied at the time, the PR body would have read "UNVERIFIED — checks:write not yet granted
(mt#2500 TODO)," and §10 would have required the live \`POST /check-runs\` exercise before the
task could be considered functionally complete — surfacing the 403 immediately instead of a day
later.

**Enforcement tier (mt#2740 PR #1886 R1).** This subsection is verification **discipline**, not a
hook — process-enforced by this skill, at the same tier as the rest of §7/§10. Its hook-tier
sibling for the adjacent deploy-CRASH class is the mt#2353 deploy-verification merge gate +
post-merge reminder; the automated backstop for THIS (external-integration) class — recognizing
the trigger mechanically rather than relying on the agent, paired with \`/plan-task\` gate (n) — is
tracked in mt#2755.

### 8. Create PR (IN-PROGRESS → IN-REVIEW)

**This step owns the IN-PROGRESS → IN-REVIEW transition.**

Use \`mcp__minsky__session_pr_create\` to create the pull request:

- Title is description-only (no conventional commit prefix, no task ID)
- Body includes Summary, Key Changes, Testing sections
- The tool automatically rebases on main and sets task status to IN-REVIEW

### 9. Drive PR to convergence (IN-REVIEW → merge)

**After PR creation, the main agent owns the PR until convergence — do NOT stop, do NOT idle, do NOT end the turn with deferral language.** The user has delegated review to \`minsky-reviewer[bot]\`; the agent drives the PR to APPROVE (or to a documented bypass condition) and then merges. This step exists because the agent's default is to treat PR-creation as a hand-off; the corpus rules (\`feedback_user_does_not_review\`, \`decision-defaults.mdc §User does not review PRs in the loop\`) and the runtime hook \`.claude/hooks/drive-pr-to-convergence.ts\` all agree: convergence is the agent's job.

**Forbidden turn-closers** (each one re-creates the failure pattern mt#2056 fixed):

- "PR created. Ready for your review/merge."
- "Standing by for the reviewer bot."
- "Ping me when the review lands."
- "I'll wait for you to merge."
- Ending the turn at \`session_pr_create\` return without invoking the next mechanism.

These are forbidden as turn-CLOSERS, not as report content — a turn that legitimately reports
progress mid-convergence (e.g., after a fix-and-push round) should still follow the Tier-1
turn-report contract in \`communication-contract.mdc\` (what happened / what you need to know /
what's next), just without stopping there.

**Default mechanism: \`session_pr_wait-for-review\` with \`reviewer: "minsky-reviewer[bot]"\`.**

**Arming a watch instead, because you will do other work meanwhile? Pass \`session\` (mt#1593).** The default above BLOCKS, which is right when you intend to act on the review immediately. For the do-other-work case the mechanism is \`pr_watch_create\` — and it is deliverable ONLY if the create call carries \`session:\` (or \`sessionId:\`). \`extractSessionId\` (\`src/adapters/shared/commands/pr-watch.ts\`) reads exactly those two parameter names off the call itself; with neither present the watch stores a null \`parentSessionId\` and can never wake you. The miss IS recorded server-side — registration logs \`pr_watch.no_session_id\`, and an allowlisted drain that fails session resolution logs \`wake.enrichment.no_session_id\` — but neither reaches your tool results, so nothing tells YOU at the time. (The case that emits no telemetry at all is a next call OUTSIDE the allowlist, where \`shouldEnrichWake\`'s early return precedes the log.) (\`watcherId\` is a DIFFERENT field with its own \`operator:local:default\` fallback — a default \`watcherId\` is not what makes a wake undeliverable.) You are session-bound here, so unlike \`/plan-task\` the delivery conjunction IS satisfiable: \`session.pr.get\` and \`session.pr.list\` both sit on \`WAKE_ENRICHMENT_ALLOWLIST\` and both take a session argument. **Do NOT import \`/plan-task\`'s belt-and-braces poll mandate into this step** — it exists for a context where the first-party mechanism cannot deliver, and this is not that context. mt#1594 will return deliverability as a create-time fact, retiring this paragraph.

**One rule for \`expectedHeadSha\` (mt#4046): it is the head of whichever call LAST PUSHED.** Not "the sha \`session_commit\` returned" — that is the same thing only when \`session_commit\` was the last thing to push. TWO calls push, and each returns its own head:

| Wait | \`expectedHeadSha\` comes from |
| --- | --- |
| The FIRST, right after \`session_pr_create\` | that call's returned \`headSha\` |
| Every wait after a fix-and-push | that \`session_commit\`'s returned \`commitHash\` |

First wait (no \`since\` — picks up the first review on the PR):

\`\`\`
mcp__minsky__session_pr_wait-for-review(
  task: "mt#<id>",
  reviewer: "minsky-reviewer[bot]",
  expectedHeadSha: "<session_pr_create's headSha>"
)
\`\`\`

Subsequent waits (after pushing a fix) add \`since\`, so the call returns the NEW review rather than the stale CHANGES_REQUESTED one:

\`\`\`
mcp__minsky__session_pr_wait-for-review(
  task: "mt#<id>",
  reviewer: "minsky-reviewer[bot]",
  since: "<previous review.submittedAt>",      // e.g. "2026-05-23T16:59:27Z"
  expectedHeadSha: "<session_commit's commitHash>"
)
\`\`\`

**Why \`expectedHeadSha\` (mt#3877).** \`session_commit\` runs the full suite in pre-commit and routinely exceeds the 120s MCP tool timeout, at which point the harness BACKGROUNDS it — the call returns, and the push completes up to a minute later. Arming the watcher in that window gets you a review of the PREVIOUS head, re-reporting the findings your unpushed commit already fixed: one wasted round of reviewer tokens, ~9 minutes, and an agent turn spent deciding whether the bot self-reversed (observed on PR #2730, 2026-08-09, with 44 seconds between the review and the push).

\`requireCurrentHead: true\` does NOT protect you here, and the reason is worth internalizing rather than memorizing: at the moment you arm the watcher, the stale commit genuinely IS the remote's current head. The flag compares a review against the remote, never against your local intent, so it is satisfied by exactly the wrong thing. \`expectedHeadSha\` supplies the missing half — the commit you MEANT to be reviewed — and the wait polls on until the remote reaches it. Read the sha off the call that pushed it, per the table above; never construct or recall it.

**Why the table, and not just "\`session_commit\`'s \`commitHash\`" (mt#4046).** That was this section's wording for months, and it is correct for the round it describes and WRONG for the first wait, because \`session_pr_create\` runs a pre-PR session update and pushes a head of its own. Five sessions in five days armed the first watcher with the pre-creation sha, and each waited out its FULL timeout — 10 to 15 minutes — while a real review sat suppressed as \`push-not-landed\` (PR #2920, #2966, #2980, #3000, #3013). The failure is silent and reads exactly like reviewer silence, which is the documented lead-in to the bypass ladder, so the natural next move is bypassing an already-reviewed PR. Note the shape: those agents were following this text, not ignoring it — an instruction that is right in one case and wrong in another does not fail loudly, it fails as time. \`session_pr_create\` now returns \`headSha\` so the rule can be one sentence instead of a carve-out.

**When CI or the reviewer appears absent, read the PR's \`mergeable\` FIRST — ahead of any delivery-side probe (mt#4182).** Zero check-runs has two causes with OPPOSITE recoveries, and the PR object names which in one field: \`mergeable === false\` means conflicts, so GitHub never built \`refs/pull/N/merge\` and dispatched no \`pull_request\` workflow. The fix there is \`session_update\` + resolve; an empty-commit nudge does nothing except change HEAD and invalidate an existing approval. Only when merge state is clean is it a webhook miss. Probing the Actions API, GitHub's status page, or a comparison PR first narrows the DELIVERY side while the answer sits in the PR — see mem#537, whose R2 is exactly that mistake on PR #3031.

**Diagnosing it if you hit it anyway.** \`matched: false\` with a populated \`lastSeenReviews\` is this, not silence — read \`expectedHeadShaUnreached.lastObservedHeadSha\` and re-wait against THAT sha rather than waiting longer. When the wait outran the 120s tool cap and was backgrounded, its payload may never have been read; then the tell is \`forge_check_runs_list\` with the FULL sha — zero check runs on your sha and a normal count on the observed head means the remote never received yours.

**Do NOT block on \`pushed: true\` before arming the watcher — that is what \`expectedHeadSha\` is for.** Arm it immediately after \`session_commit\` returns, passing the sha; the wait absorbs the push lag by polling. \`pushed: true\` (or \`pushConfirmedVia\`) in the backgrounded commit's eventual notification is a DIAGNOSTIC you consult when something goes wrong, not a precondition you wait on first. Precedence, in one line: pass \`expectedHeadSha\` always; read \`pushed\` only if the wait times out with \`expectedHeadShaUnreached\`, which says the remote never served the sha you named rather than the reviewer being silent — and that has two causes with opposite remedies (a stuck push, which waiting fixes; a stale sha, which waiting never fixes). Check the commit and the observed head rather than waiting longer or bypassing.

**Diagnostic (mt#3877).** When a review re-reports findings you believe you just fixed, compare its \`commitId\` against your local HEAD BEFORE concluding the reviewer self-reversed. A stale-head review and a genuine self-reversal are indistinguishable from the findings alone, and only one of them is a bypass condition — mistaking the first for the second is how a wasted round turns into an unjustified bypass.

Block-and-return on the first review by the reviewer-bot. Then branch on the review state:

- **APPROVE** → call \`mcp__minsky__session_pr_merge\`. The standard merge path succeeds when the bot's review body satisfies the merge-gate text patterns (post-mt#2053: both \`## Spec verification\` and \`## Documentation impact\` sections are required and will be present in a well-formed APPROVE review). On success, the at-merge handler sets DONE atomically.
- **CHANGES_REQUESTED** → fix per the §7 Convergence Checklist (anti-rationalization: did you change behavior or just add a doc comment?; class-not-instance: scan for sibling sites of the same class and patch them all in one round). Commit, push, then re-invoke \`session_pr_wait-for-review\` with \`since\` set to the previous review's timestamp AND \`expectedHeadSha\` set to the commit you just pushed (see above — without it a backgrounded push costs you a guaranteed-stale round). Iterate until APPROVE.
- **COMMENT** → assess whether changes are required. If the bot is the same App identity as the PR author, GitHub blocks APPROVE — the bot posts COMMENT with a "would have approved" signal in the body. If the body indicates no outstanding BLOCKING/REQUEST_CHANGES findings, treat as approval-equivalent and proceed to the bot-authored merge path below. Otherwise treat the COMMENT findings the same as CHANGES_REQUESTED and iterate.

**Self-authored / bot-authored PR escape valves** (per \`feedback_self_authored_pr_merge_constraints\`).

When the PR is authored by \`minsky-ai[bot]\` or another identity that the reviewer-bot cannot APPROVE (GitHub self-approval block), the standard \`session_pr_merge\` path may need the bypass:

**Mandatory precondition: direct reviews-list read before citing silence (mt#2777 SC#2).** Before citing reviewer-silence as grounds for ANY \`bypassReason\` — even when a \`session_pr_wait-for-review\` call already timed out — perform a DIRECT reviews-list read on the PR's current HEAD (\`mcp__github__pull_request_read\` method \`get_reviews\`, or a fresh short-\`timeoutSeconds\` \`session_pr_wait-for-review\` call) immediately before invoking the bypass. A wait-for-review timeout alone is NOT sufficient evidence of silence — mt#2751's near-bypass timed out twice while a real review had landed mid-churn. (mt#2777 SC#1 now folds a fresh re-read into the timeout payload itself — \`finalCheckPerformed\` / \`reviewerCheckRunState\` — but the bypass-decision moment is a SEPARATE point in time from when the wait returned, so this direct read is required again, right before the bypass call, not inferred from an earlier timeout.) If the direct read finds a review on the current HEAD, the silence premise is false — refuse the bypass and process the found review instead.

**Numbered step: verify the condition against its definition before invoking any bypass (mt#2777 SC#2).** Before calling either bypass path below, name which ONE of the four documented conditions is firing and verify it against its precise definition — do not invoke the bypass on a name-level match alone:

1. **Self-reversal** — round N's BLOCKING finding contradicts an earlier round's ACCEPTED fix ON THE SAME ARTIFACT STATE. The reviewer re-reviewing DIFFERENT commit states the agent itself created (e.g. an add-then-revert churn across rounds) is NOT self-reversal — each round reviewed genuinely different code, so there is no contradiction to resolve by bypassing.
2. **CoT-leakage** — the reviewer emitted raw reasoning / chain-of-thought prose instead of structured findings, on the SAME HEAD, at least twice consecutively.
3. **Webhook-silence** — the reviewer has been absent for >5 minutes AFTER completing the full diagnosis ladder, which now INCLUDES the direct reviews-list read above (per \`feedback_self_authored_pr_merge_constraints\` step 5: service health / webhook miss / CoT-leakage stall).
4. **Verified-false-positive** — the cited code, when actually re-read, does NOT contain the claimed defect. An out-of-diff, pre-existing, but FACTUALLY TRUE finding is NOT a false positive — surface and file it (per mt#1882) rather than bypassing.

If the named condition, once checked against its definition, does not actually hold, the bypass is refused — continue waiting, fix the finding, or escalate instead.

**Retrigger ONCE before escalating a verified false positive (mt#3729).** Reviewer verdicts are non-deterministic: a finding you have correctly verified as false may simply not reappear on a re-review of the SAME commit — and when it doesn't, the bypass, the \`authorization.approve\` Ask, and the operator-approved D8 grant were all avoidable. So once condition 4 holds, and before invoking ANY override path, call \`mcp__minsky__reviewer_retrigger\` and re-wait with \`since\` set to the prior review's timestamp.

- **Cleared on re-review** → merge normally; no operator attention spent.
- **Same finding re-fires** → the disagreement is durable, not a flake. Escalate NOW, citing both review ids as evidence.

**Exactly once** — a second identical finding is the signal to escalate, not to retrigger again. This does NOT weaken \`merge-coordination\` §7b (which forbids a *blind* retrigger that discards an unread verdict's prose): this rung fires strictly after the review has been read and the finding verified false, so nothing diagnostic is thrown away. Full rationale, worked counter-example (mt#2921, where the re-fire made escalation correct), and the originating incident (PR #2640 — a false "generated file edited directly" finding paged the principal at 21:50; a retrigger returned APPROVED ~2 minutes later): \`merge-coordination\` §8a and memory \`8b40f396\` CORRECTION 3.

- **Preferred audited bypass (in-band, mt#2215):** \`session_pr_merge(task: "mt#<id>", forceBypass: true, bypassReason: "<evidence>")\`. This is the in-band replacement for the raw \`gh api PUT\` below — no hand-run CLI. It requires a non-empty \`bypassReason\` and a present (non-DISMISSED) \`CHANGES_REQUESTED\` review (the false-positive / self-reversal / leakage-stale case; for a review that EXISTS but is stale against HEAD, \`acceptStaleReviewerSilence\`), refuses on failing status checks or other merge blockers, auto-dismisses the blocking review using \`bypassReason\`, writes the canonical audit signature into the merge-commit body, always uses \`merge_method=merge\`, and triggers Minsky session cleanup. Use this when the conditions in the next bullet hold.
- **Fallback — raw bypass via \`gh api PUT /repos/<owner>/<repo>/pulls/<N>/merge -f merge_method=merge\`** (only when the in-band \`forceBypass\` path is unavailable) when ALL of these hold:
  - **R ≥ 1 substantive review rounds** have completed (the bot saw the code at least once). **This is a hard floor on BOTH bypass paths, and at R = 0 there is no bypass at all — see the zero-review case below. It is not an oversight to widen.**
  - AND any one of: (a) reviewer-bot fired CoT-leakage errors twice consecutively on the same HEAD (per \`feedback_reviewer_bot_cot_leakage_forces_bypass\`); OR (b) round-N self-reversal — round N's BLOCKING contradicts an earlier round's accepted fix (per \`feedback_reviewer_bot_self_reversal_is_bypass_signal\`); OR (c) reviewer-bot silent for >5 minutes after diagnosing the silence per \`feedback_self_authored_pr_merge_constraints\` step 5 (service health / webhook miss / CoT-leakage stall).
  - AND \`merge_method=merge\` (not squash — \`.claude/hooks/block-git-gh-cli.ts\` enforces this; \`docs/pr-workflow.md §Merge method policy\`).
- **Pre-bypass discipline:** verify CI fired and passed on the current HEAD before invoking the bypass (per \`feedback_verify_ci_fired_before_bypass_merge\`). A green commit that never triggered CI is a webhook-miss waiting to land broken.
- Both bypass paths' merge-commit body MUST contain the canonical audit-trail signature \`"Bot self-approval bypass per feedback_self_authored_pr_merge_constraints"\` plus the diagnostic context (which rounds, the error class, CI status, scope summary, fix-commit references). The in-band \`forceBypass\` path writes this automatically from \`bypassReason\`; the raw \`gh api PUT\` path requires it in the \`commit_message\`. The \`/verify-task\` skill's bypass-merge closeout depends on this signature.

**On any escape-valve activation, surface the merge to the user with a one-line note naming the condition that fired**, then proceed with the bypass — do not stop and wait for permission. The user has pre-authorized the bypass for the documented conditions.

**ZERO reviews is not a bypass case — it is where the ladder ENDS (mt#4266).** If the reviewer never posted anything, every bypass above is unavailable, and that is by design rather than by omission:

- \`session_pr_merge(acceptStaleReviewerSilence: true)\` refuses with \`"No review on PR #<n>. Ensure the reviewer bot posts a review before merging."\` — that flag covers a review that EXISTS but predates HEAD, not an absent one.
- The raw \`gh api PUT\` fallback fails its own stated floor: R ≥ 1 substantive rounds.

**Do not read this as a gap to route around.** Per the position paper *"The reviewer is a control loop, not an approver"*: the bypass closes a **deadlock** — the loop ran, produced findings, and cannot reach APPROVE because of the platform's self-approval block. It is explicitly *"a mistake to read the bypass as a workaround for the bot's flakiness"*, and a reviewer that errored before posting is exactly that flakiness. At R = 0 there is no Chinese-wall check at all, and you authored the PR.

**So when you reach here with zero reviews, the ladder is finished. Do this, in order, and then STOP:**

1. **Confirm it is genuinely zero** — a direct \`get_reviews\` read on the current HEAD, not an inference from a wait timing out.
2. **Retrigger once** (\`reviewer_retrigger\`), and if the bot's own status comment names a retry (e.g. \`Use /review to retry\`), post that too — it is a different delivery path than the direct endpoint.
3. **Diagnose the reviewer, not the merge.** Read its \`/health\` body and \`inflightCount\`; a saturated service is queue-shaped and needs waiting, a failed one is not. Record the occurrence on **mt#1697**, and check **mt#1897** — the \`openai.chat.completions.create.toolloop\` 120s timeout is a known recurring cause with confirmed log evidence.
4. **Leave the PR unmerged and say so.** This is the correct terminal state, and it is precedent, not improvisation: on 2026-08-18 five PRs hit this in one day (#3095, #3098, #3100, #3103, #3108) and every one was left unmerged. Report the PR, the diagnosis, and that it is waiting on the reviewer — do not spend further turns re-waiting.

**Subagent carve-out.** Subagents STOP at §8 (Create PR). Convergence-driving is the **main agent's** responsibility. \`.claude/hooks/block-subagent-bypass-merge.ts\` structurally enforces this for the \`gh api PUT /merge\` sub-case by detecting non-empty \`agent_id\` on the tool input and denying the call. Subagents must report the PR URL + bot-review status back to the parent and exit; the main agent then drives convergence per this step.

**Post-merge:** §10 (Post-merge deploy verification) takes over when the merged PR touches a deployed service. Otherwise the at-merge handler sets DONE and the lifecycle is complete.

**Completion-claim format (mt#2924).** For build/install deliverables (a CLI or the cockpit-tray app the principal must rebuild/reinstall) and deploy-surface deliverables (§10's deploy surface), report the completion claim in the claim-confidence format — \`[delivery state] — [evidential warrant + basis]\` — per \`.minsky/rules/claim-confidence.mdc\`. Bind that rule's Axis A class-conditional lattice: **auto-usable** deliverables (a running service that picks up the merge; config takes effect on deploy) may claim \`usable\` once \`deployed\`. **Build/install** deliverables (cockpit-tray, CLI) must name the remaining principal-side step and must NOT claim \`usable\` without a **verified-1b** (live-probe) basis — a merge or a healthy deploy alone is not evidence of \`usable\` for this class.

Worked example (the mt#2528 class — merged but not yet usable):

> Merged (verified-1a: PR merged this turn) — to reach usable: rebuild + tray reinstall.

When §9/§10 touches shared/prod state, the claim-confidence rule's risk-and-evidence ledger may also apply — see \`.minsky/rules/claim-confidence.mdc §The risk-and-evidence ledger\` for the trigger and mechanics (not restated here).

**Cross-references:**

- \`CLAUDE.md §Drive-PR-To-Convergence Reminder\` — the runtime hook this step's discipline aligns with.
- \`feedback_user_does_not_review\` — the parent rule (id \`b22fa663\`).
- \`feedback_drive_pr_to_convergence_dont_end_on_ping_me\` — sibling rule on deferral language.
- \`feedback_self_authored_pr_merge_constraints\` — bypass-merge mechanics + diagnostic ladder.
- \`feedback_reviewer_bot_cot_leakage_forces_bypass\` (id \`af0b6aac\`) — escape-valve trigger (a).
- \`feedback_reviewer_bot_self_reversal_is_bypass_signal\` (id \`06aebe02\`) — escape-valve trigger (b).
- \`feedback_verify_ci_fired_before_bypass_merge\` — pre-bypass CI discipline.
- \`decision-defaults.mdc §User does not review PRs in the loop\` — corpus rule.

### 10. Post-merge deploy verification (when the task touches a deployed service)

When the merged PR changes anything that affects WHAT gets deployed or HOW, do
NOT stop at merge. The merge triggers an auto-deploy on Railway (or whatever
platform the service declares); that deploy can fail in ways no pre-merge check
catches — Dockerfile breakage, missing env var, config-as-code resolution
error, schema migration error, container crash on start.

**Which changes those are is not something to recall — run the predicate
(mt#4269).** The deploy surface is defined in exactly one place,
\`packages/domain/src/deployment/deploy-surface.ts\`, and it is WIDER than deploy
config: it covers application SOURCE and the manifests whose merge actually
triggers a service deploy, not just the platform's own config files. The
mt#2353 hooks, the post-merge deploy watch, and this step all read that module,
so it is the only thing your claim has to agree with. Ask it directly, over the
files this PR actually changed:

\`\`\`
bun -e 'import { isDeploySurfaceFile } from "./packages/domain/src/deployment/deploy-surface.ts";
for (const f of process.argv.slice(1)) console.log(isDeploySurfaceFile(f), f);' src/cockpit/routes/context-inspector.ts packages/domain/src/deployment/deploy-surface.ts
\`\`\`

Swap the two example paths for this PR's actual changed files, passed as plain
arguments. Do NOT substitute a \`<placeholder>\` for them: the shell reads \`<\` as
input redirection, so the line dies as a syntax error before bun ever runs. Get
the file list from \`git_diff\` or \`session_pr_get\` — \`block-git-gh-cli.ts\` denies
the \`git\` CLI, so a \`git diff --name-only\` substitution is not available here.

The slice is \`1\`, not \`2\`, and that is worth not "correcting": \`bun -e\` passes
no script path, so \`process.argv\` is \`[<bun>, ...yourFiles]\` — measured, not
assumed. Slicing at \`2\` drops the FIRST file silently, which for this particular
check is the worst available failure: a deploy-surface file vanishes from the
output and \`[no-deploy-impact]\` looks confirmed.

**This binds hardest on \`[no-deploy-impact]\`.** That tag asserts the predicate
returns false for EVERY changed file, so run it over the diff before you write
the tag — in the PR body and in each commit message, since a pushed commit
message cannot be edited afterward. A pattern list you remember is not evidence
about the pattern set that ships: this paragraph replaced one, and that list had
been stale through two successive widenings while reading as authoritative.
Two PRs wrote a false \`[no-deploy-impact]\` by applying it faithfully (#3104,
#3148) — in the second, the claim reached four commit messages and is permanent
in history there.

**Verifying the post-merge deploy is MANDATORY before you report the task done**
— not a discretionary follow-up. Two hooks enforce it (mt#2353): the PreToolUse
gate \`require-deploy-verification-before-merge.ts\` blocks the merge of a
deploy-surface PR unless its body carries a \`Deploy verification:\` commitment, and
the PostToolUse \`deploy-verification-after-merge.ts\` injects a reminder on the
merge turn. A \`Deploy verification:\` section that merely DEFERS ("will verify
later" / "deferred to §10 because not-yet-deployed") is NOT evidence — the
verification must actually run, here, after the deploy completes.

**Primary mechanism: \`mcp__minsky__deployment_wait-for-latest\`.**

\`\`\`
deployment_wait-for-latest(service?: string, timeoutSeconds?: number, notBefore?: string)
\`\`\`

Block-and-return on the latest deployment for the configured service.
Returns the terminal \`DeploymentRecord\` (SUCCESS / FAILED / CANCELLED /
CRASHED). Platform-neutral; the tool routes to the platform declared in
\`services/<svc>/deploy.config.ts\` (Railway is the v1 concrete adapter; v2
candidates: Vercel, Cloudflare Pages, etc.). See
\`docs/deployment-platforms.md\` for the abstraction.

**ALWAYS pass \`notBefore\` — the merge's timestamp (mt#3890).** Without it,
this call returns whatever deployment is newest, with no relationship to the
merge you are verifying. That is not a theoretical weakness: from 2026-08-05
to 2026-08-10 the \`minsky-mcp\` redeploy step was silently unauthorized, no
deployment was ever created, and this call dutifully returned the four-day-old
SUCCESS record to every post-merge gate that asked. Every one of them passed.
A probe that returns the same answer whether or not the deploy happened is not
verification (mem#704).

The timestamp is \`mergeInfo.mergeDate\` from the \`session_pr_merge\` you just
ran. With it, a deployment predating the merge no longer satisfies the wait —
the call raises \`NoDeploymentSinceError\`, which means "nothing was ever
triggered," NOT "it is still building." Those call for opposite responses: go
find out why the deploy did not fire, rather than waiting longer.

\`session.pr.drive --postMerge\` takes the same value as \`mergedAt\` and threads
it to every watched service. If you omit it there, the result carries
\`deployBoundApplied: false\` and the text output says so — treat that as an
unverified deploy, not a passing one.

**\`notBefore\` is necessary and NOT sufficient — pass \`expectCommitSha\` too, and
READ the verdict (mt#4583).** The bound above filters on the deployment's
creation TIME, and time does not identify WHICH change deployed. On a busy main
branch a NEIGHBOURING merge's deployment lands inside your window and satisfies
the bound: observed 2026-08-25, when a deployment created **ten seconds** after
a merge returned SUCCESS and belonged to the PREVIOUS merge's workflow run. The
tell was arithmetic — ten seconds cannot build a Docker image — and the falsifier
was a schema query showing the migration had not run. Passing \`notBefore\` did
not prevent any of it.

So pass BOTH, and read \`buildIdentity\` on the result:

- **\`confirmed\`** — the deployment names your commit. This is the only value
  that licenses "my change is deployed."
- **\`mismatch\`** — it names a DIFFERENT commit. A deploy happened; it was not
  yours. Do not wait for this one to change: go find your own.
- **\`indeterminate\`** — the record cannot answer. Expected for an image-source
  service (Railway deploys a pushed image and never sees the commit, so
  \`commitHash\` is null by construction). **This is not a pass.** Fall through to
  the two checks below.

\`session.pr.drive --postMerge\` takes \`mergedCommitSha\` alongside \`mergedAt\` and
reports \`buildIdentity\` per service — services deploy independently, so one can
carry your merge while another still serves a neighbour's build.

**When identity is \`indeterminate\`, escalate to a channel that CAN answer:**

1. **Correlate the workflow run to your merge SHA** —
   \`forge_ci_run_list --workflow deploy-<svc>.yml\`, match \`head_sha\` against the
   merge commit, and require \`conclusion: success\` on THAT run. This is what
   proved the 2026-08-25 deploy had not happened yet.
2. **Assert something the CHANGE produces, not something the DEPLOY produces** —
   the migrated column present in \`information_schema\`, the new route
   responding, the new field in a payload. This is the strongest check available
   and the one that actually settled the incident: it is immune to which
   deployment record the wait happened to return.

**Follow-ups for inspection (not for waiting):**

- \`mcp__minsky__deployment_status(service?)\` — snapshot of the latest
  deployment without blocking. Useful for "is something already running?"
  checks.
- \`mcp__minsky__deployment_logs(deploymentId, type?, lines?, service?)\` —
  fetch build (\`type: "build"\`) or runtime (\`type: "deploy"\`) logs for a
  specific deployment. Block-and-return; streaming is out of scope for v1
  (see mt#1725 for the notification path).

**Anti-patterns to avoid:**

- Polling the application's HTTP endpoint in a Bash loop. Correctness-by-
  eventual-consistency; no failure signal until timeout.
- \`ScheduleWakeup\` with a guessed interval. Latency model is wrong by
  default (see \`feedback_reviewer_bot_actual_latency_calibration_data\`
  for the sibling lesson on reviewer-bot timing).
- Shelling out to \`railway logs --build\` from Bash. The MCP tool wraps the
  same underlying Railway GraphQL; the platform-neutral surface keeps the
  agent's reach platform-aware without memorizing CLI flags.

**When the deploy fails:** call \`deployment_logs(deploymentId, type: "build")\`
on the failed deployment ID, inspect the failure, and either fix-forward
in a new PR or surface to the user with the logs attached.

#### External-system integration live-exercise (mandatory, distinct from deploy-health)

The mechanism above (\`deployment_wait-for-latest\` → SUCCESS, \`/health\` 200) verifies the
**deploy-CRASH** class: did the container start? For a task that added or altered an
**external-system integration** — a new GitHub App permission/API scope, a new outbound
credentialed endpoint, or a new webhook subscription (per \`/plan-task\` gate (n) and §7a's
matching subsection) — deploy-SUCCESS is a DIFFERENT, WEAKER signal than "the feature works."
Per memory \`b73db534\`: \`deployment_wait-for-latest\` returning SUCCESS is **necessary but NOT
sufficient** — it proves the container booted, not that the external precondition is actually
provisioned and the integration call actually succeeds.

**Required action for this change class:** after \`deployment_wait-for-latest\` returns SUCCESS,
additionally EXERCISE the named integration surface LIVE — make the actual API call, trigger the
actual webhook, exchange the actual credential — and observe the real result (success payload,
or an error like a 403 that reveals a missing precondition). This is not optional and is not
satisfied by re-reading the code or re-confirming the deploy is healthy. If §7a's PR body
recorded the change as "UNVERIFIED — live exercise deferred to §10," THIS is the point where
that deferral is discharged: run it now, before reporting the task functionally complete.

**Originating incident — mt#2435 (2026-07-10/11).** The reviewer check-run integration deployed
SUCCESS and was reported done without a live \`POST /check-runs\` exercise. The 403 (missing
\`checks:write\`) was discovered a day later only because a separate follow-up session (mt#2736)
happened to run the live check. Under this subsection, the live check-run exercise is part of
§10 itself for this change class — the gap would have surfaced within the same session as the
deploy, not a day later via a separate task.

**When the live exercise fails** (e.g., a 403 revealing a missing App permission): this is the
exact signal gate (n) plan-time enumeration exists to prevent surfacing this late. Do not report
the task done. Surface the failure with the specific error, identify the missing precondition,
and either provision it now (if in scope and accessible) or escalate per \`decision-defaults.mdc
§Missing MCP tool — escalate, don't silently work around\` / \`User Preferences §Probe before
deferring\` — do not silently downgrade to "the deploy succeeded" as the completion claim.

**Four rules this step enforces (the mt#2345/mt#2435 incidents each violated a subset):**

1. **"Applied" is the ACTION, not the OUTCOME.** \`pulumi up\` exit-0, a 200 from a
   config API, or an apply call returning success means the change was
   _submitted_ — NOT that the service is healthy. A deploy-touching task is not
   done until \`deployment_wait-for-latest\` returns SUCCESS AND the runtime shows
   the service started (a \`/health\` 200 or \`deployment_logs(..., type: "deploy")\`
   showing the boot). Verify outcomes, not actions.

   **A 200 from /health is not by itself proof the RIGHT service started
   (mt#3148).** Every Minsky service is built from the same monorepo, so a
   misconfigured build can put a DIFFERENT application on the host — and it
   answers 200 exactly like the right one. mt#3142: the MCP server served the
   reviewer's host for ~1h while every reviewer route 404'd, and the status-code
   check stayed green throughout. Assert the health body's "service" field
   (minsky-cockpit / minsky-mcp / minsky-reviewer / minsky-site) via
   assertServiceIdentity() in
   packages/domain/src/deployment/health-identity.ts — not merely the status
   code. The general form: **a verification probe must be able to fail**; if the
   broken state produces the same output as the healthy one, the probe carries
   no information.
2. **A deploy-verification-tool flake is a BLOCKER, not a license to defer.** If
   \`deployment_wait-for-latest\` errors on auth / an MCP transport flake (e.g.
   Railway \`Unauthorized\`), reconnect (\`/mcp\`) and retry — do NOT downgrade to an
   "observational" / "will-watch-future-merges" completion claim. That exact
   downgrade left mt#2345's reviewer service crash-looping for ~30 min while the
   task was reported DONE.
3. **DONE being set ≠ deploy healthy.** The at-merge handler sets DONE atomically
   at merge, BEFORE the deploy completes, so this step does NOT change DONE status.
   DONE is necessary-but-not-sufficient; the deploy-health check above is the real
   completion signal for a deploy-touching task.
4. **Deploy-SUCCESS ≠ feature-works, for external-system integrations.** A healthy
   container proves the process started, not that a newly required App
   permission/scope/credential/webhook is provisioned and functioning. For this
   change class, the live-exercise requirement above is the real completion
   signal — not \`deployment_wait-for-latest\` alone. This is the rule mt#2435
   violated: deploy-SUCCESS was treated as sufficient evidence the check-run
   integration worked.

## Constraints

These constraints apply throughout implementation:

- **Session-scoped file tools only.** Every file operation in the session goes through \`session_read_file\` / \`session_search_replace\` / \`session_write_file\`, addressed by \`sessionId\` + a session-relative path. Do not reach for the harness-native \`Read\`/\`Edit\`/\`Write\` with an absolute session path: an absolute path can silently resolve against the main workspace, and a bare relative path certainly will.
- **Never edit main workspace.** All changes happen in the session. If a bug is found in the main project, create a separate task for it.
- **Never manually set DONE.** Task status flows: TODO → IN-PROGRESS → IN-REVIEW → DONE. DONE is only set after PR merge, never manually from a session.
- **No work without a session.** Implementation work requires an active session for isolation and traceability.
- **Never bypass the entry gate.** Calling \`session_start\` on a TODO or PLANNING task skips the planning phase and produces unplanned implementation work.
- **Structural changes require a verification artifact.** A fix whose correctness depends on live external behavior (new persistence path, new model-output channel, new external-system probe, new deploy-target wiring, schema migration) must ship alongside a smoke / replay / probe script under \`services/<service>/scripts/\` or \`scripts/\`. Subagents ship the artifact; live verification runs from main-agent context where env vars are present.

## Key principles

- **Spec defines scope.** Don't add features or refactor beyond what the spec asks for.
- **The entry gate protects quality.** A task that isn't READY has not been planned. Don't implement unplanned work.
- **Commit incrementally.** Don't save everything for one final commit.
- **Document findings in the spec.** Update the task spec with progress, decisions, and verification outcomes — never create separate summary files.

## Regression examples

**mt#1399 — output-tools wiring (smoke test pattern).** The PR wired GPT-5's output-tools channel. Correctness required live verification that the model emits tool calls in the new format. A smoke script was shipped in the same PR; the main agent ran it post-creation and appended the redacted output to the PR body. No unit test could have caught a misconfigured tool-call schema.

**mt#1403 — cluster verification (replay script pattern).** The PR shipped a content-routing cluster. Correctness required verifying that 0 of 15 items from the original posting-body leak corpus fired through the cluster. A replay-verification script was shipped in the same PR; the main agent ran it against the live corpus and appended a structured JSON results file to the PR body. No unit test covers the full corpus distribution.

Both are the canonical instances of the live-verification gap pattern: subagent ships the artifact, main agent runs it.

**mt#2435 — external-integration liveness gap (deploy-SUCCESS ≠ feature-works).** A reviewer-service change added a \`checks:write\`-scoped GitHub check-run POST. The PR merged green and \`deployment_wait-for-latest\` returned SUCCESS; the task was reported done. The App's \`checks:write\` permission had not actually been granted (tracked separately as mt#2500, still TODO at merge and never linked in the spec) — in production \`POST /check-runs\` returned 403 and degraded silently for a day+ until a follow-up session (mt#2736) ran a live check and the operator granted the permission. This is the canonical instance of the external-integration-liveness gap this task (mt#2740) closes: §7a/§10 now require the named integration surface to be exercised LIVE post-deploy for this change class, and \`/plan-task\` gate (n) requires the precondition to be enumerated and provisioned-or-linked before READY.
`,
});
