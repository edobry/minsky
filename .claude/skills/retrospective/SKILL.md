---
name: retrospective
description: >-
  Structured post-failure analysis that identifies root causes and produces
  durable fixes to process artifacts. Auto-triggers on user-side correction
  signals ("that's wrong", "you keep doing this", "why did you do that?") AND
  on agent self-recognized failure signals ("I owe you an apology", "I was
  wrong about X", "I should have caught this", "I anchored on X and missed Y",
  "I didn't think it through") — match by meaning, not literal string. Use
  when a post-merge audit finds issues, the same feedback is given repeatedly,
  a subagent produces incomplete work, or the user asks "what went wrong" /
  "retrospective" / "why does this keep happening".
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
- **Auto-trigger on user-side correction signals** (no explicit invocation required):
  - Direct correction: "that's wrong", "incorrect", "not right", "that's not what I said"
  - Frustration indicators: "you keep doing this", "I've told you this before", "again?", "how many times"
  - Preference directives: "going forward, always...", "from now on...", "I want you to always..."
  - Rationale questions: "why did you do that?", "what were you thinking?", "why would you..."
  - Agent error requiring user intervention: when your own action caused an error the user had to correct
- **Auto-trigger on agent self-recognized failure signals** (no explicit invocation required; **match by _meaning_, not literal string** — the lists below are illustrative, NOT exhaustive):

  - Apology / contrition: "I owe you an apology", "I apologize for X", "that was my fault"
  - Wrong-recommendation admission: "I was wrong about X", "my recommendation was incorrect", "I made a mistake on X"
  - Should-have-caught: "I should have caught this", "I should have known better", "I should have thought of that", "I missed the obvious"
  - Anchoring / conflation: "I anchored on X and missed Y", "I conflated A with B"
  - Operational / explanatory prose (R2 extension, 2026-05-18): "I didn't think it through", "I didn't think through X", "I went straight to X without checking Y", "I defaulted to Z because I didn't pause to consider W"
  - Future-behavior commitment without durable encoding (R3 extension, 2026-05-21): "going forward I will X", "next time I'll Y", "from now on I'll Z", "future me will W", "I should retry / surface / check Y from now on", "I'll be more careful about V". These are not failure admissions but _forward-looking commitments to behavior change_. They are anti-patterns because verbal commitments evaporate at end of turn — the next session has no memory of them. The trained response when a user expresses frustration is exactly this phrase shape (apologize + commit), which bypasses the durable-encoding step. The parent rule is `Work Completion §Process corrections require structural fixes`; without this trigger category that rule fires only on memory-recall, which has demonstrably failed (see memory `34ca81be` for the originating recurrence — agent told user "going forward I will retry or surface" after a Claude Code bug analysis without taking ANY structural action; user had to push back to surface the gap).

  **When you are about to write any of these phrases (or a semantic variant) in user-facing output: STOP before the phrase lands.** Invoke the retrospective process and produce durable artifacts (root-cause analysis, memory entry, structural fix) FIRST — then either skip the apology entirely or reduce it to one sentence with the artifacts presented first. Apology language is performative; it does not produce a durable fix. The user does not need the apology — the user needs the same failure not to happen again. Artifacts achieve that; apologies don't.

  **The R3 future-commitment category has an additional requirement beyond the apology/contrition pattern:** when the trigger phrase IS a future-behavior commitment ("going forward I will X"), the durable artifact MUST encode the future behavior in a way that survives session-end (memory entry, skill edit, hook, rule update — NOT a chat-only commitment). Saying it without encoding it is equivalent to not saying it. If the encoding can't be done now (e.g., MCP transport is broken), file a task with the encoding instructions so the next session can complete it; the task IS the durable artifact in that case.

  This is the failure-direction dual of `User Preferences §Professional communication`'s ban on performative credit-language ("You're absolutely right", "Perfect!"). Both substitute language for action. The parent rule is `Work Completion §Never notice an issue without acting on it`: mentioning a self-recognized failure without producing a durable artifact is the same anti-pattern as noticing-without-acting. See memory `feedback_self_recognized_failure_is_retrospective_trigger` (id `1b36a19e`) for the canonical trigger-phrase list (updated continuously; pull from the memory at trigger time, not from this skill body) and the full R2 semantic-family rule.

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

- **Verification gap** — Add a step to the relevant skill (review-pr, auditor) or CLAUDE.md protocol
- **Communication gap** — Update subagent prompt templates or add explicit instructions to CLAUDE.md
- **Process gap** — Add a new protocol section to CLAUDE.md or a new step to an existing skill
- **Enforcement gap** — Convert the rule into a hook, a skill step, or a subagent identity trait
- **Scope gap** — Update task spec guidelines or removal PR protocol in CLAUDE.md

Each fix must name the specific artifact to change and the specific change.

### 5. Implement fixes

Make the changes. This typically means editing some combination of:

- `CLAUDE.md` — policy and protocol updates
- `.claude/skills/*/SKILL.md` — process step additions
- **Memory entries** — call `mcp__minsky__memory_create` to persist durable feedback. The Minsky DB is the canonical store; **do not** write to `~/.claude/projects/.../memory/*.md` files (per `memory-usage` rule).
- `.minsky/rules/*.mdc` — enforcement rules (Minsky-native source; `.cursor/rules/` is a compiled output)

Use sessions for any repo file changes. Call `mcp__minsky__memory_create` directly for persistent feedback entries — the memory system stores durably in the Minsky DB, not in files.

**Tier choice — file structural task NOW vs memory bridge only**

Before saving a memory entry as the implementation, decide whether the structural fix's shape is already clear:

- **Decision criterion**: if you can name the file/tool/skill that needs to change AND describe the specific change required, the shape IS clear. If you can only name the symptom or the rough direction, the shape is NOT clear yet.

- **Shape is clear** → file the tool/skill/rule task immediately (`tasks_create` / canonical `mcp__minsky__tasks_create`) AND save the memory entry as a bridge until that task ships. Do not defer task-filing to "later this session" or "if the pattern recurs" — the structural task is the durable fix, and the memory exists only to cover the gap until it lands. Before saving the bridge memory, search memory for an existing entry on the same pattern (`mcp__minsky__memory_search`); if one exists, update it with the new task ID rather than creating a near-duplicate.

- **Shape is unclear** → memory tier alone is acceptable while you investigate. The memory entry should record what you DID see (the symptom) and an explicit "fix shape unknown — investigation needed" note so a future agent recognizes it as bridge-only, not the resolution.

The default until the 2026-04-26 meta-retrospective was "save memory, file structural task only after recurrence." That cost 12-24h per pattern. Reference: Notion incident memo `34e937f03cb4813c8046c6e00cb668f2` ("Mitigation-tier inversion") — of four pattern-fixes that day, only one (session_update force-push, mt#1304) followed the corrected sequence; the other three (verify-script-not-run, parallel-work, reviewer-bot misreads) waited 1-2+ days before the structural task was filed, and the failure mode recurred in the meantime.

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
