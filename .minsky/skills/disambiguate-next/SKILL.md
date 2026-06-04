---
name: disambiguate-next
description: >-
  Before chain-walking on a brief affirmative ("proceed," "continue," "go,"
  "ok") at a task-graph junction, check whether multiple unblocked
  sibling/child tasks exist; if so, surface the choice in user-facing
  output instead of walking to a self-derived default. Use after a task
  merges / transitions to DONE when ≥ 2 sibling or child tasks become
  newly walkable.
user-invocable: true
---

# Disambiguate Next

Catch the chain-walk-on-affirmative pattern at multi-next-step task-graph junctions. The auto-mode-chain discipline (`feedback_auto_mode_chains_skills_at_affirmative_tokens` / `4b83ff51-…`) says "walk on affirmative," but assumes an UNAMBIGUOUS next step. When multiple tasks become unblocked simultaneously, that assumption fails: the agent picks by self-derived dependency ordering ("A → B → C → D" by letter) instead of by the user's actual intent. This skill is the structural enforcement of the bridge memory `feedback_disambiguate_multi_next_step_chain_walk` (mt#1842) — it adds the disambiguation condition to the chain-walk discipline.

## Arguments

Optional: the parent task ID or junction reference (e.g., `/disambiguate-next mt#1768`, `/disambiguate-next post-merge`).

## When to invoke

Both conditions must hold:

1. **Task-graph junction.** A task just transitioned to DONE / merged, OR a parent task's child completed, OR the agent is at any point where >1 sibling/child task is in a walkable state (TODO + spec-substantive, READY, or unblocked).
2. **Brief affirmative.** The current user prompt is a short approval token: `proceed`, `continue`, `go`, `ok`, `yes`, `do it`, or a one-line equivalent without disambiguating content.

When both fire, surface the choice in user-facing output before any tool call that walks to a specific next task.

**Matching is case-insensitive and includes equivalent forms.** "Proceed.", "ok!", "let's go", "continue" all count as brief affirmatives. The trigger fires on signal-pattern recognition, not literal-string matching.

## When NOT to invoke

- **Single unblocked next.** Exactly one task is walkable at the junction. Sibling memory `4b83ff51-…` governs — walk directly.
- **Brief affirmative AFTER a recommendation.** If the prior agent turn explicitly recommended a specific next task ("if you want to keep walking the R-family, mt#1842 is the natural continuation") and the user's brief affirmative immediately follows, the recommendation IS the disambiguation. Walk to the recommended task. (Don't be overly cautious — that's its own failure mode.)
- **Disambiguating signal in the affirmative.** If the user's prompt contains a noun that maps to one of the candidates ("proceed with the skill work", "go do the stack install"), use the noun to pick AND name the choice in user-facing output before walking.
- **Inside a multi-step plan the user has already restated.** When `/restate-plan` (mt#1784) has already walked the plan and identified the next step, that disambiguation governs — don't re-surface.

## Process

### Step 1: Detect multi-next state

At the junction, enumerate walkable siblings/children:

- If a parent task exists: call `mcp__minsky__tasks_children <parent>` and filter to TODO (with substantive spec), READY, or unblocked.
- If no parent: use the conversation history's recent task references (recommendations, status mentions) to identify the candidate set.
- Walkable = the agent could plausibly invoke `/plan-task` or `/implement-task` against it without further input.

If count = 1: skip the skill, walk directly (sibling memory `4b83ff51-…` governs).
If count = 0: there's nothing to walk to; the affirmative may mean something else (ask for clarification).
If count ≥ 2: continue to Step 2.

### Step 2: Apply the stakes filter

If walking the wrong "next" would cost > 30 seconds of agent edits to undo (substantial work effort — file creation, code changes, status transitions beyond TODO → PLANNING), the disambiguation IS principal-level. Do not skip.

If undo cost is < 30s (e.g., wrong status transition only, easily reverted), the agent MAY proceed with a self-derived pick BUT must still name the pick in user-facing output before walking.

### Step 3: Surface the choice (user-facing, before the first tool call)

Template:

> **Multiple unblocked at this junction:**
>
> - **mt#X** (`<one-line purpose>`) — `<one-line cost/effort estimate, optional>`
> - **mt#Y** (`<one-line purpose>`) — `<one-line cost/effort estimate, optional>`
> - **mt#Z** (`<one-line purpose>`) — `<one-line cost/effort estimate, optional>`
>
> "<brief affirmative>" could mean any of these; which?

If the agent has a recommendation: name it AFTER the option list, as a separate line.

> My pick (subject to override): **mt#X** because `<one-line reasoning>`. Confirm?

Do NOT walk to the recommended task without an explicit user confirmation IF the stakes filter (Step 2) flagged this as principal-level. Walking on a self-derived pick when undo cost is high is the failure mode this skill exists to prevent.

### Step 4: Walk after disambiguation

Once the user confirms or the agent's pick is acknowledged (either by a follow-up affirmative or by user silence after an explicit recommendation), invoke the relevant skill (`/plan-task` or `/implement-task`) on the chosen task.

## Phase-labeling guidance (load-bearing for prevention)

When planning multi-phase parents (`/plan-task` gate-(f) subtask filing, `/orchestrate` decomposition), label phases by their **VALUE PROPOSITION**, not by letter:

✅ Good: `skills-setup phase`, `stack-install phase`, `visible-improvement phase`, `observability phase`
❌ Bad: `phase A`, `phase B`, `phase 1`, `phase 2`

The user's verbal frame intersects value-labels naturally ("we set up the skills?" — the agent maps directly to the `skills-setup phase`). Letter-labels are semantically empty; they force the agent to re-derive ordering from the task graph, which is where the originating failure (Instance 2, mt#1772 → wrong mt#1773 pick) happened.

When inheriting an existing letter-labeled phase scheme, rename to value-labels at the next /plan-task touchpoint. This is preventive — the inherited letters propagate the failure pattern.

## Failure mode this prevents

The two originating incidents (2026-05-12, both same session ~6h apart):

**Instance 1 (~12:00 UTC) — mt#1772 scope-creep.** Spec scoped to vendor 12 skills + author agent + author CLAUDE.md + investigate pipeline. After `/plan-task` READY, user said "Proceed"; agent walked to `/implement-task` and started the FULL-scope work. User cut scope after several files of work. The agent's self-derived "all in-scope = proceed with all" interpretation didn't match the user's actual phasing intent.

**Instance 2 (~18:00 UTC) — mt#1768 wrong-child-pick.** After mt#1772 + mt#1782 merged, three children of mt#1768 became unblocked simultaneously: mt#1773 (stack install, NO skills involved), mt#1774 (author cockpit-design skill), mt#1777 (vendor SKILL.md files). User said "Okay, proceed. We've set up all the skills?" Agent answered "skills NOT set up yet" AND walked to mt#1773 (stack install) per self-derived A→B→C→D ordering. The literal word "skills" in the user's prompt was the disambiguating signal; agent walked past it. User caught it after ~7 tool calls / ~5 files written.

Both: self-derived framing, substantial wasted work, user redirects. This skill makes that impossible to land silently — Step 3 forces the option enumeration before any walking tool call.

## Anti-patterns

1. **"It's obvious which one is next."** The Instance 2 incident had a literal disambiguating word in the user's prompt; the agent walked past it. "Obvious" is exactly when the skill must fire — that's when self-derived ordering has the strongest grip.

2. **Self-derived dependency reasoning.** "Stack install is a prerequisite for skill work, so I'll do that first." This is correct task-graph topology AND wrong about user intent. The user's verbal frame (or earlier turn's recommendation) governs, not the agent's dependency derivation.

3. **Walking on an affirmative AFTER posting a recommendation IS NOT this failure.** The "When NOT to invoke" section second bullet covers this — over-disambiguating after an explicit recommendation is its own annoyance. The skill is for the case where NO recommendation was posted and the agent picks silently.

4. **Skipping the stakes filter.** Even when undo cost is low, the agent must name the pick in user-facing output. Silent picks accumulate into trust erosion across sessions.

## Cross-references

- `feedback_disambiguate_multi_next_step_chain_walk` — bridge memory this skill retires (mt#1842)
- `feedback_auto_mode_chains_skills_at_affirmative_tokens` (id `4b83ff51-…`) — sibling memory; composes with this skill (single-next case)
- `feedback_strategic_reframe_first` — neighboring shape (strategic frame checks before tactical specking)
- `/restate-plan` (mt#1784) — sibling discipline at the same tier (multi-step direction restatement)
- `/declare-framework` (mt#1789) — sibling discipline at the same tier (framework declaration before recommendations)
- mt#1478 — auto-mode chain walking parent task (DONE 2026-05-11); this skill extends its scope to multi-next handling
- mt#1842 — this task
- 2026-05-12 originating instances (mt#1772 scope-creep + mt#1768/mt#1773 wrong-child-pick)
