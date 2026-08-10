# Claim Confidence — extended rationale

> Extracted from `.minsky/rules/claim-confidence.mdc` (mt#3083 corpus trim, following the
> mt#3052 pattern). The compiled rule carries only the bare vocabulary, the claim format, and
> the ledger's objective trigger quorum; this file holds the full axis definitions, worked
> examples, the RFC reconciliation, and the enforcement/cross-reference detail. Nothing here
> changes agent behavior — the directive text in the rule is the complete behavioral contract.

## Why this vocabulary exists

When the agent claims work is done or something is true, two questions hide in one sentence:
**how far the deliverable has progressed**, and **how the agent knows the claim**. Leaving both
implicit is where miscalibrated "it's done" claims come from. The rule is the shared
vocabulary — two orthogonal axes, a claim format carrying both, and a ranked ledger for
high-stakes operations.

It is a **vocabulary and rationale layer**: it does NOT mandate a label on every claim (that is
the wallpaper failure mode — labels everywhere become noise the operator stops reading).
Enforcement is conditional and lives in the siblings — a seam-only injection (mt#2923) and the
`/implement-task` §9 / `/verify-task` closeout format (mt#2924). Apply the vocabulary where
those fire and where miscalibration would cost the principal.

## Axis A — delivery state (full definition)

How far the deliverable has progressed toward the principal using it: `merged → deployed →
usable-by-principal`. **Class-conditional:**

- **Auto-usable** (a running service picks up the merge; config takes effect on deploy): once
  `deployed`, `deployed == usable`.
- **Build/install** (a CLI or tray app the principal must rebuild/reinstall): `deployed < usable`,
  with **no agent-observable transition** into `usable` — exactly where an unwarranted "it's
  done" originates (the agent observes `merged`/`deployed` and narrates `usable`). State
  delivery at the altitude the class supports; if there is a gap the agent cannot cross, name
  the crossing step.

## Axis B — evidential warrant (full definition)

How the agent knows the claim:

- **verified** — a tool result THIS turn proves it. Split: **verified-1a** (a deterministic
  test/check — compile passed, unit test green) vs **verified-1b** (a live-environment probe —
  HTTP 200 read, a real API call, a route rendered). The split matters because a deterministic
  test can pass against the wrong object while live behavior was never exercised (mt#2528
  below).
- **strong-evidence** — multiple consistent indirect signals (review APPROVE + CI green + a
  partial observation), short of direct end-to-end proof.
- **inferred** — a conclusion from a mechanism/premise not directly checked.
- **assumed** — taken as given WITHOUT an attempt to determine it.
- **unknown** — attempted and undetermined, or explicitly acknowledged as undetermined.

**`assumed` vs `unknown`** (the distinction the RFC deferred): `assumed` = never tried,
proceeding on a default — the more dangerous label, since it hides an unmade check; `unknown` =
tried, or consciously acknowledged, and the answer is unavailable. Prefer converting `assumed`
into `verified` or `unknown` by actually probing.

## Claim format — worked examples

`[delivery state] — [evidential warrant + basis]`:

- `Merged (verified: PR merged this turn) — to reach usable, rebuild + reinstall.`
- Executive one-liner: `Deployed (verified-1b: health probe this turn) — usable after tray
reinstall.`
- The **mt#2528 originating incident**, re-expressed: `Merged (verified-1a: deterministic test
on the wrong object) — live-1b probe not run.` The 1a/1b split makes the original error
  stateable — it was reported as a live probe (1b) when only a deterministic check (1a), against
  the wrong object, had run.

## The risk-and-evidence ledger (high-stakes operations)

For a high-stakes operation on shared/prod state, do NOT scatter confidence phrases through
prose — LEAD, before requesting the operator's go, with a ranked table:
`| # | Risk | Magnitude | State (mitigated / N-A / open) | Evidence |`. The operator scans it
and either accepts or points at the one low-confidence row. Diagnostic (memory `b9cfd295`):
scattered operator anxiety-probing is a symptom of agent epistemic **opacity** — the agent has
a risk model but never exported it; the fix is agent-side (make it legible).

**Fires when EITHER** ≥2 of the three OBJECTIVE criteria hold
`{ irreversible-if-wrong, shared/prod state, multi-party impact }`, **OR
operator-expressed-uncertainty ALONE** (if the operator is already probing, exporting the model
is overdue — the circularity fix: the objective quorum lets the ledger lead BEFORE anyone asks).
**Caveat:** a short ledger gives false confidence if the one row the operator would have probed
was never enumerated — completeness of the enumeration is load-bearing, not the table's
tidiness.

Worked example (mt#2505 prod-migration): a prod schema migration satisfies `shared/prod state`
AND `irreversible-if-wrong` (migrations are hard to reverse as a class) = 2 of 3 objective
criteria → the ledger is required, independent of whether the operator asked.

| #   | Risk            | Magnitude | State     | Evidence                                 |
| --- | --------------- | --------- | --------- | ---------------------------------------- |
| 1   | Data corruption | High      | mitigated | no-op migration, 0 pending rows verified |
| 2   | Deploy breaks   | Med       | mitigated | failure-safe rollout                     |
| 3   | Irreversibility | Low       | N-A       | no schema change in this migration       |

## Reconciliation — this rule vs. the Communication-Altitude RFC

"Altitude" is a sibling's word and this rule deliberately does NOT reuse it. The
**Communication-Altitude RFC** (Notion `39e937f0-3cb4-81fe-bdea-e249014e356f`,
https://app.notion.com/p/39e937f03cb481febdeae249014e356f, Accepted 2026-07-15) owns the
_altitude register_ — `receipts / standard / executive` — which governs **how much** a report
says. This rule owns per-claim **confidence** (delivery state × evidential warrant). Orthogonal:
a receipts-register report can carry an `unknown`-warrant claim, and an executive one-liner a
`verified-1b` claim. The one non-free interaction is placement — that RFC keeps structured
tables out of the chat lead, but the risk-and-evidence ledger leads chat by design; resolved by
that RFC's **severity-piercing rule** (its triggers include "a destructive or hard-to-reverse
action taken or refused," the ledger's territory), so the ledger leads chat _under_ severity
piercing.

## The corpus is agent-authored

The relayed-claim discipline above covers subagent reports, `WebSearch` summaries, and your own
tooling's echo. It stopped one step short: it never said that Minsky's OWN corpus —
`.minsky/rules/**`, memories, ADRs, hook docs, task specs — is the same epistemic class. Every
byte of it was written by an agent. Citing it as evidence for a claim it originated is
self-citation with a file path in front of it.

### The distinction

The test is what the artifact is DOING, not what kind of file it is:

- **Recording** something external — an incident that occurred, a decision the principal made, a
  code behavior verified by running it, a vendor doc actually read. This is legitimate evidence
  for that thing, and it is most of what the corpus is for. mem#664's list of DONE task ids and
  mem#824's quotes from the principal are recordings; they can be checked against task state and
  transcripts, and they were.
- **Asserting** something it originated — a coined term, a chosen framing, a threshold an agent
  picked, a taxonomy imposed on a problem. No independent warrant. `inferred` at most, and
  repetition across files does not upgrade it: three rules repeating a coinage is one agent's
  judgment written down three times.

The file format renders both identically. A verbatim quote from a rule looks exactly as
authoritative whether the sentence records a vendor doc or invents a category, which is what makes
this easy to get wrong while being careful.

### Worked example: a threshold

An agent cites `decision-defaults.mdc §Thresholds` for "2+ in 24h, OR 3+ in 5 days." Is that
evidence?

For the claim _"Minsky policy is 2+/24h"_ — yes. The rule IS the policy; citing it is obeying a
policy, not making an empirical claim.

For the claim _"2+/24h is the right threshold"_ — no. The rule's own text says thresholds come
from "observed cadence," so the warrant lives in the observation, not the rule. An agent picked
these numbers from a corpus of incidents; if the question is whether they are correct, the answer
is in the incidents, and the rule is `inferred`.

### Worked example: the provenance challenge

2026-08-03. Challenged on whether "push into scroll" was a real term, the agent checked, found it
at `communication-contract.mdc:28` and `CLAUDE.md:180`, and reported that as evidence it had not
invented the term. The principal corrected the premise: _"It was you. You're the only one that
writes things in here. It's only ever been Claude."_

The check was the right move and the conclusion was framed wrong. Finding a term in the corpus
establishes the coinage DATE, not the provenance. `git_log` on that file returns
`docs(mt#3436)`, `docs(mt#3287)`, `docs(mt#3087)` — agent-authored throughout. **On a provenance
challenge, answer with `git_log` / `git_blame`, and say plainly if the answer is "an agent did."**
A file path is not an answer to "where did this come from?"

### Why self-authorship is aggravating, not mitigating

Per mem#736, a spec or rule you wrote yourself this session is MORE likely to be over-trusted, not
less: what you retain is the intent, while the divergence lives in the specifics. The same applies
to citation. A rule you helped write reads as settled fact on the next pass, and there is nothing
in the artifact to distinguish "we verified this" from "I decided this and wrote it down."

### Cross-references

mt#3599 (this amendment, Leg B) · mt#3598 (the corpus audit) · mem#824 (the originating incident)
· mem#664 (`family:principal-altitude` root) · ADR-037 (the forward control mechanism this
amendment accompanies) · `user-preferences.mdc §Plain-language first`.

## Absence in a derived view is not evidence of absence in the source

Expansion of the rule's §Bound a negative claim → data-existence paragraph (mt#3849). The rule
states the bound; this section says why the class is hard to catch and what the cheap check is.

### The distinction

A **derived view** is anything that presents the source rather than being it: a parsed record, a
type signature, a rendered screen, an accessor's return value, a search index. Each is built to
answer a particular question and is _accurate about itself_.

The failure is treating that view's silence as the source's silence. It is not a verification
skip — in most instances of this class, verification **ran**. A field was read; a probe executed; a
render observed. What was skipped is narrower: confirming that the view consulted is one that would
_show_ the thing whose absence is being claimed.

### Why it survives checks that catch wrong values

A wrong VALUE has a witness — read the source, see the disagreement. An absence has none. The
derived view returns nothing, the source is never opened, and there is no discrepancy for any
later check to trip over. So this class passes same-turn-read requirements, passes "did you
verify," and passes review, because every one of those confirms that _a_ read happened rather than
that the read _could have falsified the claim_. It is the mem#704 property — a probe whose output
is identical whether or not the claim is true carries no information — applied to negatives.

### Worked examples (2026-08-08, one session)

| Derived view read                               | Primary source not read                       | Wrong conclusion                                                                              |
| ----------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A screenshot of the cockpit conversation view   | `ConversationView.tsx`                        | "one role label per API message" — labeling is per TURN; the defect was upstream segmentation |
| `SharedCommand.mutating`'s type signature       | its 13 call sites + `checkDriftGate`          | "no registry field marks a tool as mutating" — it exists, scoped to a drift-gate allowlist    |
| A `tool_result` content block, via a live probe | the JSONL record's SIBLING fields             | "the metadata never enters the transcript" — `toolUseResult` carried it; our ingest drops it  |
| The same screenshot                             | `conversation-timeline.ts`'s documented basis | "inter-turn gaps aren't marked" — marked, at a p99 threshold derived from 36,310 samples      |

The third is the originating incident for the rule change: it is a verbatim violation of the
capability-shaped bound mt#3162 had already shipped, missed because the claim's surface was data
rather than capability.

### The check

Before writing a negative into a durable artifact, name the view you actually read and ask whether
that view would show the thing if it were there. If the answer is no — or unknown — the honest
label is "absent from `<view>`", and the falsifier is one read of the primary source: the raw file
behind the parser, the call sites behind the type, the component behind the screenshot.

### Why containments keep arriving late

The corpus's negative-claim disciplines are scoped by SURFACE — capability claims (mt#3162),
identity claims (mt#3844's `/check-premise` cue (k)), now data claims. The underlying error is
scoped by EPISTEMICS: derived view versus primary source. As long as fixes are filed per surface,
each new surface gets its own incident first. That is the argument recorded on the family anchor
(mt#2544) for treating this generalization as the durable content rather than the fourth cue.

## Enforcement surfaces (not in the rule) + cross-references

Vocabulary only; enforcement is the conditional siblings under parent **mt#2544**: **mt#2923**
(a seam-only `UserPromptSubmit` injection — the format reminder, not a block) and **mt#2924**
(the `/implement-task` §9 + `/verify-task` closeout format). Keeping it conditional is the
wallpaper answer. This practice is the **proactive front** to the **reactive** epistemic
detectors (**mt#2197** pre-narration, **mt#2216** causal-premise, **mt#2488** tool-boundary
evidence gate, **mt#2506** prod-state) — it complements them, it does not subsume them.

- **RFC: First-class agent-reasoning practices** (Notion `3a0937f0-3cb4-81a6-8699-e419a5ce4da0`,
  https://app.notion.com/p/3a0937f03cb481a68699e419a5ce4da0, Accepted 2026-07-18) — Part 2 is
  the design record for this vocabulary.
- **mt#2258** — principal-attention-scarcity, the design driver (the ledger converts operator
  anxiety into targeted scrutiny). Memory `b9cfd295` (risk-ledger / opacity); `b0b294ab` (the
  assertion-without-verification family this vocabulary gives a shared language to).
