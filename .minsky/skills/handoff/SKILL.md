---
name: handoff
description: >-
  Produce a structured end-of-conversation handoff summary so the next agent (or
  future-you) can resume cleanly. Use when the user asks for "a summary,"
  "handoff," "what we did," "where do we resume." Auto-trigger when the
  conversation has shipped 3+ PRs, hit multiple MCP disconnects, run multiple
  retrospectives, or compaction is approaching.
user-invocable: true
---

# Handoff Skill

Produces a standardized end-of-conversation summary capturing motivation, shipped work, queued work, process artifacts, and recommended next sessions. Distinct from `/retrospective` (failure analysis) and `/incident-memo` (multi-incident synthesis): handoff is the multi-success state-capture for resumption.

The structured payload (work queue: task ids + statuses + next actions + operational notes) is
persisted as a durable memory record (mt#2827); chat only ever shows a pointer to that record
plus a plain-markdown human summary — the chat prose is advisory, never the source of truth.

## Arguments

Optional: a hint about what to focus on (e.g., "for next agent," "summarize the bypass cluster"). If omitted, summarize the entire current conversation.

## When to invoke

- **Explicit user requests**: "handoff," "summary," "what did we do," "where do we resume," "give me a status," "produce a handoff for the next agent"
- **Auto-trigger signals** (no explicit invocation needed):
  - Conversation has shipped **3+ PRs** in this session
  - Conversation has run **2+ retrospectives**
  - Conversation has hit **2+ MCP disconnects** (operational friction signal)
  - Compaction warning fires or context-density indicators surface
  - User signals end-of-session intent ("stopping here," "let's pick this up later," "I need to step away")
- **Skip** if the conversation is short and single-purpose (one PR shipped, one task done) — a normal end-of-turn summary suffices, not a full handoff.

## Process

### 1. Identify the original motivation

What triggered this conversation? Quote or paraphrase the user's first substantive ask. Lead the handoff with this — it gives the next agent the "why" before the "what."

### 2. Survey shipped work

Walk the conversation for:

- **Tasks transitioned to DONE** or IN-REVIEW with merged PRs — list with task ID, title, and merged PR number
- **PRs merged** — by PR number, with merge commit hash if visible
- **Status changes** of importance (TODO → READY escalations, BLOCKED → unblocked)
- **Production-effective deliverables** — services restarted, env vars set, infrastructure changed

List format: one `-` bullet per item — task ID, status, what shipped. Handoff chat output
never uses pipe (`|`) tables; see `## Output format` below for why.

### 3. Survey process artifacts

Durable changes that aren't code:

- New / updated **memory entries** (`feedback_*`, `project_*`)
- New / updated **CLAUDE.md or `.minsky/rules/*.mdc` rules**
- **Notion memos** posted (with URL)
- **Skills added or modified** under `.claude/skills/`

These survive the conversation; the next agent reads them automatically. Calling them out reminds the user what changed in the system, not just in the codebase.

### 4. Survey queued work

Tasks filed but not implemented in this conversation:

- **TODO** — newly filed, not yet planned
- **PLANNING** — being investigated, not yet ready to implement
- **READY** — bumped or filed-as-ready, awaiting `/implement-task`
- **IN-REVIEW** — PR open, awaiting merge or further iteration

For each, name the task ID, status, and one-sentence scope. Do NOT exhaustively list pre-existing tasks unrelated to this conversation.

### 5. Identify open threads

What's mid-flight or unresolved?

- PRs awaiting review or merge
- Tasks awaiting `/verify-task` to transition IN-REVIEW → DONE
- Investigations that surfaced a problem but didn't fix it
- Spec calibrations the user might want to review before implementation

**Ask-or-cite-ask for principal-gated threads (mt#2471).** If an open thread is gated on a
**principal-owned decision** (architectural direction, scope, framework, naming — the kinds
`humility.mdc` reserves for the principal), do NOT surface it as chat prose ("X needs your
call", "that decision is yours") and end the handoff. Route it through the Ask substrate:
file it via `mcp__minsky__asks_create` (kind `direction.decide`, packaged per
`humility.mdc §Escalation packaging`) OR cite the id of an existing open ask. Chat prose
evaporates and never reaches the attention surface; an ask persists and is answerable on the
cockpit `/ask` surface. (For a non-principal next-step a lookup or standing default resolves,
that's a normal "Suggested next sessions" entry, not an ask.) This is the handoff enforcement
of the escalation-packaging family (memory `3e3f29d8`; R4 2026-06-12 was an end-of-session
handoff that named the mt#2372 lens decision in prose with no ask).

### 6. Recommend next sessions

In **priority order**, list 1-4 specific next-session kickoffs. Each entry:

- The exact slash command (`/implement-task mt#X`, `/plan-task mt#Y`, etc.)
- One-line rationale ("highest leverage; closes the silent-failure detection gap")

Order by impact, not by task ID. The first item should be the one you'd start with if you only had time for one.

### 7. Recommend resume location

State explicitly: **resume in same conversation OR new session.** Apply this rule:

- **Resume in new session if** any of: conversation has 4+ PRs merged, 2+ MCP disconnects, 2+ retrospectives, compaction warnings, or fresh task scope (different concern from current work)
- **Continue same session if** none of the above AND there's a specific cheap continuation (one more commit on an open PR, one verify-task transition)

When in doubt, recommend new session. Cost of fresh-context restart is low; cost of context-collapse mid-action is high.

### 8. Write the durable payload

Before rendering anything to chat, call `mcp__minsky__memory_create` (type `"project"`) to
persist the full structured handoff payload — this is the durable, machine-checkable artifact;
chat prose is advisory only, per the Plan decision recorded in mt#2827.

- `name`: a short slug, e.g. `handoff_<cluster-slug>_<date>`
- `description`: one-line summary of the cluster
- `content`: the full payload from steps 1-7 above (motivation, shipped work, process
  artifacts, queued work with task ids + statuses + next actions, open threads, recommended
  next sessions, resume recommendation) as plain markdown — same no-tables discipline as chat
  output (see step 9)
- `tags`: include `handoff` plus every task ID touched (e.g. `mt#2827`)

Capture the returned memory `id` (uuid) — the chat pointer in step 9 links to it.

### 9. Render chat output: pointer + summary, no tables

Chat output is a **pointer plus a compact human summary** — never the full payload restated,
and never a substitute for the durable record written in step 8. Render:

1. A `minsky://memory/<uuid>` deeplink to the memory entry from step 8, per
   `cockpit-deeplinks.mdc` (label: a short readable description, not the raw uuid).
2. A **plain-markdown** summary per `## Output format` below — headings and `-` bullet lists
   only. **Never render a pipe (`|`) table or Unicode box-drawing characters anywhere in
   handoff chat output** — see "Why no tables" in `## Output format`.

## Output format

Lead with the durable-artifact pointer from step 8, then the plain-markdown summary. Use this
exact structure:

```markdown
Handoff recorded: [<short cluster description>](minsky://memory/<uuid>)

## Handoff — <short cluster description> (<date range>)

### Original motivation

<quoted or paraphrased first substantive user ask>

### What shipped (production-effective)

- **mt#X** task description (PR #N) — what changed
- **mt#Y** ...

### Process artifacts landed

- New rules: ...
- New / updated memory entries: ...
- Notion memos: ...

### Queued (filed, not implemented)

- **mt#X** — READY — <one-sentence scope>
- **mt#Y** — TODO — <one-sentence scope>

### Open threads

- ...

### Suggested next sessions, in priority order

1. **`/implement-task mt#X`** — rationale
2. **`/implement-task mt#Y`** — rationale

### Resume recommendation

<same session | new session> because <2-3 specific signals>
```

For shorter conversations (1-2 PRs, no retrospectives), compress to:

```markdown
Handoff recorded: [<short cluster description>](minsky://memory/<uuid>)

**Shipped:** mt#X (PR #N), ...
**Queued:** mt#Y (READY) ...
**Next:** `/implement-task mt#Y`
**Resume:** <same | new>
```

**Why no tables (mt#2827).** Evidence from conversation 2c9ac5e6: a pasted handoff's queued-work
table arrived with cells truncated mid-word ("e Minsky-actor via", "Pl runs the", "Ue recurs in
8+") — content lost to terminal-width wrapping during generation or paste, and consumed as-is
with no integrity signal at either end. A pipe (`|`) table (and the Unicode box-drawing borders
a terminal UI may substitute when rendering one) wraps unpredictably at narrow terminal widths;
cells split mid-word with no visible marker that anything was lost. A `-` bullet list degrades
to ordinary line-wrapping instead, which is visually recoverable and doesn't silently truncate
content. **Never render a `|`-delimited table or Unicode box-drawing characters (the "Box
Drawing" Unicode block, U+2500-U+257F — the glyphs used to draw table borders and box outlines)
anywhere in handoff chat output** — this is why steps 8-9 above make the memory entry, not the
chat table, the authoritative record.

## Continuation guidance (for the receiving conversation)

A fresh conversation (or future-you) picking up a handoff should not trust the pasted chat
prose as the source of truth — it is advisory only, per the Plan decision recorded in mt#2827.
Instead:

1. **Dereference the pointer.** Call `mcp__minsky__memory_get` with the id from the
   `minsky://memory/<uuid>` link (or the id-prefix cited in pasted prose, per `## Citing
uuid-keyed records` below) to fetch the full structured payload written in step 8 — not the
   chat summary.
2. **Re-derive statuses live — don't trust the pasted table or the memory snapshot's status
   field.** Both may be stale (superseded by work that happened after the handoff was written)
   or, for pasted prose, corrupted by paste/terminal-wrap. Call `mcp__minsky__refs_status` with
   the full list of task ids / PR numbers / ask ids from the memory payload — one call
   re-validates the whole queue against live state (task status, PR merge state, ask response
   state) in a single round trip — or `mcp__minsky__tasks_status_get` per task id if only task
   statuses are needed.
3. **Proceed from the live-verified queue**, not from the memory payload's status snapshot or
   any pasted-prose summary.

This makes a corrupted or partial paste recoverable by construction: the pointer alone —
`memory_get` followed by `refs_status` — reconstructs the full, currently-accurate work queue,
independent of whatever text actually survived into the chat.

## Anti-patterns

- **Don't include investigation logs.** The conversation has the journey; the handoff has the destination. Raw debug output, MCP errors, dismissed reviewer findings — all noise for the next agent.
- **Don't enumerate every task in the system.** Only tasks this conversation touched (filed, edited, merged, escalated). The reader can `tasks_list` for the rest.
- **Don't editorialize the work.** "We did great work today" is editorial. "mt#1556 + mt#1558 merged; reviewer service is healthy" is factual.
- **Don't repeat the retrospective.** If the conversation ran a retrospective, link to where it was produced (in chat or in Notion); don't re-narrate the analysis.
- **Don't speculate about next steps the user hasn't endorsed.** Recommend "the work that's filed and READY," not "things I think we should also do."
- **Don't render pipe tables or box-drawing characters.** A `|`-delimited markdown table (or the
  Unicode box-drawing a terminal UI may render one as) wraps unpredictably and can truncate
  cells mid-word with no visible integrity signal (see `## Output format`'s "Why no tables").
  Use `-` bullet lists for every section, including the queued-work list.
- **Don't end with a question.** The handoff is a state document. If a question is needed, it goes in a separate turn.

## Key principles

- **Audience: the next agent (or future-you), cold start.** Write so a fresh context can pick up without rereading the conversation. Cite task IDs and file paths concretely.
- **State, not narrative.** What IS, not what HAPPENED. Past-tense "shipped" is OK; "we then decided to..." is not.
- **Tight is better than complete.** A 200-line handoff is unread. A 60-line handoff is consulted. Default to compression; expand only when the cluster is genuinely complex.
- **Cite durable artifacts by path.** "memory entry `feedback_X`" not "the memory we updated." "CLAUDE.md `Recovery layer spec discipline` section" not "the new rule."
- **Recommendation, not menu.** "Start with `/implement-task mt#1310`" is actionable. "Here are the open tasks" is a tasks-list copy.
- **Handoff is a distinct artifact from a normal turn-end report.** A short conversation (1-2 PRs, no retrospectives) that doesn't meet this skill's auto-trigger thresholds should still close with a Tier-1 turn-end report per `communication-contract.mdc` (BLUF: what happened / what you need to know / what's next) — not a compressed handoff. Invoke this skill's full structure only when the auto-trigger signals above actually fire.

## Citing uuid-keyed records (mt#2696)

Memories and Asks are keyed by Postgres `uuid` primary keys, not by a stable name
like a task ID or a rule section. When a handoff cites one — a memory entry
without a `feedback_*`/`project_*` name, or an open/pending Ask — the id form
used in the citation determines whether the next agent can actually
dereference it:

- **MUST** carry either the **full UUID** or an **id form the get/lookup
  tools resolve** — post-mt#2696, `memory_get`, `asks_respond`, `asks_edit`,
  and `asks_wait-for-response` all resolve an unambiguous hex-prefix to the
  full record (unique match), a clean not-found error (no match), or an
  ambiguity error listing candidates (2+ matches) — never a raw Postgres
  `invalid input syntax for type uuid` crash.
- **Author handoffs with an 8-hex-char prefix** (git-short-SHA style, e.g.
  `d8591800`) as the citation convention — this is deliberately a
  **handoff-authoring convention for collision safety**, independent of
  the resolver's technical floor. The resolver's minimum accepted prefix
  length is a configurable parameter (`resolveIdPrefix`'s
  `minPrefixLength`, `MIN_ID_PREFIX_LENGTH` in
  `packages/domain/src/utils/id-prefix-resolver.ts`, currently defaulted to
  8 at every call site this skill's tools use) — do not treat 8 as a
  load-bearing technical constant when writing handoffs; treat it as "long
  enough that a collision within one project's memory/ask corpus is
  vanishingly unlikely," which just happens to currently coincide with the
  resolver's default floor. A shorter prefix may still resolve (if
  unambiguous) or may be rejected as too-short depending on the current
  floor — don't rely on that boundary; always author at 8+ hex chars.
- **SHOULD** carry the record's **name alongside** the id (a memory's `name`
  field, an Ask's `title`) as a search fallback — if the id somehow doesn't
  resolve (rotated, deleted, or the prefix collides after this skill was
  read), the name lets the next agent fall back to `memory_search` /
  `asks_list` instead of a cold-start dead end.

Example: `memory d8591800 (wave-orchestration-pattern)` — resolvable id +
name fallback — not the bare `memory d8591800` this skill produced before
mt#2696, and not just `the wave-orchestration memory` (no id at all).

## Origin

Filed 2026-05-05 as mt#1580 from a long working session (2026-05-02 → 2026-05-05 reviewer-outage cluster) where the user asked for a handoff summary 4-5 times ad-hoc. The patterns above were the ones that converged after iteration. The skill standardizes them so future requests don't require re-prompting for the same shape.
