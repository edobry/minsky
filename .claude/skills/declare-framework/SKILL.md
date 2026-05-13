---
name: declare-framework
description: >-
  Before delivering a strategic recommendation (tool / vendor / architectural /
  scope-changing decision), name the evaluation framework being applied and
  check it against principal-context.mdc. Use when about to recommend a SaaS
  tool, a vendor, an architectural direction, a scope change, or any choice
  among options under criteria.
user-invocable: true
---

# Declare Framework

Force-explicit framework selection before strategic recommendations. Every strategic recommendation has an implicit evaluation framework (workflow-fit, OSS-purity, cost-minimization, community-alignment, time-to-customer-insight, etc.). If the agent doesn't name the framework, mismatches with the principal's position stay hidden behind many turns of reasoning before the user can surface them.

This skill is the structural enforcement of `principal-context.mdc §Trigger rule`. It is invoked explicitly when the agent recognizes that a strategic recommendation is in flight.

## Arguments

Optional: a one-phrase description of the decision (e.g., `/declare-framework observability tool selection`, `/declare-framework persistence backend choice`).

## When to invoke

A strategic recommendation is any of:

- **Tool / SaaS selection** — picking among observability platforms, analytics tools, CI services, eval frameworks, etc.
- **Vendor commitment** — adopting a hosted service, signing up for a paid plan, integrating a third-party API
- **Architectural decision** — choosing among design alternatives with substantive trade-offs (database backend, service decomposition, persistence model, etc.)
- **Scope change** — expanding or narrowing an in-flight task's stated bounds

**Self-trigger cues (advisory — agent self-discipline, not harness-fired).** The Claude Code harness does not fire this skill automatically based on the agent's internal state. These cues are agent self-recognition signals; when one fires, the agent should invoke `/declare-framework` explicitly or internally walk through the 5-step process before continuing. If meta-recurrence (R4+) shows the self-discipline cues are insufficient, a follow-up task will wire structural enforcement (PreToolUse hook on recommendation output, or chain-step inside `/plan-task` / `/implement-task` / `/orchestrate`).

Recognize a strategic recommendation is in flight when:

- The agent is about to write a recommendation message that picks among ≥ 2 named candidates
- The agent is asked "which X should I use" / "what's the right tool for Y" / "should we go with A or B"
- The agent recognizes it is comparing tools, vendors, or architectures

## When NOT to invoke

- **Craft-level choices** — file structure, micro-phrasing, low-stakes naming, task-spec layout. These are the agent's by default per `humility.mdc` stakes filter.
- **Tactical fixes within an already-decided framework** — e.g., "given we're using Braintrust, where should the project ID live."
- **Information retrieval** — "what does X do" that doesn't terminate in a recommendation.
- **Mechanical decisions inside a skill chain** — `/plan-task` gate transitions, `/implement-task` test scaffolding choices, etc. These run inside an already-scoped framework.

## Process

### Step 1: State what's being decided

In one sentence, in the user-facing message (not internally). "I'm recommending an observability platform for Minsky." Don't proceed to candidates until the decision is named.

### Step 2: List candidate evaluation frameworks

Pick at least two; force yourself to name them. Common implicit frameworks to enumerate:

- **Workflow-fit** — what matches the actual use case and operating loop
- **Time-to-customer-insight** — how fast does "customer reports issue" become "shipped fix"
- **Customer-logo signal** — what do peer commercial-AI-product teams use
- **OSS-purity** — open-source / self-hostable / no vendor lock-in
- **Community-adoption** — what's most popular by stars / downloads / mentions
- **Cost-minimization** — what's cheapest or free
- **Lock-in-minimization** — what can I switch from cheaply

This is non-exhaustive. The point is enumeration: an implicit framework you can't name is one you can't verify against principal-context.

**Exception — if only one candidate framework exists.** If after honest enumeration you can name only one plausible framework for the decision at hand, the decision is either (a) so well-bounded by `principal-context.mdc` that the framework is pre-determined (in which case state it explicitly and proceed), or (b) not actually a strategic recommendation (e.g., a tactical execution inside an already-decided framework — see "When NOT to invoke"). In case (b), skip the skill.

### Step 3: Check each candidate against `principal-context.mdc`

For each candidate framework, ask:

- Does it match Eugene's position as principal of a commercial AI product (Minsky)?
- Am I re-inferring persona from local signals (cost-sensitivity, solo-dev) instead of reading the rule? If yes, switch.
- Is the framework category-aware? Lock-in concerns are load-bearing for source-of-truth state, near-zero for OTel-conformant event sinks. The framework should match the decision category, not be imported from a different category.

### Step 4: Declare the chosen framework in the user-facing recommendation

Before delivering the recommendation, the recommendation message must contain a framework-declaration line. Template:

> **Framework I'm applying**: `<framework name>` per `principal-context.mdc §<section>`. Sub-claims: `<one-line rationale per sub-claim>`.

Example:

> **Framework I'm applying**: workflow-fit + time-to-customer-insight + customer-logo signal for a commercial AI product per `principal-context.mdc §Tool selection for non-core capabilities`. Sub-claims: switching cost is near-zero for OTel-conformant sinks, so lock-in concerns don't dominate; engineering time is the scarcest resource, so SaaS that costs $10s/mo to save days of in-house infra is worth it; if peer commercial-AI teams pick the tool, that calibrates fit.

**Anti-pattern**: putting the framework declaration ONLY in internal reasoning and not in the user-facing output. The user must see the framework to spot mismatches. If the framework is implicit at delivery time, the skill failed.

### Step 5: If switched mid-stream, surface what switched

If you noticed mid-recommendation that the framework you defaulted to was wrong (e.g., OSS-purist for a derived-analytics tool), name the switch:

> I initially anchored on OSS-purity but that's the wrong frame for a commercial-product SaaS-observability decision. Switching to workflow-fit + time-to-customer-insight per `principal-context.mdc`.

Surfacing the switch is more valuable than getting the framework right on the first try. It teaches the principal where the agent's default frame is, so the principal can correct it earlier next time.

## Anti-patterns from the originating incidents

(R1) **Default-to-build for non-core capability.** Picking "build in-house on Postgres" because Postgres is the Minsky datastore policy default — without recognizing the policy covers source-of-truth state, not auxiliary analytics. The framework was unwitting policy-laundering; the correct frame is workflow-fit. See `feedback_build_vs_buy_default_for_non_core`.

(R2) **Build-path-as-research at action-execution time.** Picking "extract from existing in-house data" as the first action because it reads as principled / cheap — without recognizing it IS the build path, and the SaaS evaluation step was skipped. The framework "use existing signals" laundered the build preference. See `feedback_build_path_as_research_at_action_time`.

(R3) **Implicit OSS-purist framework for SaaS observability.** Centering OSS-hedge weight and community-adoption signals when evaluating Langfuse / Phoenix / PostHog / Braintrust — without naming the framework was OSS-purist. The user had to articulate the principal frame to break the agent out. See `feedback_explicit_framework_selection` and `principal-context.mdc §Originating incidents`.

All three failures were structurally identical: the framework was implicit. Naming it is the fix.

## Cross-references

- `principal-context.mdc` — the persona frame this skill enforces; particularly `§Trigger rule` and `§Framework implications`
- `feedback_explicit_framework_selection` — bridge memory this skill retires
- `feedback_build_vs_buy_default_for_non_core` — R1 of the same pattern
- `feedback_build_path_as_research_at_action_time` — R2 of the same pattern
- `feedback_confabulated_strategic_frame_to_justify_tactical_preference` — sibling pattern (manufacturing frames vs. misapplying frameworks)
- `humility.mdc §Escalation packaging` — escalation discipline that this skill enables (an escalation can only be packaged well when the framework is named)
- `decision-defaults.mdc §Build vs buy` — corpus rule whose anti-pattern checklist this skill operationalizes
- mt#1789 — originating task
