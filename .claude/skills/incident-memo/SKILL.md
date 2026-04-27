---
name: incident-memo
description: >-
  Synthesis-level postmortem for a multi-incident working session. Triggered
  when the session has produced 2 or more retrospectives, merged 3 or more
  PRs, or the user explicitly asks for an incident memo / day synthesis /
  meta-retrospective. Distinct from the retrospective skill (per-incident);
  this skill operates at the cross-incident layer and produces a Notion page
  + companion memory entry.
user-invocable: true
---

# Incident Memo Skill

Cross-incident synthesis postmortem. Produces a Notion page that captures the day's pattern-level lessons and a companion memory entry that distills the synthesis-level lesson into agent-loadable form.

This is **not** a retrospective. The retrospective skill operates per-incident and produces structural fixes. This skill operates over a session of multiple incidents and produces synthesis-level lessons and meta-patterns that wouldn't survive in any single task spec.

## Arguments

Optional: a date string (e.g., `2026-04-26`) or a one-line description of the working window. If omitted, the skill uses the current date and analyzes the conversation history of the active session.

## When to invoke

Invoke at the **end** of a working session, AFTER the per-incident retrospectives have run. Triggers:

- **Volume threshold**: the session produced 2 or more retrospectives, OR merged 3 or more PRs, OR closed/filed 5 or more tasks in a single working window.
- **Explicit user request**: "write incident memo", "synthesize today", "meta-retrospective", "what's the lesson from today", "day postmortem".
- **Cross-pattern signal**: even with 1 retrospective, if the day had multiple incidents that share a structural property (e.g., all three were silent-failure operations), the synthesis is worth capturing.

Do NOT auto-trigger this skill on a single retrospective; that's the retrospective skill's domain. Do NOT skip per-incident retrospectives in favor of an end-of-day memo — both layers are needed.

## Distinction from retrospective skill

| Aspect                    | retrospective                                     | incident-memo                          |
| ------------------------- | ------------------------------------------------- | -------------------------------------- |
| Cadence                   | Per-incident (immediate)                          | End-of-session (deferred)              |
| Scope                     | One failure                                       | Multiple incidents in a working window |
| Output (durable artifact) | Hooks, skills, rules, memory entry                | Notion page + memory entry             |
| Output (insight)          | Specific structural fix                           | Cross-pattern lesson, meta-patterns    |
| Trigger                   | A correction signal or single-failure observation | Volume threshold or explicit request   |

A per-incident retrospective answers "what gap allowed THIS failure?" An incident memo answers "what design lens unifies the failures we saw, and what does it imply prospectively?"

## The four lenses

Apply each lens to the session's incidents. Each lens surfaces a different kind of meta-pattern; together they produce the synthesis-level lesson.

### 1. Cross-pattern lens

Find the structural property all the incidents share. Not the surface category ("they were all tool errors") but the underlying invariant violation ("every one was a state-mutating operation that returned `success` while silently violating an invariant").

The cross-pattern lesson is usually the most valuable output — it generalizes to operations the session didn't see but will encounter later.

Prompt yourself: across these N incidents, what is the structural commonality? What design lens would have prevented all of them prospectively?

### 2. Mitigation-tier lens

For each pattern-fix shipped or filed today, ask: was the chosen tier (memory / skill step / rule / tool fix) the right one given what was knowable at retrospective time?

The retrospective skill's tier-choice subsection already addresses this prospectively. The memo lens is retrospective: count how many fixes followed correct tier choice and how many waited unnecessarily in a lower tier. The ratio is a session-level health metric.

### 3. Collision lens

What parallel work happened? Did multiple agents independently notice the same problem? Did sibling-task merges produce conflicts? Did your own session's sub-PRs collide?

Collisions are usually a signal that the trigger condition is widely visible (a recent outage, a public defect, a hot-path migration). The memo records the collision count and any de-conflict mechanism that was used (e.g., `tasks_search` before `tasks_create`).

### 4. Discovery lens

How were the day's defects detected? By scheduled probes, by alerts, by user attention, by accidental observation while doing something else?

If most defects were found by accident, the system has a continuous-detection gap. The memo names that gap explicitly. Concrete fixes (e.g., a periodic uptime probe, a sweeper, a hook-tier check) belong in followup tasks, but naming the gap is what makes them visible.

## Process

### Step 1: Gather inputs

Collect from the working window:

- **Retrospectives**: every retrospective that ran (incident, root cause, fix tier).
- **PRs merged**: titles, task IDs, what shipped.
- **Tasks filed**: followups created (title, parent task, why filed).
- **Memories saved or updated**: durable feedback entries from this window.
- **Process artifacts changed**: skills, rules, hooks, CLAUDE.md edits.
- **External effects**: outages, deploys, recoveries (with timestamps).

If the working window spans multiple sessions or there is shared-context across agents, pull from PR descriptions and the Minsky session log via `mcp__minsky__session_list` (filter by `since`/`until`).

### Step 2: Apply the four lenses

For each lens, write 1-3 sentences naming the pattern. If a lens turns up nothing, mark it explicitly as `(no signal)` rather than skipping — the absence is informative.

### Step 3: Distill the synthesis-level lesson

In one paragraph, name the design lens that unifies the day's incidents. The lesson should:

- Generalize beyond the specific incidents (apply prospectively to operations the session didn't see).
- Be specific enough to be falsifiable / actionable (not "be more careful" — name a property of operations or a decision criterion).
- Connect to existing project theory if applicable (variety management, receipts, regulatory feedback).

This paragraph is the most important output of the skill. If the synthesis-level lesson isn't novel or actionable, the memo isn't worth writing.

### Step 4: Write the Notion page

Page title: `Incident memo: <YYYY-MM-DD> — <one-line synthesis>`

Parent: the project workspace home page (for Minsky, the parent is `33a937f03cb48197a93ecd4a98a94261`; verify the current parent via `mcp__plugin_Notion_notion__notion-fetch` on the workspace home before creating).

Sections (in order):

1. **TL;DR** — what happened in the working window, what shipped, what filed (1 paragraph).
2. **The synthesis-level lesson** — the lens from Step 3.
3. **Timeline** — UTC-stamped events (latent bugs, ship/merge points, detection points, fix points).
4. **What shipped** — table of PR # / Task / Description.
5. **Followup tasks filed** — list with one-line context per task.
6. **Process artifacts added** — skills, rules, hooks, memory entries.
7. **Meta-patterns the day surfaced** — one subsection per lens that found a signal (not all four are required to fire).
8. **Adjacent observations** — orthogonal but notable patterns the day exposed (bot misreads, retention windows, ecosystem behavior).
9. **Open questions** — what the day's evidence couldn't settle but should be revisited.
10. **Cross-references** — memories, tasks, project pages, related Minsky theory pages.

Use `mcp__plugin_Notion_notion__notion-create-pages` with the project workspace as parent.

### Step 5: Write the companion memory entry

Distill the synthesis-level lesson into a single memory entry. The Notion page is for human readers; the memory entry is so the lesson loads into agent context for future sessions.

Memory entry structure:

- **Type**: `feedback` (the lesson is durable guidance, not project state).
- **Name**: short and descriptive (e.g., `feedback_state_mutations_need_verifiable_receipts`).
- **Body**: lead with the rule, then **Why:** (incidents that surfaced it, link to memo) and **How to apply:** (when this rule should fire prospectively).

Both outputs ship — Notion page AND memory entry. Not one or the other.

### Step 6: Cross-link

In the memory entry, reference the Notion memo ID. In the Notion memo's Cross-references section, name the memory entry. In any new task specs filed during the session that the memo references, mention the memo ID.

## Output to user

After both artifacts are created, report to the user:

```markdown
## Incident memo: <date> — <synthesis>

**Notion page**: <URL>
**Memory entry**: <name>

### Synthesis-level lesson

<paragraph>

### Lenses that fired

- Cross-pattern: <one-line>
- Mitigation-tier: <one-line or "no signal">
- Collision: <one-line or "no signal">
- Discovery: <one-line or "no signal">

### What shipped, what filed

- <count> PRs merged, <count> tasks filed, <count> memory entries added.
```

Keep the agent-facing report short. The Notion page is the long-form artifact.

## Key principles

- **Synthesis over enumeration** — the memo's value is the cross-pattern lesson, not the list of incidents. If you can't write the lesson paragraph, the memo isn't ready.
- **Both artifacts ship** — Notion (human-readable) AND memory entry (agent-loadable). The retrospective skill produces structural fixes; this skill produces the lens through which future fixes are designed.
- **Don't replace per-incident retrospectives** — the per-incident layer still happens. This skill is invoked AFTER, not instead.
- **Trigger conservatively** — a single retrospective doesn't justify an incident memo. Wait for the volume threshold or the explicit ask. Premature memos dilute the artifact.
- **Connected to Minsky philosophy** — the memo layer is a higher-order cybernetic feedback channel. Per-incident retrospectives regulate against specific failure modes; cross-incident memos regulate against design-pattern blind spots.

## Reference

- The 2026-04-26 incident memo (Notion `34e937f03cb4813c8046c6e00cb668f2`, "silent state-mutations and the cost of missing receipts") is the canonical template; consult it for section voice and depth before writing a new memo.
- Companion memory entry shape: `feedback_state_mutations_need_verifiable_receipts` is the example synthesis-level memory output (one rule, **Why:** linking the incidents, **How to apply:** the prospective design lens).
