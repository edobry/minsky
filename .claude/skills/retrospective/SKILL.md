---
name: retrospective
description: >-
  Structured post-failure analysis that identifies root causes and produces
  durable fixes to process artifacts. Auto-triggers on correction signals ("that's
  wrong", "you keep doing this", "why did you do that?"). Use when a post-merge
  audit finds issues, the same feedback is given repeatedly, a subagent produces
  incomplete work, or the user asks "what went wrong" / "retrospective" / "why
  does this keep happening".
user-invocable: true
---

# Retrospective Skill

Structured root cause analysis after process failures. Produces durable changes to process artifacts — not a log entry.

## Arguments

Optional: a description of the incident, PR number, or task ID. If omitted, analyze the most recent failure in the conversation.

## When to invoke

- Post-merge audit reveals missed issues
- User gives the same feedback for the 2nd+ time
- Subagent produces incomplete or incorrect work
- A process step is consistently skipped or forgotten
- User explicitly asks: "what went wrong", "retrospective", "root cause", "why does this keep happening"
- **Auto-trigger on correction signals** (no explicit invocation required):
  - Direct correction: "that's wrong", "incorrect", "not right", "that's not what I said"
  - Frustration indicators: "you keep doing this", "I've told you this before", "again?", "how many times"
  - Preference directives: "going forward, always...", "from now on...", "I want you to always..."
  - Rationale questions: "why did you do that?", "what were you thinking?", "why would you..."
  - Agent error requiring user intervention: when your own action caused an error the user had to correct

## Process

### Step 0: Validate the premise

**If the retrospective was triggered by a user correction or challenge** (not by your own observation of a failure):

1. Re-read the actual tool outputs, file contents, or evidence relevant to the alleged mistake.
2. If the action was justified and the user's premise is incorrect, say so clearly with evidence. Do NOT proceed with the retrospective. Do NOT apologize for correct behavior.
3. Only proceed to Step 0.5 (triage) if you confirm an actual error occurred.

This gate exists because sycophantic acceptance of false corrections produces false memories and pollutes the process artifact system. A retrospective built on a wrong premise is worse than no retrospective.

### Step 0.5: Triage — determine the appropriate response level

Before running the full retrospective, classify the severity of the failure:

**Minor correction** — A one-off mistake with a clear, isolated fix (e.g., wrong file path, syntax error, missed detail not indicative of a process gap):

- Acknowledge the error type briefly (one sentence)
- Apply the fix
- If this represents a new pattern not previously seen, save a memory entry for it
- Do NOT run the full retrospective — it would be disproportionate

**Process failure** — A pattern-level failure, a missed required step, or a structural issue (e.g., skipped a verification step, used wrong tool category, failed to follow a documented protocol):

- Run the full 6-step retrospective (Steps 1–6 below)

**Repeated failure** — The same feedback has been given before, or the user uses escalation language ("I've told you this", "you keep doing this", "again?"):

- Run the full retrospective with urgency
- The previous fix was clearly insufficient — this iteration MUST produce more aggressive structural enforcement
- Prefer hooks over CLAUDE.md rules, skill steps over memory entries, automated checks over manual protocols
- The output must include an explicit "Escalation" section explaining why the prior fix failed and how the new fix is more structural

If uncertain between triage levels, err toward the higher level.

---

### 1. Identify the incident

State concretely what went wrong. Not "something was missed" but the specific items, with file paths and evidence. If the incident spans multiple items, list each one.

### 2. Categorize the failure mode

**2a. Agent-level error taxonomy (cognitive error)**

First, classify what went wrong in the agent's reasoning. This explains WHAT the cognitive failure was:

- **Assumption Error** — Started with an incorrect premise (assumed X was true without verifying)
- **Instruction Error** — Misunderstood or skipped explicit requirements (the instruction was present but not followed correctly)
- **Context Error** — Failed to consider relevant information that was available (ignored context, prior memory, or related files)
- **Verification Error** — Failed to validate before proceeding (acted without checking, skipped a required confirmation step)
- **Tool Error** — Misused available tools or functions (wrong tool, wrong parameters, wrong sequencing)
- **Preference Error** — Failed to adhere to established user preferences (violated a known, documented preference)

**2b. Structural gap category**

Then classify the structural gap that allowed the error to occur. This explains WHY the system permitted it:

- **Verification gap** — Checked X but should have also checked Y. The verification step existed but its scope was too narrow.
- **Communication gap** — Instruction said X but the agent (or subagent) understood Y. The intent didn't survive the prompt boundary.
- **Process gap** — No step exists for checking X. The failure mode wasn't anticipated in the process design.
- **Enforcement gap** — A rule or policy exists but nothing enforces it. The right behavior requires memory/discipline instead of structure.
- **Scope gap** — Work was scoped by files/symbols instead of by behavior/concepts. Residue survived in adjacent code.

The agent error (2a) explains the proximate failure; the structural gap (2b) explains the systemic cause. Both must be addressed: fixing only one leaves the other a recurring risk.

### 3. Root cause analysis

Answer **why** the gap existed, not just **what** was missed. Dig one level deeper than the obvious:

- If a verification gap: Why was the scope drawn where it was? What assumption made the narrow scope seem sufficient?
- If a communication gap: What was ambiguous in the prompt? What context was the subagent missing?
- If a process gap: Was this failure mode foreseeable? What signal should have triggered adding the step?
- If an enforcement gap: Why does the rule rely on memory instead of structure? Can it be made structural?
- If a scope gap: What framing led to file-centric instead of behavior-centric scoping?

**Recurrence check**: After the initial root cause analysis, search memory for previous retrospectives or feedback entries about the same pattern:

- Use memory search or grep for keywords related to this failure type
- If a prior retrospective or feedback entry exists for the same pattern: the previous fix was insufficient. Analyze WHY it failed:
  - Was the fix behavioral instead of structural? (Required remembering rather than being enforced)
  - Was the scope too narrow? (Fixed a specific instance without addressing the pattern)
  - Was the fix in the wrong artifact? (e.g., a memory entry when a hook was needed)
- Repeated patterns MUST escalate to more aggressive enforcement: if a CLAUDE.md rule was the previous fix, this time it needs a hook, skill step, or automated check. Behavioral fixes that failed once will fail again.

### 4. Design fixes

For each root cause, propose a fix that is **structural, not behavioral**. Prefer changes that make the wrong thing hard over changes that require remembering the right thing.

Fix types by category:

- **Verification gap** — Add a step to the relevant skill (review-pr, verify-completion) or CLAUDE.md protocol
- **Communication gap** — Update subagent prompt templates or add explicit instructions to CLAUDE.md
- **Process gap** — Add a new protocol section to CLAUDE.md or a new step to an existing skill
- **Enforcement gap** — Convert the rule into a hook, a skill step, or a subagent identity trait
- **Scope gap** — Update task spec guidelines or removal PR protocol in CLAUDE.md

Each fix must name the specific artifact to change and the specific change.

### 5. Implement fixes

Make the changes. This typically means editing some combination of:

- `CLAUDE.md` — policy and protocol updates
- `.claude/skills/*/SKILL.md` — process step additions
- **Memory entries** — call `memory_create` to persist durable feedback (do NOT write to memory `.md` files)
- `.cursor/rules/*.mdc` — enforcement rules

Use sessions for any repo file changes. Call `memory_create` directly for persistent feedback entries — the memory system stores durably in the database, not in files.

### 6. Verify the fix

For each fix, answer: **Would this change have prevented the original failure?** Walk through the incident scenario with the new process in place. If the answer is "probably" instead of "yes", the fix isn't structural enough — iterate.

If this is a repeated failure, also answer: **Why will this fix succeed where the previous one failed?** If you cannot articulate the structural difference, the new fix is not sufficient.

## Output format

Present findings to the user as:

```markdown
## Retrospective: <short description>

### Triage

<Minor correction / Process failure / Repeated failure> — <one sentence rationale>

### Incident

<What went wrong, with specifics>

### Agent error (cognitive)

<Which error type from 2a, and why it applies>

### Failure mode: <structural category>

<Why this category fits>

### Root cause

<One level deeper than the obvious>

### Recurrence check

<Was this pattern seen before? If yes: why did the prior fix fail?>

### Fixes

1. **<artifact>**: <specific change> — prevents <failure mode> by <mechanism>
2. ...

### Verification

<Would each fix have caught the original failure?>
<If repeated failure: why will this fix succeed where the previous one failed?>
```

For minor corrections (Step 0 triage), use a compressed format:

```markdown
**Correction noted**: <error type, one sentence>
**Fix**: <what was changed>
**Memory saved**: <yes/no — new pattern?>
```

## Key principles

- **Structural over behavioral** — If a fix requires "remember to do X", it's not a fix. Make the environment enforce it.
- **One level deeper** — "We missed it" is not a root cause. WHY did the process design allow missing it?
- **Durable artifacts only** — Every fix must land in a file that persists across conversations (CLAUDE.md, skills, memory, rules). Chat-only conclusions evaporate.
- **No blame, only gaps** — The question is never "who messed up" but "what structural gap allowed the failure."
- **Escalate on recurrence** — If a pattern repeats, the fix tier must increase. Behavioral → CLAUDE.md → skill step → hook. The same fix tier applied twice will fail twice.
- **Proportionate response** — Minor one-off corrections don't warrant a full retrospective. Reserve the full process for structural and repeated failures.
- **Connected to Minsky philosophy** — This is variety management (Ashby). A failure means the verification's variety was insufficient to match the codebase's complexity. The fix amplifies regulatory variety.
