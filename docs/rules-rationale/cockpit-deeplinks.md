# Cockpit Deeplinks in Terminal Output — extended rationale

> Extracted from `.minsky/rules/cockpit-deeplinks.mdc` (mt#3087 corpus trim, Phase 4). The
> compiled rule corpus carries the format instruction, the entity-type table, and the format
> rules in full; this file holds the mechanism detail and dependency notes. Nothing here changes
> agent behavior — the directive text in the rule is the complete behavioral contract.

## Renderer mechanism and the Surface A/B split

Claude Code's renderer turns `[label](minsky://...)` into an OSC-8 terminal hyperlink; macOS
terminals pass `minsky://` to `open`, and the cockpit-tray scheme handler (mt#2528) routes it to
the cockpit — **launching the cockpit first if it is not running**. So always emit the link;
never gate on whether the cockpit is currently open and never read cockpit state to decide.

**Dependency:** clickability requires the cockpit-tray app's `minsky://` OS scheme handler
(mt#2528) to be registered with the operating system. Where it is not — the tray app is not
installed, or the terminal is non-macOS / lacks OSC-8 — the link degrades to the plain label text
(which is why the label must always be a readable ref). This does NOT gate emission: emit the
link unconditionally and let it degrade gracefully.

This is Surface A (the terminal). Linking here is **agent discipline** — you emit the markdown by
hand. (Surface B, the in-cockpit transcript view, linkifies the same refs on its own side via
mt#2518.)

**That is a fact about today, not a permanent constraint — corrected 2026-08-04.** This paragraph
used to read "There is no harness hook that rewrites assistant output," which was true when
written and is now false: Claude Code's `MessageDisplay` hook (2.1.152+) does exactly that. The
stale sentence was load-bearing — mt#2565 inherited it as a settled premise and scoped itself
around a seam it assumed did not exist. Discipline remains the mechanism _until the hook is
built_ (mt#2565), not because no alternative exists. See
§The one-link-per-entity ration is provisional below for the evidence and the decision.

## Additional examples

- `Routed the decision to ask [38b1c0de](minsky://ask/38b1c0de-0000-0000-0000-000000000000).`
- `Merged [PR #1234](minsky://changeset/1234) — reviewer-bot approved.`

## The one-link-per-entity ration is provisional (mt#3459, decided 2026-08-04)

The rule's `§Format rules` line — _"Don't over-link ... One clickable ref per entity per message
is plenty"_ — was written for noise control and succeeds at that. It has a consequence nobody
priced in.

**The problem.** In a long turn, most references a reader actually lands on are the bare repeats
the rule permits, and in the terminal a bare `mt#2263` is clickable by nothing. Counted over one
long working session (conversation `1cbc32e1`, 2026-07-31): **31 markdown `minsky://` links
against 232 bare `mt#NNNN` mentions.** Not all 232 should be links — many are repeats the rule
correctly suppresses, many sit inside quoted spec text — but the ratio is the point. Which
mentions are clickable depends on where in the message they fall, not on whether the reader wants
to open that entity.

The principal raised it twice in one session, the second time as _"that's a bug, right?"_ — and
in the message being challenged the entity **was** linked on first mention and bare on its
second, i.e. fully compliant. A rule whose compliant output still reads as a defect to the person
it serves is worth re-examining rather than defending.

**The asymmetry underneath.** Bare short ids already auto-linkify in the **cockpit**: mt#3259 made
the linkifier recognize `mt#NNNN` / `mem#N` / `ask#N` / `ws#N` and resolve them against its
id-set, which is why the rule can tell authors a bare short id "is therefore clickable in the
cockpit without any markdown." The terminal has no such affordance, so the guidance compensates by
asking the agent to hand-emit markdown links — and then, to control the resulting noise, asks it
to ration them. The cockpit needs no explicit links at all; the terminal needs more of them than
the noise rule permits. The rule is carrying a gap in the surface.

**Options weighed.**

1. _Leave the rule; fix compliance only._ Cheapest, and it does not touch the reader's experience
   of landing mid-message on a bare ref.
2. _Link every mention, drop the noise rule._ Uniform, and it buys exactly the visual noise the
   current rule exists to prevent.
3. _Auto-linkify at the display surface_, as the cockpit already does. Removes the authoring rule's
   reason to exist rather than tuning it — and is the only option that stops this being the
   agent's job at all.

**Decision: option 3.** It was preferred on the merits and blocked only on feasibility, which is
now resolved in its favour.

**Feasibility, verified 2026-08-04.** Claude Code ships a `MessageDisplay` hook event that
transforms assistant message text as it is displayed. Checked against the installed client's own
changelog rather than a search summary: introduced in **2.1.152** — _"Added a `MessageDisplay`
hook event that lets hooks transform or hide assistant message text as it is displayed"_ — with
`claude --version` reporting **2.1.221**. A hook returns the replacement as
`hookSpecificOutput: { hookEventName: "MessageDisplay", displayContent: "..." }`.

The semantics are the ones this problem needs: `displayContent` is **display-only** — the vendor
docs state _"the transcript and what Claude sees keep the original."_ So the reader sees clickable
refs while the stored transcript keeps plain text, which is the same render-time model mt#3259
used on the cockpit side. That makes option 3 mechanically the cockpit's solution applied to a
second surface, not merely analogous to it.

**Two constraints the implementation inherits.**

- **Harness-specific.** `MessageDisplay` is a Claude Code affordance; other harnesses have none.
  The authoring guidance therefore cannot be deleted outright — it becomes "write the clean ref;
  the surface linkifies where it can." This is the same shape as the `memory-search.ts` bridge
  hook (CLAUDE.md §Memory Usage), and carries the same obligation under
  `work-completion.mdc §Temporary mechanism budget`: a tracking task and an escalation threshold.
- **Elision.** The linkifier must not rewrite refs inside code fences, inline code spans, or
  quoted spec text, and must not double-link an already-linked ref. `elideMarkdownContexts` in
  `.minsky/hooks/pre-narration-detector.ts` is the in-repo precedent for the first half: it blanks
  fenced blocks, inline spans and blockquotes with same-length whitespace, preserving character
  offsets — exactly what a position-based rewriter needs.

**Status.** The decision is recorded; the hook is not built. Until it ships the rule's line stands
as written, with the compliance half tightened: the first mention of an entity is always linked,
no exceptions. (The originating session also contained a genuine violation — an entity bare on its
FIRST mention — which is ordinary discipline, not a rule-design question, and needed no rule
change.)

### The noise tradeoff of the tightening, demonstrated

The rule DID change — "typically the first mention" became "the first mention of an entity is
always linked, no exceptions" — so the tradeoff is shown here rather than asserted. Same turn,
authored under each version:

**Under the old rule** ("typically the first mention" — a judgment call, so a first mention can
legitimately go bare when the author reads it as incidental):

```
Merged [mt#3198](minsky://task/mt%233198); the detector change also touches mt#2565's
scope, and mt#3286 may narrow once it lands. mt#3198's spec carries the evidence, and
mt#2565 is the follow-on.
```

Four distinct entities, one link. Three of the four are unclickable on their first appearance —
the exact experience that reads as "not linkified."

**Under the new rule** (first mention of each entity always linked; repeats stay bare):

```
Merged [mt#3198](minsky://task/mt%233198); the detector change also touches
[mt#2565](minsky://task/mt%232565)'s scope, and [mt#3286](minsky://task/mt%233286) may
narrow once it lands. mt#3198's spec carries the evidence, and mt#2565 is the follow-on.
```

Four links where there was one. **That is the cost, and it is the point:** the added density is
bounded by the number of DISTINCT entities in the message, not by the number of mentions — the
repeats in the second sentence stay bare under both versions. So the tightening cannot produce the
runaway link-soup option 2 would (link _every_ mention); it raises the floor from "however many
the author noticed" to "one per entity," which is the ration the rule always claimed to enforce
and did not.

**What it does not fix,** and why the display-surface decision above still stands: the repeats are
still bare, so a reader landing mid-message on the second `mt#3198` still cannot click it. The
tightening removes the arbitrariness; only the linkifier removes the problem.

## Cross-references

- mt#3459 — this decision; mt#3259 — the cockpit-side bare-short-id linkifier that is its precedent.
- mt#2517 — parent umbrella (cockpit deeplinks); mt#2519 — the compiled rule (Surface A / terminal).
- mt#2518 — Surface B (cockpit transcript linkifier) + the shared `(type,id) ↔ minsky:// URI ↔ path` codec this format matches.
- mt#2528 — the `minsky://` OS scheme handler in the cockpit-tray app (required for a terminal click to actually open the cockpit).
- mt#2535 — `/changeset/:id` cockpit detail route (ships the page the changeset URI navigates to).
- mt#2536 — PR/changeset linkification (adds `changeset` to RoutableEntityType + linkifier PR #N recognition).
- `docs/architecture/adr-022-session-vs-conversation-terminology.md` (Accepted) / `.minsky/rules/terminology-workspace-conversation.mdc` — the workspace/conversation/transport-session vocabulary for NEW code, docs, and cockpit UI copy. The `session` URI type above is deliberately NOT part of that rename (stage 1, mt#2686) — it stays `session` until the deferred stage-2 mechanical `session_*` → `workspace_*` tool-surface rename (mt#2527), which is the only stage that would touch this table.
