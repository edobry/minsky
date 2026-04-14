---
name: retrospective
description: >-
  Structured post-failure analysis that identifies root causes and produces
  durable fixes to process artifacts. Use when a post-merge audit finds issues,
  the same feedback is given repeatedly, a subagent produces incomplete work,
  or the user asks "what went wrong" / "retrospective" / "why does this keep happening".
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

## Process

### 1. Identify the incident

State concretely what went wrong. Not "something was missed" but the specific items, with file paths and evidence. If the incident spans multiple items, list each one.

### 2. Categorize the failure mode

Every process failure falls into one or more of these categories:

- **Verification gap** — Checked X but should have also checked Y. The verification step existed but its scope was too narrow.
- **Communication gap** — Instruction said X but the agent (or subagent) understood Y. The intent didn't survive the prompt boundary.
- **Process gap** — No step exists for checking X. The failure mode wasn't anticipated in the process design.
- **Enforcement gap** — A rule or policy exists but nothing enforces it. The right behavior requires memory/discipline instead of structure.
- **Scope gap** — Work was scoped by files/symbols instead of by behavior/concepts. Residue survived in adjacent code.

Categorize precisely — the fix depends on the category.

### 3. Root cause analysis

Answer **why** the gap existed, not just **what** was missed. Dig one level deeper than the obvious:

- If a verification gap: Why was the scope drawn where it was? What assumption made the narrow scope seem sufficient?
- If a communication gap: What was ambiguous in the prompt? What context was the subagent missing?
- If a process gap: Was this failure mode foreseeable? What signal should have triggered adding the step?
- If an enforcement gap: Why does the rule rely on memory instead of structure? Can it be made structural?
- If a scope gap: What framing led to file-centric instead of behavior-centric scoping?

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
- Memory files — feedback entries for future conversations
- `.cursor/rules/*.mdc` — enforcement rules

Use sessions for any repo file changes. Memory updates can be done directly.

### 6. Verify the fix

For each fix, answer: **Would this change have prevented the original failure?** Walk through the incident scenario with the new process in place. If the answer is "probably" instead of "yes", the fix isn't structural enough — iterate.

## Output format

Present findings to the user as:

```markdown
## Retrospective: <short description>

### Incident

<What went wrong, with specifics>

### Failure mode: <category>

<Why this category fits>

### Root cause

<One level deeper than the obvious>

### Fixes

1. **<artifact>**: <specific change> — prevents <failure mode> by <mechanism>
2. ...

### Verification

<Would each fix have caught the original failure?>
```

## Key principles

- **Structural over behavioral** — If a fix requires "remember to do X", it's not a fix. Make the environment enforce it.
- **One level deeper** — "We missed it" is not a root cause. WHY did the process design allow missing it?
- **Durable artifacts only** — Every fix must land in a file that persists across conversations (CLAUDE.md, skills, memory, rules). Chat-only conclusions evaporate.
- **No blame, only gaps** — The question is never "who messed up" but "what structural gap allowed the failure."
- **Connected to Minsky philosophy** — This is variety management (Ashby). A failure means the verification's variety was insufficient to match the codebase's complexity. The fix amplifies regulatory variety.
