import { defineSkill } from "../../../packages/domain/src/definitions/factories";

export default defineSkill({
  name: "plan-task",
  description:
    "Drive a task through PLANNING to READY: investigate the spec, surface gaps, file subtasks, and run the gate check. Use when: 'investigate mt#X', 'plan mt#X', 'look into mt#X', \"what's the gap for mt#X\", 'bring mt#X to ready', 'research mt#X', 'analyze mt#X spec'. Does NOT create new tasks (use /create-task) and does NOT implement (use /implement-task).",
  userInvocable: true,
  content: `
# Plan Task

Drive an existing task from TODO through PLANNING to READY by investigating its spec, surfacing
gaps, filing any needed subtasks, and running the PLANNING → READY gate check.

## Arguments

Required: a task ID (e.g., \`/plan-task mt#915\` or \`investigate mt#915\`).

## Triggers

This skill auto-invokes on:

- "investigate mt#X"
- "plan mt#X"
- "look into mt#X"
- "what's the gap for mt#X"
- "bring mt#X to ready"
- "research mt#X"
- "analyze mt#X spec"

It does **not** trigger on task creation intents (use \`/create-task\`) or implementation
intents (use \`/implement-task\`).

## PLANNING lifecycle ownership

This skill owns the **TODO → PLANNING → READY** state arc. The first mechanical step is always
a status transition; everything else is investigation and gate-check.

## Process

- Step 1: Transition to PLANNING (idempotent)
- Step 2: Read and verify the spec
- Step 2.5: Premise audit (four checks — must run before the gate)
- Step 3: Run the PLANNING → READY gate check
  - (a) Required spec sections present
  - (b) Success criteria are testable
  - (c) Scope is bounded
  - (d) No blocking questions
  - (e) File:line references are fresh
  - (f) Subtasks filed for multi-phase work
  - (g) No parallel work in flight
  - (h) Contract-propagation enumeration
  - (j) Premise label verification (letter \`i\` intentionally skipped to avoid confusion
    with the Roman-numeral premise-audit labels \`(i)\`/\`(ii)\`/\`(iii)\`/\`(iv)\` used in Step 2.5)
  - (k) Third-party tool/dependency verification
  - (m) Factual-claim citation verification (letter \`l\` reserved for the
    security-surface community-practice check, mt#2090)
- Step 4: Act on gate results

### Step 1: Transition to PLANNING (idempotent)

1. Call \`mcp__minsky__tasks_status_get\` with the task ID to read the current status.
2. Branch on current status:
   - **TODO** → call \`mcp__minsky__tasks_status_set\` to transition to **PLANNING**.
   - **PLANNING** → already in the right state; proceed without re-transitioning.
   - **READY** → task is already gate-passed. Confirm with the user whether to re-investigate
     or stop. Default: stop and report it's READY.
   - **IN-PROGRESS / IN-REVIEW / DONE** → task is past the planning phase. Inform the user
     and stop — do not attempt to walk the status backward.
   - **BLOCKED** → surface the blocker, do not transition.

### Step 2: Read and verify the spec

1. Call \`mcp__minsky__tasks_spec_get\` to load the full task specification.
2. Check that the spec is substantive — not just a one-line title. If the spec is empty or
   only contains a title, that is itself a blocking gap (surface it now).
3. Note any file:line references and verify them against the current codebase (use
   \`mcp__minsky__session_exec\` or \`mcp__minsky__session_grep_search\` to confirm they exist
   and point to the right code).

### Step 2.5: Premise audit

Before running the spec-quality gate, answer all four checks below explicitly in your
planning output. **READY recommendations, closure recommendations, and new-task creation
calls are blocked until all four answers are stated.**

Each check is a separate sub-section in the output. Use the (i)/(ii)/(iii)/(iv) labels.

#### Premise check (i) — Open hypotheses

Does the parent investigation (or the spec being planned) explicitly leave premises open
that this task is treating as settled?

- Name any open premises the spec carries forward as if they were resolved facts.
- Identify what evidence or decision would resolve each open premise.
- Either gate the task on that resolution, or rescope to be premise-independent.

If no open premises exist, state that explicitly: "(i) No open premises identified."

#### Categorization check (ii) — Scope/label fit

Is the plan relying on a categorization (scope label, file pattern, tier, classifier
verdict) — and does that categorization actually fit the change's nature, or is it
inherited from a heuristic built for a different purpose?

- Name any categorization the plan depends on.
- Verify it was designed for this type of change (not just pattern-matched).
- If the categorization is suspect: file a separate task to fix the classifier rather than
  building on its bad output. Do not proceed on a categorization you cannot validate.

If no categorization is relied on, state that explicitly: "(ii) No inherited categorization relied on."

#### Parallel-work check (iii) — In-flight overlap

Before recommending closure, amendment, or new tasks: run \`mcp__minsky__tasks_search\`
with subsystem keywords from the task being planned. Surface any in-flight tasks that
touch the same files, subsystem, or problem class.

This check fires the moment the planning flow generates a closure, amendment, or new-task
recommendation — not only on the actual \`tasks_create\` call.

Report any overlapping tasks found. If none: "(iii) No overlapping in-flight tasks found."

#### Framing check (iv) — Symptom vs. structure

Before recommending implementation, ask: "Is this fixing a symptom of a deeper structural
issue?"

If a fix repeatedly recurs in the same area (sanitizer iteration #N, prompt iteration #N,
classifier patch #N), surface the structural reframe as a follow-up RFC even when shipping
the tactical patch.

**Socratic-premise sub-check.** When stuck on a tactical recommendation, decompose the
operation being patched into its constituent parts. Ask: "What are the actual sub-operations
of this thing? Are they being conflated?" Apply Socratic decomposition of the operation
being patched as part of this check — not just pattern-matching on cluster shape.

**Architecture-consistency sub-check (mt#1856).** When the spec proposes a **new
capability, abstraction, substrate, or module**, it must name one of: (a) **which
existing pattern it extends** — a sibling ADR's capability slot (e.g., an ADR-002
persistence-provider capability), an existing module's interface, an established
convention; OR (b) **explicit justification for a new pattern** — why the existing
pattern doesn't fit and what alternatives were rejected. A spec that introduces a new
structural element without naming the extend-vs-introduce choice fails this sub-check.
Originating incident (2026-05-15, mt#1852 / ADR-010): the substrate choice was framed
as novel without checking it against the existing \`project_supabase\` pattern, which
let "session vs transaction pool mode" and "pooled vs direct connection" collapse under
the salient phrase "no LISTEN/NOTIFY."

**Design-intent-assertion citation sub-check (mt#1676).** When the recommendation depends
on an **asserted claim about Minsky's design intent** — trigger phrases such as "X is part
of Minsky's design intent," "the right move per the strategic frame," "X is the role of
surface Y," "this surface is for A, not B," "the design trajectory is Z" — the gate requires
the agent to either (a) **cite a specific corpus source** (task ID, memory ID, Notion page
ID, ADR number, CLAUDE.md section), or (b) **explicitly disclaim it as a hypothesis** ("I'm
asserting this without evidence; treat as hypothesis"). If neither is present, the sub-check
fails — surface the gap before recommending the action. This is the _asserting_ direction
(agent invents a frame to justify a tactical preference); \`feedback_strategic_reframe_first\`
covers the _connecting_ direction (user's tactical ask → existing frame). Originating incident
(2026-05-08 hosted-MCP framing failure): the agent asserted "hosted MCP is the task-management
substrate, not a session-runner" with no evidence and against the actual corpus (mt#263,
mt#190, Progressive Adoption Model T4).

If no structural issue is suspected: "(iv) No recurring pattern identified; tactical fix is appropriate."

### Step 3: Run the PLANNING → READY gate check

Evaluate each criterion in order. A single **fail** halts promotion to READY; surface all
failures together so the user can address them in one pass.

#### Gate criterion (a) — Required spec sections present

The spec must have **all five** of the following top-level sections (exact heading text):

- \`## Summary\`
- \`## Success Criteria\`
- \`## Scope\`
- \`## Acceptance Tests\`
- \`## Context\`

Check each section's presence. Record any missing sections as blocking gaps.

#### Gate criterion (b) — Success criteria are testable

Each item under \`## Success Criteria\` must be independently verifiable by an agent or a
human reviewer. Reject criteria that:

- Use vague language ("should work correctly", "behaves as expected", "is improved")
- Cannot be checked by running a command, reading a file, or calling a tool
- Are aspirational rather than observable

For each weak criterion, write a concrete revision and surface it as a gap.

#### Gate criterion (c) — Scope is bounded

\`## Scope\` must contain explicit **In scope** and **Out of scope** (or equivalent) lists.
A scope section that only describes what is in scope (no out-of-scope list) is insufficient —
without an out-of-scope list, creep risk is unmanaged. Surface as a gap if missing.

#### Gate criterion (d) — No blocking questions

Look for any open questions in the spec or in the task's history that would prevent starting
implementation. Indicators:

- "TBD" or "TODO" items inside the spec text
- Unresolved design decisions ("[open question: …]" patterns)
- Dependencies on unmerged PRs or incomplete tasks (check status of listed deps)

If blocking questions exist, list them explicitly. They must be answered before READY.

#### Gate criterion (e) — File:line references are fresh

For every \`path/to/file.ts:N\` reference in the spec:

1. Verify the file exists in the current codebase.
2. Verify the referenced code (function, class, constant) is still present near line N (±10).
3. If a reference is stale, note the stale ref and the correct location (or note it was deleted).

If no file:line references exist in the spec, this criterion passes automatically.

#### Gate criterion (f) — Subtasks filed for multi-phase work

If the task spec describes work that spans multiple independent phases, components, or team
boundaries, confirm that child subtasks have been filed (check \`mcp__minsky__tasks_children\`).
If the parent has no children but the work clearly decomposes, surface "subtasks not yet filed"
as a blocking gap and propose the decomposition.

Single-phase tasks pass this criterion automatically.

#### Gate criterion (g) — No parallel work in flight

Before a task can be READY, verify no other in-flight work covers the same files, signatures,
or symptoms. Three required checks; **any hit is a blocking gap** until resolved (the user
chooses: wait, coordinate, reframe scope, or explicitly acknowledge).

Rationale: this gate operationalizes \`feedback_check_parallel_work_before_decomposing\`.
Three recurrences in three days proved memory-only enforcement insufficient (mt#1192/mt#1199,
mt#1068/mt#1240, mt#1261/mt#1281, plus the meta-incident: mt#1299 vs mt#1305 itself).

Run all three:

1. **Path/file-collision check** — for each file/path listed in the spec's
   \`## Scope\` → \`In scope\` section:

   - Call \`mcp__github__list_pull_requests\` with \`state: "open"\` and inspect titles/branches.
   - For high-suspicion matches, call \`mcp__github__pull_request_read\` with \`method: "get_diff"\`
     to confirm the PR actually touches the path.
   - Also check recent merges: \`mcp__minsky__git_log\` with the file path filter for the
     last 7 days — a fix that just landed on \`main\` is just as bad as one in flight.

2. **Signature search** — for the spec's signature phrases (specific identifier names,
   error message strings, env var names, migration slot numbers):

   - Call \`mcp__minsky__tasks_search\` with each phrase. Inspect any IN-REVIEW, IN-PROGRESS,
     or recently-DONE matches.
   - For bug tasks, also \`mcp__minsky__git_log\` with \`--grep=<phrase>\` against \`main\` for
     recently-merged commits.

3. **Parent/sibling enumeration** — if the task has a parent:

   - Walk \`mcp__minsky__tasks_parent\` then \`mcp__minsky__tasks_children\` to enumerate the
     full sibling/descendant set. **Fail closed (do not pass):** if \`tasks_children\` errors or
     returns a result you cannot trust (transient MCP failure), do NOT pass this criterion —
     retry, or record a blocking gap. A silent "no children" read is exactly how the
     duplicate-decomposition recurrences slipped through (mt#1423/1424/1425 duplicated DONE
     mt#1188/1189; mt#2403-2406 duplicated mt#2397/2398/2399).
   - For **each** child surface its \`(taskId, status, title)\` — **including children in a
     terminal status** (DONE / CLOSED / COMPLETED are all valid Minsky task statuses; see
     CLAUDE.md §Task Lifecycle), not just active/in-flight ones. A sibling that already SHIPPED
     or was closed-as-redundant is just as much a duplicate as one in flight; the time-windowed
     open-PR/recent-merge checks above do not catch a terminal-status sibling outside the
     window. Flag any child whose title shares **≥2 substantive tokens** (4+ char, non-stopword)
     with the task being planned.
   - For each related task ID, call \`mcp__minsky__session_pr_list\` with \`status: "open"\`
     and \`task: "mt#X"\`; surface any open PR.
   - **Hard reconciliation requirement:** any flagged title-overlap or already-shipped sibling
     MUST be reconciled before READY — subsume (close one, absorb its constraints), supersede,
     or confirm-orthogonal (state explicitly why the scopes don't actually overlap). Do NOT
     promote to READY with an unreconciled overlap.

   NOTE: this planning-time enumeration is the Tier-2 floor. It reads children at planning
   START; concurrent children filed in the gap before \`tasks_create\` are caught at the
   mutating action by the Tier-3 \`parallel-work-guard.ts\` \`tasks_create\` matcher (mt#1435).

If any check hits, surface findings as a blocking gap with task/PR IDs and the specific
overlap (file, phrase, or sibling). Do NOT promote to READY until the user resolves the
overlap.

If no check hits, this criterion passes.

#### Gate criterion (h) — Contract-propagation enumeration

When the task retires or modifies a contract — a function/type signature, skill text, command
name, env-var name, config key, or schema field — the spec's \`## Scope\` → \`In scope\` section
must explicitly enumerate the downstream consumers of that contract. A spec that names the
retired or changed artifact without listing who reads or depends on it is incomplete and must
not proceed to READY.

Rationale: four incidents on 2026-05-06/08 traced to exactly this gap. In each case the spec
correctly identified the artifact being changed but missed one or more consumer classes,
causing silent breakage after merge:

- **mt#1551** — retired the \`/verify-task\` audit gate without enumerating the skill files
  referencing it; caused idle-drift on PR #970.
- **mt#1086** — added required fields to \`ReviewerConfig\` without enumerating test fixtures;
  CI on main was broken for ~24 hours.
- **mt#1610 (doc-side)** — enumerated 25+ in-scope code sites but missed three documentation
  files (\`docs/configuration-guide.md\`, \`docs/repository-configuration.md\`,
  \`docs/github-issues-backend-guide.md\`).
- **mt#1610 (Railway env-var side)** — spec claimed "Sole consumer is \`~/.config/minsky/config.yaml\`"
  but the Railway-deployed \`minsky-mcp\` service was also a consumer with its own
  \`MINSKY_SESSIONDB_*\` env vars. Production crashed 2026-05-08T00:09Z; fixed via mt#1624 / PR #976.

This criterion encodes the escalation policy of the \`contract_propagation_at_design_time\`
memory (id \`513934fa-3000-4f67-8869-2d50598f484b\`): when a fourth instance surfaces, add
Gate criterion (h).

**Trigger condition.** This criterion fires when the spec describes any of:

- Retiring, renaming, or changing the signature of a function, type, interface, or class
- Renaming or retiring a skill, command, or CLI subcommand
- Renaming or retiring an env-var or config key
- Changing a schema field name, type, or required-status

If none of these apply, this criterion passes automatically. State that explicitly:
"(h) No contract modification — criterion passes."

**Consumer enumeration heuristic by change type.** For each category of change, the spec's
\`## Scope\` → \`In scope\` list must cover all of the following:

| Change type               | Consumers to enumerate                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Function / type signature | All call sites and imports in \`src/\`, \`tests/\`, \`services/\`, \`.github/\`                                                          |
| Skill text / command name | All skill files under \`.claude/skills/\` and \`.claude/agents/\`, all \`CLAUDE.md\` sections that reference the skill/command by name |
| Env-var rename            | All reads in \`src/\`, \`services/\`, \`scripts/\`, \`.github/\` **and** deployed-environment artifacts (see below)                      |
| Config key / schema field | All reads in \`src/\`, \`tests/\`, \`services/\`, \`.github/\`, \`docs/\` **and** deployed-environment artifacts (see below)               |

**Deployed-environment artifacts (required callout for env-var and config-key changes).**
Source-code consumers are not the only consumers. When an env-var or config key changes, the
following deployed-environment locations must be explicitly checked and enumerated or ruled out:

- **Railway service env vars** — any Railway service that sets or reads the variable
  (visible in \`services/*/railway.config.ts\`, Railway dashboard env-var declarations, and
  \`railway.json\` / \`railway.toml\` files if present)
- **CI/CD env declarations** — \`.github/workflows/*.yml\` files that set the variable via
  \`env:\` blocks or \`secrets:\` references
- **In-tree service configs** — \`services/*/railway.config.ts\` and any other
  service-config files in the \`services/\` directory that reference the key

**Check steps:**

1. Read the spec and identify whether it describes any of the trigger-condition change types.
   If not, record "(h) passes — no contract modification."
2. If triggered, identify the specific artifact(s) being changed (names, paths, key names).
3. For each artifact, look up its consumer class in the heuristic table above.
4. Verify the spec's \`## Scope\` → \`In scope\` list covers each consumer class. Missing
   consumer classes are blocking gaps.
5. For env-var and config-key changes specifically: confirm the spec explicitly addresses each
   of the three deployed-environment artifact categories, either enumerating consumers or
   stating "no consumers in this category."

A spec that says "sole consumer is X" without a verified sweep of the consumer classes does
not satisfy this criterion — the claim must be grounded in an actual search, not an assumption.

#### Gate criterion (j) — Premise label verification

When the spec or amendment applies a categorization label that determines policy treatment,
the agent MUST produce a four-step citation-and-mapping protocol BEFORE the label is applied.
Categorization labels that determine policy treatment include (but are not limited to):

- \`source-of-truth state\` (vs derived analytics / observability)
- \`auxiliary capability\` (vs core)
- \`ephemeral\` (vs durable)
- \`derived analytics\` (vs source-of-truth)
- \`complement\` / \`in-house substrate\` / \`parallel implementation\`
- \`tier N\` (e.g., T0 / T1 / T4 in Progressive Adoption Model)
- \`policy carve-out\` / \`scope boundary\` / \`out of scope per §X\`

Rationale: four recurrences of the confabulated-strategic-frame failure family in six days
(R1 hosted-MCP 2026-05-08; R2 build-vs-buy 2026-05-12; R3 explicit-framework-selection
2026-05-12; R4 mt#1306 spec amendment 2026-05-13). Prior tier escalations: memory entry →
corpus rule (\`decision-defaults.mdc §Build vs buy\`) → \`/declare-framework\` skill (mt#1789).
The R4 sub-pattern — applying a categorization label _within_ a framework without verifying
the label against the framework's actual definition — wasn't covered by \`/declare-framework\`
(which addresses framework selection, not label application). Gate (j) is the sibling
chain-step escalation for label application.

The structural insight: memory-tier and corpus-tier rules say "watch for confabulation."
They are advisory text that requires the agent to remember and apply the check at the right
moment — which is mid-spec-amendment when attention is on substantive content. Citation is
mechanical; introspection is unreliable. The four-step protocol forces specificity:
citation, verbatim quote, explicit mapping, and explicit verdict. The agent cannot
rationalize past "what is the actual definition of this label?" with the same fluency it
can rationalize past "is this a confabulation?"

**Trigger condition.** This criterion fires when the spec or amendment contains a
categorization label from the list above (or a synonym/paraphrase). If no such label
appears, the criterion passes automatically. State that explicitly:
"(j) No categorization label applied — criterion passes."

**Required four-step protocol (when triggered):**

1. **Cite the rule** that defines the label. Examples: \`decision-defaults.mdc §Datastores\`
   for "source-of-truth state"; \`decision-defaults.mdc §Build vs buy\` for "auxiliary
   capability"; \`progressive-adoption-model\` memory for "tier N".
2. **Quote the definition verbatim** — not paraphrased. Paraphrase is where confabulation
   re-enters. Copy the exact language from the cited rule into the gate output.
3. **Map the artifact's properties to the definition's criteria** — explicitly list what
   the criteria say and what the artifact actually has. One-to-one mapping; identify any
   criterion the artifact does not satisfy.
4. **State the verdict:** "criteria met" / "criteria not met" / "criteria ambiguous". If
   ambiguous, file an Ask rather than applying the label.

A spec that applies a categorization label without producing this four-step output fails
gate (j) and must not proceed to READY. If the mapping in step 3 cannot be cleanly
produced, the label is suspect — surface this as a blocking gap and the user decides
whether to apply a different label, retire the categorization, or file an Ask.

**Regression example — mt#1306 (2026-05-13).** During a reviewer-cluster cleanup session,
the agent labeled mt#1306 (in-house Postgres convergence-metrics table) "source-of-truth
state" to justify keeping it in-house, applied that framing across three spec amendments
(mt#1110/mt#1497/mt#1552). On user challenge ("Are you sure we want it to be in-house?
Help me understand the justification"), checking \`decision-defaults.mdc §Datastores\`'s
actual definition immediately invalidated the label.

Walkthrough of what gate (j) would have produced:

1. **Cite:** \`decision-defaults.mdc §Datastores\`
2. **Quote:** _"this policy covers Minsky's source-of-truth state — places that hold
   authoritative product data the system owns. It does NOT cover derived analytics,
   observability sinks, or event streams."_
3. **Map:** mt#1306 holds blocker-count aggregates derived from GitHub-side review data.
   GitHub owns reviews (source of truth); Minsky owns tasks. mt#1306 doesn't own anything
   authoritative — it's a measurement aggregate. Criterion "authoritative product data"
   → NO. Criterion "the system owns" → NO.
4. **Verdict:** Criteria NOT met. Label "source-of-truth state" is invalid for mt#1306.
   The artifact is observability data, not source-of-truth.

Gate (j) would have blocked the original spec amendment. The agent would have surfaced
the gap, leading to the user's challenge being avoided entirely — or, if the user wanted
to proceed anyway, the explicit "label not justified by definition" record would have
made the choice intentional rather than confabulated.

Cross-reference: \`feedback_premise_label_verification_required\` (id \`b8bcebec\`) is the
bridge memory until this gate ships; once shipped, that memory's job becomes historical
record + pointer here. Sibling skill: \`/declare-framework\` (mt#1789, framework selection).

#### Gate criterion (k) — Third-party tool/dependency verification

When the spec recommends adopting, installing, or relying on a third-party tool, library,
or service — by GitHub repo URL, package name, CLI tool name, or similar reference — the
agent must run four cheap verification checks BEFORE the spec can proceed to READY. A spec
that references a third-party dependency without running these checks is incomplete.

Rationale: mt#1714 / 2026-05-11 incident — the spec recommended \`data-goblin/claude-code-mcp-reload\`
("mcp-hot-reload") as a staleness-exit absorption proxy. The recommendation was inherited
from mt#1713's "Research findings" section, also written without verification. All four
checks would have surfaced blocking gaps in under a minute:

- **License**: \`PROPRIETARY\` — "Commercial use of any kind is STRICTLY PROHIBITED … You may
  not modify, reverse engineer, decompile, or disassemble." Minsky is commercial.
- **Maintenance**: 7 stars, 0 issues, 0 PRs, \`created==pushed\` on 2025-07-10 (single-day
  project, no commits since).
- **Install path**: spec said \`pip install mcp-hot-reload\`; package not on PyPI (404).
  Actual install is \`git clone && pip install -e .\`.
- **Canonical URL**: spec linked \`data-goblin/claude-code-mcp-reload\`. The upstream README's
  own clone URL points to \`claude-code-mcp-reload/claude-code-mcp-reload\` — a non-existent
  org (404).

This is the third-party-tool slice of the contract-propagation pattern that Gate (h)
addresses for first-party contracts: a claim crystallizes upstream and downstream consumers
inherit it as a settled premise. Recurrence record: 9+ prior cases (mt#1208 ×2, mt#1224,
mt#1262, mt#1682 ×4) plus mt#1713→mt#1714 (×2). Prior fix tier was a memory entry plus
mt#1541's policy-coverage detector in calibration mode. Memory-only + calibration-mode
detector is not sufficient enforcement; an explicit blocking gate at spec-quality-check time
is the right tier.

**Trigger condition.** This criterion fires when the spec contains any of:

- A GitHub repo URL (e.g., \`github.com/owner/repo\`, \`owner/repo\` shorthand)
- A package-manager install command (\`pip install <name>\`, \`npm install <name>\`,
  \`cargo add <name>\`, \`brew install <name>\`, etc.)
- An explicit recommendation to use any named external tool, library, or service
  introduced by this task

If none of these apply, this criterion passes automatically. State that explicitly:
"(k) No third-party tool recommendation found — criterion passes."

**Required verification table (when triggered).** For each identified third-party dependency:

| Check         | How to verify                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Block condition                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License       | \`gh api repos/<owner>/<repo>\` → \`.license.spdx_id\`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Block on SPDX identifiers (case-sensitive, as returned by \`gh api\`): \`Proprietary\`, \`NOASSERTION\`, \`Other\`, and any \`GPL-*\` (including \`GPL-2.0-only\`, \`GPL-2.0-or-later\`, \`GPL-3.0-only\`, \`GPL-3.0-or-later\`, \`AGPL-3.0-only\`, \`AGPL-3.0-or-later\`). \`LGPL-*\` and \`MPL-2.0\` ARE on the allowlist (weak-copyleft, commercial-compatible per project policy). Block until explicit acknowledgment from user. |
| Maintenance   | Same API response: check \`archived\`, \`created_at\`, \`pushed_at\`, \`stargazers_count\`, \`forks_count\`, \`open_issues_count\`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | \`archived==true\` OR (\`created_at == pushed_at\` AND \`stargazers_count < 10\`) — block; single-day abandoned project heuristic                                                                                                                                                                                                                                                                                 |
| Install path  | Probe registry: \`pip index versions <name>\` for Python; \`npm view <name> version\` for Node; \`cargo search <name>\` for Rust                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 404 / no result — block unless spec provides the correct alternative install path (e.g., \`git clone && pip install -e .\`)                                                                                                                                                                                                                                                                                   |
| Canonical URL | HTTP 2xx or 3xx (following redirects) on the spec's stated URL AND on any HTTP(S) URL found inside the upstream's own README. Treat 401/403 as inconclusive (proceed but flag for manual review); block only on 4xx (other than auth) or 5xx. The HTTP status check applies to HTTP/S URLs only. SSH clone URLs (e.g., \`git@github.com:owner/repo.git\`) and \`git://\` URLs are excluded from this check; their presence in the README is fine. If the only canonical URL inside the README is a non-HTTP(S) URL, manually verify the repo exists by other means before applying this gate's verdict. | Disagreement between spec URL and upstream README URL, OR non-auth 4xx/5xx inside upstream README — block                                                                                                                                                                                                                                                                                                   |

**Check steps:**

1. Read the spec and identify any third-party tool, library, or service recommendation
   (GitHub URL, package-manager install command, named external tool). If none, record
   "(k) passes — no third-party tool recommendation."
2. For each identified dependency, run the four checks in the table above. Use
   \`mcp__minsky__session_exec\` (or equivalent shell access) for the registry probes and
   HTTP checks.
3. Record findings per check. License: state the \`spdx_id\`. Maintenance: state whether
   \`archived\`, and the \`created_at\`/\`pushed_at\` equality check result. Install path: state
   the registry probe result (HTTP status or package version). Canonical URL: state whether
   the spec URL and upstream README URL agree.
4. Any check that hits a block condition is a blocking gap. Summarize each blocking gap
   with the check name and the specific finding (e.g., "License: PROPRIETARY").
5. Evidence lives in the spec text under \`## Context\` as \`Third-party dependency: <name>\` —
   include license, maintenance signal, install path, and canonical URL findings.

A spec that says "use <tool>" or links a repo without running these four checks does not
satisfy this criterion. The claim must be grounded in an actual verification, not an
assumption inherited from upstream research or prior agent turns.

Cross-reference: bridge memory \`e296b3ee-324e-4186-9313-926dd3f9ee5b\`
(\`Third-party tool recommendations must verify license/maintenance/install-path/canonical-URL
at spec-authoring time\`) is the precedent memory this gate formalizes; once this gate ships,
that memory's job becomes historical record + pointer here. Mechanization path: mt#1541
(Surface 1 policy-coverage detector, graduating to enforcing mode).

#### Gate criterion (m) — Factual-claim citation verification

When the spec (or amendment) **cites a memory ID, rule section, or doc passage** AND that
citation is used to justify a **structural choice** (substrate, capability, abstraction
boundary, "new vs extended pattern"), the agent MUST produce a three-step citation-and-mapping
protocol BEFORE the structural choice is encoded. This is the factual-content sibling of gate
(j): gate (j) verifies a categorization _label_ against its defining rule; gate (m) verifies a
_factual claim_ against its cited source.

Rationale: the memory-snippet-conflation pattern. The agent retrieves a source correctly, then
a salient phrase in it becomes the anchor for the rendering while adjacent qualifying sentences
are silently dropped — the artifact lands with a near-but-different technical framing. The
information was in context; the encoding step skipped re-verification. Citation is mechanical;
introspection ("is this a conflation?") is unreliable — so the protocol forces a verbatim quote
and an explicit mapping the agent cannot fluently rationalize past.

**Trigger condition.** Fires when a structural choice in the spec rests on a cited memory / rule /
doc passage. If no cited claim drives a structural choice, the criterion passes automatically:
"(m) No cited factual claim drives a structural choice — criterion passes."

**Required three-step protocol (when triggered):**

1. **Verbatim quote** of the cited text — copied exactly from the source (\`memory_get\`, the
   rule file, the doc), not paraphrased. Paraphrase is where conflation re-enters.
2. **Explicit mapping** of how the structural choice follows from the quote — one-to-one: what
   the quote actually says vs. what the spec asserts it supports. Name any gap.
3. **Verdict:** "claim supported" / "claim not supported" / "claim ambiguous". If ambiguous or
   not supported, do not encode the structural choice — surface the gap; file an Ask if the
   source itself is unclear.

A spec that cites a source to justify a structural choice without producing this three-step
output fails gate (m) and must not proceed to READY.

**Worked example — mt#1852 / ADR-010 (2026-05-15).** The spec and ADR-010 §Substrate-constraint
encoded "dedicated direct Postgres connection (bypassing Supavisor's transaction pooler)," citing
the \`project_supabase\` memory. Walking gate (m):

1. **Verbatim quote** (\`project_supabase\`): the memory named the **session pooler** (port 5432,
   same Supavisor) as the LISTEN/NOTIFY-capable alternative — NOT a direct connection bypassing
   Supavisor.
2. **Mapping:** the spec asserted "direct connection bypassing the pooler"; the source said
   "session-pool mode on the same pooler." Two distinct axes — "session vs transaction pool mode"
   and "pooled vs direct connection" — were collapsed under the salient phrase "no LISTEN/NOTIFY."
   Gap: the spec's "bypass the pooler" is not in the source.
3. **Verdict:** claim NOT supported. The structural choice as framed does not follow from the
   citation. Gate (m) blocks; the agent surfaces the gap instead of encoding the wrong framing
   (which is what shipped in ADR-010 commit \`af07a249c\`, later corrected via mt#1857).

Cross-reference: bridge memory \`feedback_memory_snippet_conflation_at_artifact_write_time\`
(id \`de54bd12-fa9a-4023-bc34-83a1832aefdb\`) is the originating-pattern reference; once this gate
ships, that memory's job becomes historical record + pointer here. Sibling gates: (j) label
verification (mt#1820), and the gate-(iv) design-intent-assertion sub-check (mt#1676). The
runtime-diagnosis sibling surface (citing a stale warning while debugging) is owned by mt#2216.

### Step 4: Act on gate results

**All gate criteria pass:**

1. Report the gate summary (all green).
2. Call \`mcp__minsky__tasks_status_set\` to transition the task to **READY**.
3. **Continue the lifecycle: invoke \`/implement-task mt#X\` directly** (do NOT stop and hand the next-step instruction back to the user). Per CLAUDE.md User Preferences ("Take direct action without asking: When the next step is clear, proceed immediately"), the post-READY default IS implementation. Stopping at READY with "Use \`/implement-task\` to begin" wording is the failure mode this step was rewritten to prevent (originating incident 2026-05-11; prior incident 2026-04-30 captured in memory \`feedback_auto_mode_chains_skills_at_affirmative_tokens\`, id \`4b83ff51-4bc2-49f5-84be-7e4eac073125\`).

   **Only halt before \`/implement-task\` if** one of these explicit halt conditions holds:

   - The user said something during planning that explicitly defers implementation ("don't implement yet", "just plan it", "I'll handle the impl").
   - The READY transition itself surfaced a new blocking signal (e.g., dependency status check failed mid-transition).
   - The task is gated on an external decision the user owns (e.g., "spec needs your approval before impl"), explicitly stated in the spec.

   **Do NOT halt for any of these reasons** (each was a confabulated halt rationale in the originating incident):

   - "Planning is the skill's scope; implementation is a separate skill."
   - "User might want to review the gate report before I proceed."
   - "The next move is user-driven."

   When a brief affirmative ("proceed", "continue", "go", "ok", "yes") arrives at any planning hand-off point, treat it as confirmation to walk the chain forward — NOT as acknowledgment to stop. The bridge memory \`4b83ff51\` covers this verbatim; this step encodes the same discipline structurally so the agent doesn't have to recall the memory at hand-off time.

   **Multi-next-step disambiguation guard (mt#1842).** The chain-walk-on-affirmative discipline above assumes an UNAMBIGUOUS next step. When the just-READY'd task is a child of a parent with multiple unblocked siblings — i.e., walking to \`/implement-task\` on THIS task silently picks one of N possible next moves — invoke \`/disambiguate-next\` BEFORE the chain-walk to \`/implement-task\`. Trigger detection: call \`mcp__minsky__tasks_parent <this-task>\`; if a parent exists, call \`mcp__minsky__tasks_children <parent>\` and count tasks in walkable state (TODO + spec-substantive, READY, IN-PROGRESS). If count ≥ 2, the disambiguation guard fires — surface the option set in user-facing output BEFORE the \`/implement-task\` call. The exception: if the prior agent turn explicitly recommended THIS specific task as next and the user's brief affirmative followed that recommendation, no disambiguation is needed (the recommendation IS the disambiguation). See \`/disambiguate-next\` for the full skill including the stakes-filter sub-check.

   **Tracking task for the structural chaining mechanism:** mt#1478 (Auto-mode skill chaining: /plan-task → /implement-task → /prepare-pr → /merge-coordination walk the chain at gate-passes). When mt#1478's other deliverables ship (implement-task, prepare-pr, merge-coordination SKILL amendments + CLAUDE.md doc section), the chain is fully structural and this paragraph can be retired.

**One or more gate criteria fail:**

1. Do **not** call \`tasks_status_set\` → READY.
2. Task remains in PLANNING.
3. Present a structured gap report:

\`\`\`
## Gap Report for mt#X (PLANNING — not yet READY)

### Blocking gaps
- [criterion letter] <description of gap>
- [criterion letter] <description of gap>

### Required actions before READY
1. <concrete action the user or agent must take>
2. <concrete action the user or agent must take>

To re-run the gate after fixes: \`/plan-task mt#X\`
\`\`\`

4. Stop. Do not attempt to patch the spec automatically unless the user explicitly asks.

**Example (h) failure.** For a task that renames a config key (e.g., \`sessionDbPath\` →
\`sessiondb.path\`) whose spec says "Sole consumer is \`~/.config/minsky/config.yaml\`":

\`\`\`
## Gap Report for mt#1610 (PLANNING — not yet READY)

### Blocking gaps
- (h) Contract-propagation enumeration: spec claims sole consumer of \`MINSKY_SESSIONDB_*\`
  is \`~/.config/minsky/config.yaml\` but does not enumerate deployed-environment consumers.
  Missing: Railway service env vars (\`MINSKY_SESSIONDB_PATH\`, \`MINSKY_SESSIONDB_AUTH_TOKEN\`
  set on \`minsky-mcp\` Railway service), CI/CD env declarations (\`.github/workflows/\`
  references), and in-tree service configs (\`services/*/railway.config.ts\`).

### Required actions before READY
1. Add the Railway env-var consumers to \`## Scope\` → \`In scope\`:
   "Railway \`minsky-mcp\` service env vars: MINSKY_SESSIONDB_PATH, MINSKY_SESSIONDB_AUTH_TOKEN"
2. State explicitly whether CI/CD workflows or in-tree service configs reference this key
   (or confirm they do not after a verified grep).

To re-run the gate after fixes: \`/plan-task mt#1610\`
\`\`\`

**Example (j) failure.** For a task that amends a spec to label mt#1306 as "source-of-truth state"
without producing the citation-and-mapping protocol:

\`\`\`
## Gap Report for mt#1306 amendment (PLANNING — not yet READY)

### Blocking gaps
- (j) Premise label verification: spec applies the label "source-of-truth state" to mt#1306
  without producing the four-step protocol. The label triggers gate (j) per the trigger list.
  Required: cite \`decision-defaults.mdc §Datastores\`; quote the definition verbatim; map
  mt#1306's properties (derived measurement counts of GitHub-side review data) against the
  criteria ("authoritative product data the system owns"); state verdict.

### Required actions before READY
1. Produce the four-step protocol in the spec or amendment.
2. If the mapping fails, retire the label (and the policy treatment it implied) OR file an
   Ask to confirm whether a different label fits.

To re-run the gate after fixes: \`/plan-task <task-id>\`
\`\`\`

**Example (k) failure.** For a task that recommends adopting \`acme-corp/auto-summarizer\`
(a hypothetical proprietary-licensed GitHub project) as a summarization backend without
running any verification checks:

\`\`\`
## Gap Report for mt#XXXX (PLANNING — not yet READY)

### Blocking gaps
- (k) Third-party tool/dependency verification: spec recommends \`acme-corp/auto-summarizer\`
  but no verification checks were run. License check via \`gh api repos/acme-corp/auto-summarizer\`
  returns \`spdx_id: null, license: {name: "Proprietary"}\`. Minsky is commercial; this license
  is incompatible. Maintenance check: \`archived: false\`, but \`created_at == pushed_at\`
  (2024-11-03) and \`stargazers_count: 2\` — single-day abandoned project heuristic fires.
  Install path: \`pip install auto-summarizer\` returns HTTP 404 from PyPI — package does not
  exist in the registry. Canonical URL: spec links \`github.com/acme-corp/auto-summarizer\`;
  upstream README references \`acme-corp/summarizer-v2\` which returns 404 — URL mismatch.
  All four sub-checks block.

### Required actions before READY
1. Abandon \`acme-corp/auto-summarizer\` as a dependency recommendation — license is
   Proprietary (incompatible with Minsky's commercial use) and the project appears abandoned.
2. Research an alternative with a permissive license (MIT, Apache-2.0, BSD-*, ISC) AND
   active maintenance history. Run all four (k) checks before re-submitting.
3. Add \`Third-party dependency: <name>\` evidence block to \`## Context\` with the verified
   license, maintenance signal, install path, and canonical URL for the chosen replacement.

To re-run the gate after fixes: \`/plan-task mt#XXXX\`
\`\`\`

**Example (m) failure.** For a task whose spec cites the \`project_supabase\` memory to justify
a "dedicated direct Postgres connection bypassing Supavisor's transaction pooler" without
producing the three-step citation-and-mapping protocol:

\`\`\`
## Gap Report for mt#1852 (PLANNING — not yet READY)

### Blocking gaps
- (m) Factual-claim citation verification: the spec cites \`project_supabase\` to justify a
  substrate choice ("direct connection bypassing the pooler") but produces no verbatim quote +
  mapping. Walking gate (m): the memory names the SESSION POOLER (port 5432, same Supavisor) as
  the LISTEN/NOTIFY-capable alternative — NOT a direct connection bypassing Supavisor. The spec
  collapsed "session vs transaction pool mode" and "pooled vs direct connection" under the
  salient phrase "no LISTEN/NOTIFY." Verdict: claim NOT supported.

### Required actions before READY
1. Produce the three-step protocol: verbatim-quote \`project_supabase\`, map the substrate choice
   to the quote, state the verdict.
2. Re-frame the substrate decision to match the source (session-pool mode on the same pooler),
   or cite a different source that actually supports the direct-connection bypass.

To re-run the gate after fixes: \`/plan-task mt#1852\`
\`\`\`

## State transition map

| Current status | Action                                           |
| -------------- | ------------------------------------------------ |
| TODO           | → PLANNING (first step), then investigate + gate |
| PLANNING       | Skip transition, investigate + gate              |
| READY          | Report already READY, stop (confirm to re-run)   |
| IN-PROGRESS    | Out of scope for this skill; inform user         |
| IN-REVIEW      | Out of scope for this skill; inform user         |
| DONE           | Out of scope for this skill; inform user         |
| BLOCKED        | Surface blocker, do not transition               |

## Key constraints

- **Never set DONE** — only the merge + post-merge audit flow does that.
- **Never start a session** — that is \`/implement-task\`'s responsibility.
- **Never create the task** — use \`/create-task\` for new tasks.
- **Idempotent transitions** — calling \`tasks_status_set\` → PLANNING when already PLANNING
  is a no-op; the skill handles this by reading status first.
- **Premise audit must precede spec-quality gate check** — READY recommendations, closure
  recommendations, and amendment recommendations are blocked until all four premise-audit
  checks (i)–(iv) have explicit answers in the agent's output.

## Reframe-trigger ergonomics

There is no reliable harness-level intervention that _produces_ a reframe. The harness can
block premature transitions and require audit answers, but it cannot force the agent to
recognize a structural pattern it has not already seen.

The load-bearing prompt-shape that unlocks a reframe is **Socratic premise-interrogation by
the user**: asking "what exactly is this fixing?", "what are the sub-operations?", "is this
the third time we've patched this?" These questions surface assumptions the agent has
silently inherited.

This skill encourages the agent to apply that Socratic shape to itself during the framing
check (iv): decompose the operation being patched, question whether sub-operations are being
conflated, and check whether the cluster of prior fixes points to a structural gap rather
than a series of independent incidents.

The agent should not wait for the user to ask these questions. If the framing check (iv)
produces no structural reframe, the agent should explicitly document why — not silently
pass.

## Regression example

**Example failure (2026-04-27, mt#1357 investigation).** Investigating three child tasks of
a sanitizer-cluster investigation, the agent:

(a) treated parent-investigation correlation as causation without checking what would
resolve the open hypothesis — premise check (i) failure;

(b) anchored on existing scope-calibration architecture when the actual problem was an
output-format issue, not a rigor-calibration issue — categorization check (ii) failure;

(c) inherited a classifier's verdict as truth (skill files matching \`*.md\` therefore being
"docs") — a second categorization check (ii) failure;

(d) skipped the parallel-work check because investigation felt like not-yet-acting — a
parallel-work check (iii) failure.

The user's premise-checking questions surfaced all four errors. The structural fix (this
premise-audit step) would have produced the same answers without that prompting.
`,
});
