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

This is Surface A (the terminal). Linking here **was** agent discipline throughout — you emitted
the markdown by hand. (Surface B, the in-cockpit transcript view, linkifies the same refs on its
own side via mt#2518.)

**As of mt#2565 that is only half true.** The paragraph here once read "There is no harness hook
that rewrites assistant output" — accurate when written, false from Claude Code 2.1.152, and
load-bearing while it lasted: mt#2565 inherited it as a settled premise and scoped itself around a
seam it assumed did not exist. The hook now exists and ships (`linkify-message-display.ts`), so on
Claude Code `mt#NNNN` and `PR #N` are linkified for you. Discipline still owns everything else —
every other harness, and every ref whose target is not derivable from its label. See
§The one-link-per-entity ration is provisional below for the evidence, the decision, and what the
build found.

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

**Status: built (mt#2565, 2026-08-10).** `.claude/hooks/linkify-message-display.ts` rewrites bare
`mt#NNNN` and `PR #N` into deeplinks as a message is displayed; `.minsky/hooks/entity-linkify.ts`
is the pure transform it wraps. The rule's ration is retired for those two classes — write the
clean bare ref. (The originating session also contained a genuine violation — an entity bare on
its FIRST mention — which is ordinary discipline, not a rule-design question, and needed no rule
change.)

**What the implementation learned that the decision above did not know.** The feasibility check
read the client's CHANGELOG; the build read the installed binary's own embedded schema (2.1.226),
and the event is narrower than the changelog sentence suggests. It fires **per batch of newly
completed lines while the message streams** — input `{turn_id, message_id, index, final, delta}`,
dispatched with `forceSyncExecution` — not once per finished message. Three consequences:

- The hook sits in the display hot path, so it loads no domain code and touches no DB or network.
  Measured cost is ~22ms per invocation (20 runs of the compiled hook against a representative
  delta), which is process startup plus one small state-file read.
- Fenced-code elision needs state the delta cannot carry: a ```fence opens in one delta and
closes in a later one. Hence a single`message_id`-keyed state file, reset when a new message
starts and deleted on the final flush. Inline spans and blockquotes are line-local and need no
state, so `elideMarkdownContexts`'s posture carries over directly.
- **Only refs whose target is derivable from the label can be rewritten.** `mt#2565` →
  `minsky://task/mt%232565` is a pure string transform. `ask#N` / `mem#N` / `ws#N` are not: ADR-029
  makes the full UUID the sole target, and resolving a short id needs an id-set the display path
  cannot read. Those stay bare, which is exactly the class mem#623 R6 measured failing (6 of 6
  derivable refs linked, 0 of 3 of these). mt#3914 owns closing it with a cached map, following
  ADR-028 D7(5)'s cache-and-sweep pattern.

**On the harness-specific constraint above.** It is not a temporary bridge and so carries no
retirement task: `MessageDisplay` is a Claude Code affordance, and on a harness without an
equivalent seam the authoring discipline is the only mechanism there will ever be — permanently
harness-conditional rather than provisional. The threshold that would change this: if a second
harness becomes a working surface for principal-facing output, its linkification gap needs its own
answer at that point.

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

## The emit set and the accept set are different lists (mt#3800, 2026-08-05)

The rule's five-type table governs what an agent WRITES in terminal output. `parseMinskyUri`
governs what the cockpit RESOLVES when a URL arrives from the OS. Those had been the same list,
which made it easy to read either as the other's contract; mt#3800 separated them by adding
`conversation` to the accept set only.

**Why accept it.** `/cockpit` opens the conversation the operator is currently in. Without a
`conversation` URI type the only reachable target is a raw `http://localhost:<port>/…`, which
means hard-coding a port the tray does not own and landing in a browser tab rather than the
cockpit window the operator already has open.

**Why not emit it.** A conversation reference in prose fails both halves of the label/target
split this rule is built on: the id is a bare uuid with no readable short form (unlike
`mt#2370`, `mem#728`, `PR #1234`), and the reader of an agent message is BY CONSTRUCTION already
inside the conversation being referenced — the link would point at where they are.

**A correction this change carries.** From mt#2769 until mt#3800 the codec's module header
attributed the five-type restriction to an "ADR-022 stage-1 constraint." ADR-022 contains no
mention of `minsky://`, URIs, or a deeplink type table; its stage-1 text scopes to vocabulary
adoption in new code and to leaving `session_*` tools, params, DB columns, and session paths
untouched. The restriction was real and deliberate, but it was a code comment's own decision
wearing an ADR's authority — an instance of the pattern `claim-confidence.mdc §The corpus is
agent-authored` names. The header now states the accept-vs-emit split directly and records what
the ADR does and does not say.

## Ghostty ≤ 1.3.1 does not dispatch custom schemes (mt#4333, 2026-08-20)

A `minsky://` deeplink on Ghostty ≤ 1.3.1 renders and then silently does nothing on click. That is
worse than the plain-label degradation the rule promises for non-OSC-8 terminals: a plain label
looks like text and is read as text, while this looks actionable, absorbs the click, and returns no
signal — so the reader concludes their own setup is broken. `https://` links in the same message
open normally, which is the diagnostic tell.

### The cause is a missing capability, already fixed upstream

Ghostty routes terminal-supplied URLs through `macos/Sources/Helpers/UntrustedURL.swift`, which
sorts each into `.allow` / `.confirm` / `.deny`. `http`, `https`, `mailto` and `file` are handled
explicitly; the `default:` branch — every other scheme — returns `.confirm`, with this comment:

> A custom scheme can invoke any application registered with Launch Services. The caller must show
> the target and handler before allowing that dispatch.

So current Ghostty **does** dispatch `minsky://`, behind a confirmation naming the target and its
handler. The file does not exist at tag `v1.3.1`; it was added by
[commit `77537c806`](https://github.com/ghostty-org/ghostty/commit/77537c806) on 2026-08-05
([file on `main`](https://github.com/ghostty-org/ghostty/blob/main/macos/Sources/Helpers/UntrustedURL.swift)).
`v1.3.1` is still the newest release, so the capability ships only on unreleased `main`/`tip`.

Re-check the boundary — this is what retires the caveat, so it is written to be run rather than
trusted:

```sh
for r in v1.3.1 main; do
  printf '%s ' "$r"
  curl -sL -o /dev/null -w '%{http_code}\n' \
    "https://raw.githubusercontent.com/ghostty-org/ghostty/$r/macos/Sources/Helpers/UntrustedURL.swift"
done
```

`404` then `200` means the boundary still holds; two `200`s mean a release now carries the fix.
One URL per `curl`, deliberately: `-o` binds to the FIRST url only, so passing both to a single
invocation prints the first status and then dumps the second file to stdout. The loop form is also
plain POSIX `sh`, so it runs wherever it is pasted.

### Why nothing changes on the emission side

The scheme (ADR-023), the UUID-as-sole-target rule (ADR-029), the entity codec, and the display
linkifier are all correct, and iTerm2 dispatches them today. Four approaches were considered and
withdrawn:

| Approach                         | Why not                                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copyable URL alongside the label | A permanent cost on every message against a temporary upstream gap.                                                                                                                     |
| Terminal-aware emission          | Cannot satisfy its own requirement — it needed a capability PROBE rather than `TERM_PROGRAM` matching, and no probe exists: the emitting side cannot observe whether a click activated. |
| Upstream request                 | Moot; the work is merged.                                                                                                                                                               |
| Accept and document              | Closest to correct, and is what this section is — minus the resignation, since the boundary is dated and checkable.                                                                     |

Ghostty's own `link` config cannot substitute either: its docstring reads
`TODO: This can't currently be set!` (`src/config/Config.zig:1461`). And `link-osc8` defaults to
`true`, so OSC-8 support was never the missing piece — scheme dispatch was.

### Two corrections this replaces

From 2026-07-23 (`5e184e8a9b`) until 2026-08-20 this rule asserted a Cmd+click bug with a
context-menu workaround, citing
[ghostty#11907](https://github.com/ghostty-org/ghostty/issues/11907). Both halves were wrong.
Cmd+click works fine for `https` on the same build, so it is not a Cmd+click bug; and the workaround
appears nowhere in the cited issue and is falsified by observation — no menu appears. The remedy's
exact phrasing is deliberately not reproduced anywhere, so a future `grep` cannot resurface it as
advice. ghostty#11907 is a real report of the symptom on 1.3.1, closed as not planned, consistent
with the above but not the explanation.

The reusable lesson: the earlier pass answered this question with `WebFetch`, whose summary was
accurate about `link` and silent about `UntrustedURL.swift` entirely. A summarizer cannot tell you
about a file it did not surface. Fetching the raw sources and checking tag existence via the API is
what found the fix.

## Cross-references

- mt#3800 — `conversation` added to the accept set; the `/cockpit` command; the accept-vs-emit split.
- mt#3459 — this decision; mt#3259 — the cockpit-side bare-short-id linkifier that is its precedent.
- mt#2517 — parent umbrella (cockpit deeplinks); mt#2519 — the compiled rule (Surface A / terminal).
- mt#2518 — Surface B (cockpit transcript linkifier) + the shared `(type,id) ↔ minsky:// URI ↔ path` codec this format matches.
- mt#2528 — the `minsky://` OS scheme handler in the cockpit-tray app (required for a terminal click to actually open the cockpit).
- mt#2535 — `/changeset/:id` cockpit detail route (ships the page the changeset URI navigates to).
- mt#2536 — PR/changeset linkification (adds `changeset` to RoutableEntityType + linkifier PR #N recognition).
- `docs/architecture/adr-022-session-vs-conversation-terminology.md` (Accepted; amended 2026-09-04 by mt#4838 — transport sense now a frozen legacy artifact, a fourth "drive" sense added) / `.minsky/rules/terminology-workspace-conversation.mdc` — the workspace/conversation vocabulary for NEW code, docs, and cockpit UI copy. The `session` URI type above is deliberately NOT part of that rename (stage 1, mt#2686) — it stays `session` until the deferred stage-2 mechanical `session_*` → `workspace_*` tool-surface rename (mt#2527), which is the only stage that would touch this table.
