---
name: classify-before-deferring
description: >-
  Before ending a turn with a question to the user, OR writing a deferred-action
  recommendation ("I'll file that as a follow-up," "out of scope to address
  right now," "worth filing separately," "let's track that," "parking lot
  this," "circle back later," "flag as follow-up") without doing the action
  in the same turn, classify the draft as Class A (verifiable by lookup),
  Class B (default already clear from CLAUDE.md / user-preference rule),
  Class C (genuinely ambiguous principal-stakes choice), or R3
  (recommending-instead-of-acting). Act on the classification instead of
  writing the draft. Use whenever a draft question, "want me to X or Y,"
  "should I," "I'd file that," "we should investigate," "not in scope for
  current PR but," "for now leaving X as," "noting for later," or any
  deferral-shaped prose is about to land — OR when a process checklist or
  gate step asks you to "state a strategy/decision/plan" (a
  checklist-manufactured trigger that does not read as a deferral).
user-invocable: true
---

# Classify Before Deferring

Catch the asking-instead-of-acting and recommending-instead-of-acting failure family at output-write time. Both shapes are instances of the parent anti-pattern **performative language as substitute for action** — the agent defers information-gathering, rule-application, or action-taking onto the user when it could just do the thing.

This skill is the **agent-self-discipline tier** of enforcement for:

- CLAUDE.md `User Preferences §Take direct action without asking` (forward / asking direction)
- CLAUDE.md `Work Completion §Never notice an issue without acting on it` (R3 / recommending direction)

The skill primes the agent at pre-output time via Claude Code's auto-load matching against the frontmatter description; the _application_ of the classifier is the agent's own self-check before each draft question or deferral-recommendation lands. Harness-level hook enforcement (PreToolUse/PostToolUse hook scanning outbound text for trigger phrases and blocking until classification has been applied) is deferred per the originating spec's `## Scope` → `Out of scope` and per memory `8ecfdf66`'s structural-fix-lineage; it will be filed as a follow-up if this self-discipline tier alone proves insufficient.

The sibling skill for the contrition direction (self-recognized failure → retrospective) is `retrospective` (see mt#1895 for the auto-trigger amendment).

## Arguments

Optional: a one-phrase summary of what's about to be written (e.g., `/classify-before-deferring "should I file or chat"`, `/classify-before-deferring "I'd file that as a follow-up"`).

## When to invoke

The skill description triggers whenever output is about to contain a draft question OR a deferral-shaped recommendation. Concretely, before any of the following lands in user-facing output, walk the classifier:

**Asking-shape triggers** (semantic family — match by meaning, NOT literal string):

- "Want me to `<X>` or `<Y>`?"
- "Should I `<X>`?"
- "Would you prefer `<X>` or `<Y>`?"
- "Do you want me to `<X>`?"
- "Or should I `<Y>` instead?"
- "Confirm the `<X>`" (when X is directly checkable)
- "Let me know if you'd like me to..."
- ending a turn with any question that requires user input to proceed

**Recommending-shape triggers (R3 — also semantic family):**

- "I'll file that as its own task" / "I'd file that as a follow-up" (without the actual `mcp__minsky__tasks_create` call in the same turn)
- "Out of scope to address right now" / "Tracking separately" / "Filed for later" (without the actual filing happening NOW)
- "This should be tracked separately" / "Worth filing as a follow-up"
- "We should investigate this further" (without doing the investigation or filing it)
- "Worth a separate task" / "Belongs in its own task"
- "Not in scope for current PR, but..."

The "but" / "however" / "though" in R3-shape phrases is the tell: a noticed issue paired with a deferral.

**Checklist-manufactured triggers (the question does not read as a deferral):**

A process-checklist or gate step that instructs you to "state the strategy / decision / plan" can manufacture a false Class-C decision out of a mechanical consequence. The trigger is subtle because it reads as legitimately populating a checklist slot, not as deferral prose — so it slips past the asking-shape and R3-shape lists above. **A checklist/gate step that asks you to STATE a strategy or decision is itself a classify-before-deferring trigger.** Populate the slot yourself from convention/lookup; only escalate the genuinely Class-C residue. See [Worked Example 4](#example-4--checklist-manufactured-pseudo-decision-caught-class-b-r4).

**Match by meaning, not literal string.** The lists above are illustrative — operational/explanatory prose can carry the same family ("let me know if...", "we should probably...", "this would be worth...", "it'd be good to..."). If the draft text defers information-gathering, rule-application, OR action-taking onto the user, the skill fires.

## When NOT to invoke

- **Mid-turn working questions to the user that are genuinely Class C already.** If the user has signaled they want a choice surfaced (e.g., "give me options"), the discipline is to _package_ the question well (per `humility.mdc §Escalation packaging`), not to suppress it.
- **Recommendations that are explicitly out-of-scope per the spec AND already owned by a tracking task.** If the spec's `## Scope` → `Out of scope` names the deferral AND an owner task exists, writing "deferred per spec §Out of scope (mt#X)" is documentation, not R3 — do not re-file. If no owner task exists, file exactly one in the same turn (`mcp__minsky__tasks_create`) and link the spec section. The skill fires when EITHER condition fails: deferral not in spec, OR deferral in spec but no owner task.
- **Closing a turn after action.** "Done. Tests pass. See PR #N" is not a question or a deferral — no classification needed.

## Process

Before the draft text lands in user-facing output, classify into one of the four cases below and take the prescribed action.

### Class A — Verifiable

The answer is directly determinable by a tool, web, or repo lookup the agent can run.

Examples:

- "Which fork of `<X>` is the popular one?" → `npm view`, GitHub stars / commits, web search.
- "Does library `<Y>` still exist?" → `npm view Y` or fetch its repo.
- "Is file `<Z>` still in the codebase?" → `Glob` / `Read`.
- "What version of dep `<W>` are we on?" → read `package.json`.

**Action: DO THE LOOKUP.** Don't ask. Present findings, continue.

### Class B — Default Already Clear

The answer is determined by a user-preference rule already in CLAUDE.md / `decision-defaults.mdc` / `principal-context.mdc` / prior-conversation context.

Examples:

- "Should I file a task or keep this in conversation?" → CLAUDE.md `User Preferences §Take direct action without asking` + the project convention "we always do a task" → file the task.
- "Should I commit and push?" → CLAUDE.md `User Preferences §Auto-commit and push all changes` → yes.
- "Should I add a feature flag?" → System prompt §Doing tasks (no feature flags / backwards-compat shims) → no.
- "Should I use a session?" → CLAUDE.md `§Session discipline` → yes, all repo edits go through a session.

**Action: APPLY THE DEFAULT.** State which rule / preference covered it, continue.

### Class C — Genuinely Ambiguous

No rule covers it; no lookup resolves it; the choice has real principal-level stakes.

Examples (per `humility.mdc §Decisions Eugene reserves`):

- Naming (product names, customer-facing terms, domain naming that sets precedent).
- Architectural moves that affect customer experience or product surface.
- Authorization for shared / production state changes.
- Scope changes to in-flight work.
- Vendor commitments (signup actions, paid plan upgrades).
- Framework choices when stakes are principal-level.

**Action: ASK, with proper escalation packaging.** Walk the five-item checklist from `humility.mdc §Escalation packaging`:

1. State the question in plain language, not by referent.
2. Inline the full content of every option, not just labels.
3. List the decision drivers — what tilts the choice.
4. Make a recommendation (with a clear "you decide" caveat).
5. Name what you do NOT need from the user (what you can derive yourself).

### R3 — Recommending-Instead-of-Acting

The draft is a future-tense or speculative-tense promise that something _should_ happen, without making it happen now. The recommendation lives in chat; if the user doesn't catch it, the artifact never exists.

This shape is arguably worse than asking, because it doesn't even surface the choice — it just defers action to a hypothetical future caller.

Examples:

- "I'd file that as its own task, not doing it autonomously since it touches shared config" → STOP. File the task NOW in the same turn (`mcp__minsky__tasks_create`).
- "Worth tracking separately as a follow-up" → STOP. Track it now (`mcp__minsky__tasks_create` or `mcp__minsky__memory_create`).
- "We should investigate this further" → STOP. Either investigate now, or file the investigation task now.
- "Out of scope for current PR, but worth noting" → STOP. Either move it into scope, or file the out-of-scope item as its own task NOW.

**Action: DO IT NOW, IN THE SAME TURN.** Call `mcp__minsky__tasks_create` / `mcp__minsky__memory_create` / `mcp__minsky__tasks_spec_patch` / the actual action — don't write the recommendation as a future-tense promise. The recommendation IS the deferral; the filing IS the action.

Per `Work Completion §Never notice an issue without acting on it`: mentioning is not action.

## Worked examples

Examples 1-3 are from the 2026-05-18 originating session (memory `8ecfdf66`, recurrences R1/R2/R3). Example 4 is the first post-skill-ship recurrence (R4, 2026-06-02, mt#2255).

### Example 1 — Class A failure caught (R1)

**Draft:** "Confirm the fork is the recommended one — the original tabtab package may also still be on npm. Pick the one with recent commits."

**Classification:** Class A. Two minutes of `npm view tabtab` + `npm view @pnpm/tabtab` resolves it.

**Correct action:** Run the lookup. Present findings: `@pnpm/tabtab` v0.5.4 (2024-06, active fork), `tabtab` v3.0.2 (2023-04, unmaintained). Continue with the recommended fork. No question to the user.

### Example 2 — Class B failure caught (R2)

**Draft:** "I'd suggest filing this as a Minsky task and going through `/plan-task` → `/implement-task`. Want me to invoke `/create-task` to file it formally, or keep this as an in-conversation spec and proceed directly?"

**Classification:** Class B. CLAUDE.md `User Preferences §Take direct action without asking` + the project convention ("we always do a task") + the standard skill chain (`/create-task → /plan-task → /implement-task`) all converge on: file the task.

**Correct action:** Just file it. Invoke `/create-task` (the skill, which calls `mcp__minsky__tasks_create` after generating a structured spec). Don't surface the choice.

### Example 3 — R3 failure caught (R3)

**Draft:** "I'd file that as its own small task rather than fold it into mt#1892, since it's an unrelated concern. Not doing it autonomously since it touches shared project config."

**Classification:** R3 (recommending-instead-of-acting). Treating "touches shared project config" as a stop-condition is a false premise — filing a task doesn't touch shared config; only the implementation would. The filing IS the action that should happen now.

**Correct action:** Call `mcp__minsky__tasks_create` in the same turn, then mention the task ID in the response. Don't write the recommendation as a future-tense promise.

### Example 4 — Checklist-manufactured pseudo-decision caught (Class B, R4)

**Draft:** "Should the hook modules re-export the moved functions (so test imports stay untouched) — or should the tests import from the new shared module? I recommend re-export."

**Classification:** Class B. A test imports from the module that _defines_ the symbol; when the symbol moves, its imports move with it. No principal-level stake. The "re-export" option was manufactured to fill a binary, and recommending it optimized scope-minimization over correctness — re-exporting a moved symbol back through its old module is the barrel-reexport anti-pattern in miniature (dead public surface + indirection; memory `4012b934`).

**Why the skill didn't fire (the surface this example adds):** the question was not free-standing deferral prose — it was produced by a `/plan-task` gate (h) slot that said "enumerate the consumers AND _state the migration strategy_." Enumerating consumers was correct; "state the migration strategy" got mis-read as "surface a strategy _choice_ to the user," turning a mechanical consequence into a false Class-C decision. The asking-shape and R3-shape trigger lists don't match a checklist slot, so it slipped past. **A checklist/gate step that asks you to STATE a strategy/decision is itself a trigger** — see `## When to invoke`.

**Correct action:** State it as fact and proceed: "Tests import from the new shared module (imports move with the symbol)." No question. (Originating incident mt#2255: the user pushed back twice — "am I missing something?" — before it was dropped, the 1-3-turn correction cost anti-pattern #3 warns about.)

## Anti-patterns

1. **Treating the four classes as a checklist that excuses C-tagging anything inconvenient.** If the draft is Class A or B but feels uncertain, the discipline is to _do the lookup or apply the default_, not to upgrade it to C and ask.

2. **Filing a task as "the action" for an R3 that the user has already explicitly chosen to defer.** If the user said "let's not file that," writing the deferral phrase is not R3 — it's reporting the user's decision. The skill fires on agent-initiated deferral, not on user-confirmed deferral.

3. **Skipping the classifier on "obvious" drafts.** Even when the draft feels obvious, the classifier's job is to make the question's class legible to the agent. The cost of running it is ~10 seconds; the cost of a wrong A/B/R3 is 1–3 user turns of correction plus user frustration.

4. **Hiding R3 behind "for now" language.** "For now, leaving that as a follow-up" / "noting for later" / "leaving room to do that next round" / "parking lot this" / "circle back later" are all R3-shape. If you noticed it, file it now.

5. **Counting an in-conversation recommendation as the artifact.** If you wrote "worth filing a task for X" in chat without calling `mcp__minsky__tasks_create`, the artifact does not exist. The user has to catch the recommendation and prompt you to file it. That's the failure mode this skill exists for.

6. **Letting a checklist slot manufacture a Class-C decision.** When a process step (a `/plan-task` gate, a convergence checklist, a review template) says "state the strategy/plan/decision," the mechanical answer is often convention-determined (Class A/B) — populate it yourself. Don't promote a mechanical consequence to a user-facing binary just because a checklist slot phrased it as "the strategy." See [Worked Example 4](#example-4--checklist-manufactured-pseudo-decision-caught-class-b-r4).

## Future structural enforcement (deferred)

This skill is agent-self-discipline at output-write time. It primes the agent via auto-load but does not mechanically block bad output. The next tier of enforcement — a PreToolUse/PostToolUse hook that scans outbound text for trigger phrases and denies until classification has been applied (or until a sibling action like `mcp__minsky__tasks_create` lands in the same turn) — is deferred per the originating spec's `## Scope` → `Out of scope` and per memory `8ecfdf66`'s structural-fix-lineage.

Trigger to file the hook task: this skill demonstrates insufficiency (e.g., 2+ R-class incidents post-skill-ship within 24h, or 3+ in 5 days, per the workaround-budget convention in `Work Completion §Temporary mechanism budget`). Until then, agent-self-discipline is the contract.

## Sibling pattern: contrition direction

`feedback_self_recognized_failure_is_retrospective_trigger` (id `1b36a19e`) covers the dual direction: when the agent has _already failed_, don't substitute apology language for the durable fix.

- This skill (forward direction): when about to ACT, don't substitute a deferring question OR a deferred-action-recommendation for the action itself.
- `retrospective` skill (contrition direction, per mt#1895): when self-recognizing failure, don't substitute "I owe you an apology" for the structural fix.

Both share the same meta-rule: **match by semantic family, not literal string**. The trigger lists are illustrative; the check at write-time is a meaning check, not a string check.

Both are instances of the parent anti-pattern **performative language as substitute for action**. The `User Preferences §Professional communication` rule covers the credit direction ("You're absolutely right"); these two skills cover the contrition, deference, and deferred-action directions.

## Cross-references

- Memory `feedback_asking_when_i_could_check_or_default_is_clear` (id `8ecfdf66`) — originating memory; this skill is the structural enforcement
- Memory `feedback_self_recognized_failure_is_retrospective_trigger` (id `1b36a19e`) — sibling memory, contrition direction
- Memory `feedback_temporary_mechanism_budget` (id `e81315d4`) — the budget framework that escalated this from memory tier to skill tier
- CLAUDE.md `User Preferences §Take direct action without asking` — the parent rule for asking-shape triggers
- CLAUDE.md `Work Completion §Never notice an issue without acting on it` — the parent rule for R3 / recommending-shape triggers
- CLAUDE.md `User Preferences §Professional communication` — sibling rule banning the credit direction ("You're absolutely right")
- `humility.mdc §Decisions Eugene reserves` — defines the legitimate Class C principal-stakes cases
- `humility.mdc §Escalation packaging` — the five-item checklist for Class C asks
- `/retrospective` — sibling skill for the contrition direction (mt#1895 amends its auto-trigger)
- `/restate-plan` — sibling pre-output-discipline skill (covers the multi-step-direction-compression family, distinct trigger surface)
- Memory `4012b934` — verify architectural patterns vs community practice (scope-minimization-over-correctness; the Example 4 re-export recommendation is an instance)
- Memory `9dd8e8ac` — stakes-filter / 30-second-edit test (the Example 4 re-export-vs-reimport choice fails it trivially)
- Memory `3e3f29d8` — escalation packaging; sibling family (the non-genuine-decision escalation surface)
- mt#1895 — sibling task: add self-recognized-failure triggers to `retrospective` skill
- mt#2255 — originating incident for Worked Example 4 (R4)
- mt#2274 — this task (adds the checklist-manufactured-pseudo-decision surface)
- 2026-05-18 conversation — originating burst (R1 + R2 + R3 in one ~2-hour session)
