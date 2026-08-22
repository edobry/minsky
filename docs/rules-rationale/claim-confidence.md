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

### Worked example: a recommendation carried between surfaces (mt#4051)

The clause above says an **Asserting** citation covers "a chosen framing." A recommendation is one,
and the shape it fails in is not citation-in-prose — it is transit.

**The incident (2026-08-12).** An agent resumed from handoff mem#977, dereferenced ask#8004 (an open
transcript-storage mechanism decision filed by an earlier session), and put its four options to the
principal via `AskUserQuestion`, carrying the first label verbatim: **"Switch to Postgres lines
(recommended)."** It had derived none of that. Both source records disclaim the label explicitly —
mem#977, which the agent had read that turn: _"the framing that it is preferable is an agent's, not
independent"_; mem#773: _"Superseding ADR-025's mechanism is a principal decision and was NOT taken
by an agent."_ The principal replied _"help me understand what in our analysis changed here to make
you no longer recommend the object storage approach"_ — a question premised on analysis nobody had
done. Cost: one wasted round-trip on a decision gating four tasks.

**Why it is a distinct shape.** In its home artifact a recommendation is self-labelling. An ask
carries a requestor; a memory carries an author; a handoff names whose framing it is. Those
surfaces supply the attribution _around_ the string, so the string never carries it itself. Copy it
into a new principal-facing surface and every carrier is left behind — and there the marker has one
available referent: the agent presenting it.

This is §Absence in a derived view's geometry applied to attribution rather than data: nothing is
contradicted, there is no error to notice, only a gap. A quotation that drops its quotation marks
does not look like a quotation; it looks like a sentence you wrote. That is why it passes the
author's own review, and why faithfulness is the trap — reproducing the string exactly is what
strips it.

**Why the two shipped fixes did not contain it.** §A relayed claim is never `verified` (mt#3152)
scopes to FACTUAL output from three intermediaries; a recommendation is not a claim, so a rule
written about findings does not self-trigger. This section (mt#3599) does cover it on a careful
reading, but every example it gives is factual-adjacent and its frame is citation-in-prose. Neither
contemplates structured tool input as a destination. Recurrence-after-DONE against
`family:assertion-without-verification`.

**The check.** Before handing the principal an option set, ask of each preference marker: did I
derive this THIS turn, or am I carrying it? If carrying, name the source in the same sentence. One
clause suffices: _"ask#8004 marks this recommended; that label is a prior agent's framing, not
mine."_

### Cross-references

mt#3599 (this amendment, Leg B) · mt#3598 (the corpus audit) · mem#824 (the originating incident)
· mem#664 (`family:principal-altitude` root) · ADR-037 (the forward control mechanism this
amendment accompanies) · `user-preferences.mdc §Plain-language first` · mem#706
(`family:assertion-without-verification` root) · `/escalation-packaging §Content checklist` items 2
and 4 (the chokepoint check).

For the normative-content extension above, three ids that are easy to confuse and are not the same
record:

- **mt#4051** — the task that shipped the extension (this rule amendment, the checklist items, and
  this section).
- **mt#4052** — the deterministic slice mt#4051 deferred: a calibration-first `PreToolUse` detector
  for a preference marker carried into an `AskUserQuestion` option label without a named source.
  Filed, TODO, with a recorded dependency on mt#4032. This is the mechanism that would have caught
  the incident above; the prose here is the weaker tier and says so.
- **mem#997** — `feedback_recommendation_loses_provenance_across_surfaces`, the bridge memory,
  retired when mt#4052 ships. **Distinct from mem#977**
  (`handoff_transcript_archive_premise_falsified_2026-08-11`), the handoff cited in the incident
  narrative above as the record the agent read and whose disclaimer it dropped. The two differ by a
  digit transposition and nothing else, so check the name before citing either.

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

### Worked examples — output-shaped (2026-08-13, one session)

Every row above is DATA-shaped: the derived view is a rendering of a data structure. The family
recurred twice past those fixes on a different shape — **the derived view was a program's emitted
OUTPUT**, and in the first case, a grep the agent had built over it itself.

| Derived view read                                                    | Primary source not read                     | Wrong conclusion                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| A `grep -E "^\(fail\)\|timed out"` over a run log                    | the run log's own adjacency, in the file    | "this test fails on a `waitFor` timeout" — the two lines came from different blocks; the file has no `waitFor`     |
| The absence of an `[changesets] … internal error` line in run output | the HTTP response body the handler produced | "the handler's own catch never ran, so the 500 came from a layer above" — the body was that catch's text, verbatim |

**Why a grep is the harder case.** The other views in this section were built by someone else — a
parser, a type system, a renderer — so it is at least possible to ask what they were built to show.
A grep is one you construct in the moment, to answer the question you are already asking, which
makes its output feel like the log rather than a view of it. What it drops is not a field but a
RELATION: in a bun test run, a `(fail)` line and the `error:` block above it are bound by adjacency
in the file, and a filter that selects both patterns puts unrelated lines next to each other with
the pairing intact-looking. That claim went into two task specs — mt#4086's, and mt#3501's, where it
became evidence that a different task's failure class was broader than it is. One file open
falsified it.

**Why the second survived a correct finding.** The elimination rested on: the route logs on that
path → no such line appeared → the path did not execute. The middle step is a claim about the
LOGGER and was never checked. `TEST_LOGGER_SILENCED_FLAG` (declared and read in
`packages/shared/src/logger.ts`, set by `tests/setup.ts`) silences winston's Console transport under
the in-process harness (mt#2975) — the code logged and the harness swallowed it. Anchored to the
symbol rather than a line number on purpose: the original incident record cited
`packages/shared/src/logger.ts:116`, which had already drifted to a different declaration by the
time this was written, in both the task spec and the bridge memory that carried it. The aggravating detail is that the
same turn had CORRECTLY established that the route imports the UNMOCKED `@minsky/shared/logger`, and
that true finding was used to license "so its output would have appeared" — when that module is
precisely the one carrying the silencing. **A verified fact adjacent to the question makes the
inference feel checked**, which is why this one shipped as a _second elimination_ retiring two
candidate causes rather than as a hypothesis. The falsifier cost one run: capture the response body.

**What the detector could not do about either.** `negative-existence-claim` (mt#3918) was the
shipped containment and reached neither, though not for the reason first recorded. The original
diagnosis blamed its required DONE-task conjunct; measured against the matcher and against the
detector's full evaluation stream (172 turns, 2026-08-12 → 08-16), that conjunct has never once
suppressed a candidate, and both recurrences fail conjunct 1 instead. The corpus's `never`-family
patterns are present-tense (`never runs` / `never fires` / `never executes`), while a post-hoc
diagnosis is written in the simple past — `never ran` matches nothing. And the first recurrence
asserts a mechanism is PRESENT, so no negation-keyed corpus can reach it at all. mt#4162 carries the
measurement of that recall-miss rate and the rung decision it gates; ADR-024 and the matcher's own
docblock both refuse the obvious repair of widening the phrase list.

### The check

Before writing a negative into a durable artifact, name the view you actually read and ask whether
that view would show the thing if it were there. If the answer is no — or unknown — the honest
label is "absent from `<view>`", and the falsifier is one read of the primary source: the raw file
behind the parser, the call sites behind the type, the component behind the screenshot.

### The inverse: an accessor that SYNTHESIZES rather than drops (mt#4227)

Everything above this line describes an accessor that REMOVES — a parser that discards a sibling
field, a filter that strips the context binding a line to its block, a logger silenced by the test
harness. The remedy generalizes as "the view is missing something", and the check above is written
in exactly those terms.

A projection over a key the source does not have fails the other way. It does not omit and it does
not raise; it CONSTRUCTS a value:

```
$ curl -s localhost:3737/api/health | jq '{commit, startedAt, processStartedAtMs, uptimeMs, pid}'
{ "commit": "96de132ad", "startedAt": null, "processStartedAtMs": 1787043538506,
  "uptimeMs": null, "pid": null }
```

Three of those five keys did not exist in the payload. `jq`'s object construction emits `null` for
an absent selected key, and that is byte-identical to a key present with a null value. Reported to
the principal (2026-08-17) as "present-but-null fields, possibly a small defect" — a claim about
data that the data never made.

**Why the existing text could not catch it.** Every conjunct in this section, and every matcher in
the detector family, is framed around ABSENCE. This report asserted PRESENCE. Nothing in the rule
gave a reader a reason to check, and nothing in a matcher keyed on absence-shaped phrasing could
see it. That is a coverage gap rather than a discipline failure, which is why the answer is rule
text and not "read more carefully."

**The generalization is the important part, because `jq` is incidental.** `dict.get(k)` returns
`None`; `obj?.field` yields `undefined`; `row["missing"]` on a DataFrame yields `NaN`; a Go map read
yields the zero value. Any projection that returns a type-valid falsy value for a missing key rather
than raising has this shape. So: **an accessor is not a filter, it is a constructor.** Enumerate the
source's real key set first — `jq keys`, `has()`, `in`, `hasOwnProperty` — and only then say
anything about a field's value.

**A worked instance of the same trap, one layer up.** This task's own spec used `pid` as its example
of an absent key. mt#4232 shipped `pid` into that payload the next day, so an implementer re-running
the spec's verification command would have read a real number and concluded the hazard was not real.
The example was re-verified and moved to `startedAt` / `uptimeMs` at planning time. A spec is a
derived view of the world at authoring time, and it goes stale the same way.

#### The polling-loop sub-shape

The same session produced a worse variant, worse because it is designed in rather than incidental:

```bash
s=$(bun run src/cli.ts deployment status --service cockpit --json 2>/dev/null | jq -r '.status // empty')
echo "poll $i: ${s:-<no-read>}"
```

`deployment` is an MCP-only command; the CLI has no such subcommand. Every iteration wrote
`error: unknown command 'deployment'` to stderr, `2>/dev/null` discarded the only channel that said
so, and `// empty` collapsed "the command does not exist" into the same token as "no status yet".
The loop ran 60 iterations over 30 minutes producing output indistinguishable from a deploy that had
not reported yet.

A wait loop is the ideal hiding place for a broken probe, because **"nothing yet" is the CORRECT
reading for most of the loop's life** — the broken path and the healthy path's early iterations are
identical by construction, so there is no moment at which the output looks wrong and prompts a
second look. The remedy is one line: run the probe once in the foreground with stderr visible and
confirm a real value before wrapping it in a loop. A loop waits on a condition; it is not where you
find out whether your probe works.

#### Detector assessment (mt#4227) — OUT OF SCOPE for `negative-existence-claim`, and why

The task required this question to be answered rather than deferred. Verdict: **do not extend the
detector; the rule text is the remedy.** Three independent reasons, the first two of which are
binding rather than preferential.

1. **The detector's subject is the wrong shape.** `negative-existence-claim` fires on a claim of
   ABSENCE justified by a thin search. This class asserts PRESENCE. Covering it is not a corpus
   widening but a different detector with a different trigger.

2. **ADR-024 forecloses the cheap version.** The detection-mechanism ladder governs this family and
   names the exact move as its anti-pattern: _"Each miss has historically been answered by adding
   another regex family (R1 → R5) — an arms race."_ Its constraint (a) stops the ladder at Rung 1 by
   default and makes Rungs 2-3 _"strictly evidence-gated"_, with (b) setting the bar at "0 known-FP
   AND ≤5% new false-negative, measured on the existing `.minsky/*-calibration.jsonl` logs." A
   recall miss of this kind belongs at Rung 2 (embedding), and Rung 2 requires a MEASURED miss rate.
   One incident is not a measurement. The path was already declined twice on that basis (mt#3232,
   mt#4162; standing reasoning at mem#1025 R3).

3. **The discrimination is the whole difficulty, and a phrase matcher cannot do it.** The task's own
   acceptance test demands a negative control proving the detector does NOT fire on a genuine
   present-but-null field. But "the field is null" and "the field is null" are the same sentence in
   both cases — the difference lives in the PAYLOAD, not in the agent's prose. A matcher over the
   agent's output has no access to the discriminator, so a detector built on one would be
   structurally incapable of the distinction the criterion requires, and worse than none.

Consistent with RFC 3a0937f0 (Accepted 2026-07-18), which created this rule and fixes the
relationship as _"complement, not subsume"_ — the reactive detectors are not expected to be the
carrier for every claim class the vocabulary covers.

**What would reopen this.** A measured recall-miss rate for the synthesized-value class in a
calibration log, per ADR-024's Rung-2 gate; or a payload-aware surface (one that can see the source
key set, not just the prose) where the discrimination in (3) is actually available.

### The fourth surface: your own recent output (mt#3904)

A guard fire quotes the phrase that tripped it precisely so the agent can recognize a false
positive instead of complying blindly. That invitation carries no evidentiary bar, which makes
"that's a false positive" a costless exit — available at the moment of maximum motivation to take
one, since a fire is a demand for more work, usually at turn end.

Recognizing an FP is itself a claim about text, and its usual shape is a data-existence negative:
"the quoted phrase doesn't appear in my message." The derived view is recollection of one's own
output; the primary source is the transcript. This surface is harder than the three above because
the question does not present as a lookup at all — "did I write X?" feels like introspection, and
introspection has no file to open.

Incident, 2026-08-10. A `turn-end-untaken-action` fire quoted `next-up: "next step is"`. The
response was that the quoted phrase "doesn't appear in my message." It did appear — "…and the
documented **next step is** bypass merge" — inside the guard's 600-character tail window
(`TAIL_WINDOW_CHARS`, `.minsky/hooks/turn-end-untaken-action-scan.ts`). The follow-up check then
grepped the NEWEST transcript file, which belonged to a different conversation, and read the
resulting `0 matches` as confirmation; it would have been reported as vindication had the
principal not asked. Two failures stacked: a negative asserted from a derived view, then a
falsifier run against an unverified source.

The remedy is to make the claim carry its evidence, which also splits it into two kinds that are
settled differently:

| Kind               | The claim                                    | What settles it                                                                                             |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **pattern-false**  | the quoted text is not present               | grepping the transcript holding THIS conversation — located first, by grepping a distinctive string from it |
| **semantic-false** | the text is present but the fire misreads it | argument, with the quoted text acknowledged rather than denied                                              |

A genuine semantic-false defense was available in the incident and went unused: the phrase sat
inside a handoff message describing a documented process step, not an announcement of the agent's
own next action. The unfalsifiable claim was reached for because it was faster.

Placement follows from the same reasoning. `guard-feedback-authoring.mdc` is where the quoted-
evidence invitation is written, but it is path-scoped to `.minsky/hooks/**` — it loads for the
guard AUTHOR, while the FP claim is made at `Stop`, in an arbitrary session, with no hook file
open. The bar therefore lives here, in an always-loaded rule, with a two-line pointer left for the
author.

### Why containments keep arriving late

The corpus's negative-claim disciplines are scoped by SURFACE — capability claims (mt#3162),
identity claims (mt#3844's `/check-premise` cue (k)), now data claims. The underlying error is
scoped by EPISTEMICS: derived view versus primary source. As long as fixes are filed per surface,
each new surface gets its own incident first. That is the argument recorded on the family anchor
(mt#2544) for treating this generalization as the durable content rather than the fourth cue.

## Modality match: does the channel perceive this KIND of thing? (mt#4259)

Every section above operates on a view's OUTPUT — you are holding a run log, a parsed record, a
projection, and the question is what it drops or manufactures. This one fires one step earlier,
at channel SELECTION, where it is cheaper and where a zero result has not yet become a premise.

### The check

Name the KIND of thing you are seeking before you accept a null:

| Kind sought                 | Perceives it                                        | Blind to it                           |
| --------------------------- | --------------------------------------------------- | ------------------------------------- |
| A rendered visual behaviour | A screenshot, an image search, a person watching it | Any text search over source or binary |
| A runtime value             | A live probe, a log with the value in it            | A static read of the code             |
| A code path                 | The source, the call sites                          | A screenshot, a doc page              |
| A policy or an intent       | The decision record, or the person who holds it     | The code that implements it           |

A mismatch does not error and does not look empty — it returns a well-formed "not found" whose
value is independent of whether the thing exists. That is mem#704's shape ("a probe that returns
the same result when the system is broken is not verification") applied to a SEARCH rather than
a test, and it is the same structural property as §Absence in a derived view: the channel is
accurate about itself and silent about your question.

### Worked example (2026-08-18, mt#4220)

The question: does Claude Code fold runs of consecutive agent actions into one line in its
terminal UI? The probe: `strings -n 6` over the installed Mach-O binary, plus two published doc
pages, plus one `WebSearch`. Zero hits, reported as absence, and used to scope a feature out of
a task.

Two independent reasons the result carried no information:

1. **Instrument blindness.** Claude Code bundles its JavaScript substantially compressed;
   `strings` prints runs of printable characters and cannot see compressed regions. A direct
   `grep -ac` over the raw binary also returns 0. So the probe returns zero either way.
2. **Modality mismatch, which is the more general failure.** The subject was a _rendered_
   behaviour and every channel tried was _text_. Even a perfect text search over a perfectly
   readable bundle answers a different question than the one asked — it tells you a string is
   present in a file, not that a behaviour renders. Fixing (1) alone (decompressing, reading the
   real source) would have improved the probe without addressing this.

The feature existed. The principal settled it a day later with a screenshot of his own terminal:
`Thought for 47s, listed 1 directory, ran 4 shell commands`. **The falsifier for a rendered
behaviour is a rendering.**

### The channel-kind corollary

For a negative that will license a decision, count KINDS, not searches: the rendered artifact,
the primary source, a derived artifact, third-party prose, a person with direct access. The
incident used three channels of one kind and read it as thoroughness. When the rendered artifact
sits on the principal's side of a boundary the agent cannot cross, that last kind is the cheapest
one available — `principal-context.mdc §What Eugene can see`, and
`docs/rules-rationale/principal-context.md §The vantage point` for the trigger's counter-case
(when NOT to ask him, which is most of the time).

Incident record: mem#1086 (`5b8858f0`). Family: `family:assertion-without-verification`,
bounded-negative slice — siblings mem#704, mem#804, mem#490.

## Ranking axis: the channel perceives the kind but sorts by the wrong thing (mt#4268)

The section above stops one question short. Naming the KIND tells you whether a channel can
perceive the thing at all. It does not tell you whether the channel ORDERS its results by the
axis your question turns on — and a semantic index orders by MEANING, while an identifier's
meaning is not its spelling.

### Why this sub-shape needed its own text

Every other member of this family is a view that returns **less** than its source: a parsed record
dropping a sibling field, a `grep` filtering a log, a silenced logger, a screenshot, a `jq`
projection. That trains the reader's tell to be _"something is missing."_ A ranked search fails the
other way — it returns a **full, plausible set** and omits the exact match. Eight ranked
near-misses do not feel like something is missing; they feel like a completed survey. So the
existing conjunct covered this logically and was unreachable perceptually, which is why the
recurrence happened ~50 minutes after mt#4227 merged into this very section, with the file open.

**The tell, stated so it is usable:** a full result set of near-misses with **no direct hit**. That
shape is evidence about the INSTRUMENT, not about the subject. An empty result prompts more
digging; a full one does not, which is exactly what makes it more dangerous than a zero.

### Which instrument answers which question

| Question                                                                                                             | Instrument                                               | Why                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| "What work is ABOUT this topic?"                                                                                     | semantic / embedding search                              | Ranks by meaning; finds paraphrases and neighbours a lexical search cannot.                                                             |
| "What mentions this TOKEN?" — a code symbol, config key, error string, table or column name, migration slot, env var | EXACT search: substring, `grep`, `ILIKE` over the corpus | An identifier's meaning is not its spelling, so meaning-ranking is the wrong sort order. A token match is decidable; similarity is not. |
| "Does any ACTIVE spec already claim this token?"                                                                     | `duplicate-signature-scan` at `tasks_create`             | Already shipped, and is what caught the originating incident.                                                                           |

The two are complements, not substitutes. The failure is not "semantic search is bad" — it is
using a meaning-ranked instrument for a spelling-shaped question and reading its fullness as
coverage.

### Worked example (2026-08-18, mt#4267)

Filing mt#4267 — a reviewer in-flight-marker defect — the query was
`"reviewer service in-flight marker stale concurrent review skipped redeploy kills review"`. It
returned eight plausible reviewer-subsystem tasks (mt#2853, mt#1897, mt#2926, mt#1815, mt#1896,
mt#1136, mt#1552, mt#1559) and **none of the three that own the mechanism**. A duplicate-check
record was written from that set, then a Summary asserting the marker "is not cleared", then
success criteria asking for a TTL to be **added**.

`duplicate-signature-scan` fired at `tasks_create` on exact-substring match and returned all three
immediately:

- **mt#1907** (DONE) owns the marker. Its SC#1 requires "a TTL or explicit expiry"; its
  `Does NOT cover` states the 5-minute default. The TTL had shipped three months earlier.
- **mt#1914** (TODO) instruments `runReview.skipped_concurrent_inflight`.
- **mt#1697** (TODO) had already recorded five same-day instances of the surrounding class.

Why the search missed: `concurrent_inflight` is a code token. The owning tasks are titled "sweeper
in-flight marker to eliminate webhook-vs-sweeper double-trigger race" and "instrument
marker-mechanism health signals via Braintrust" — semantically distant from a query framed around
"redeploy kills review, stale lock." A meaning-ranked instrument was used for a lexical question.

The same false premise also reached a memory (mem#1093), where no guard exists — which is the
uncovered surface this prose is for. `memory_create` has no analogous check, and the signature
scan's overlap target (active task specs) does not obviously transfer to it.

Incident record: mem#1025 R6. Family: `family:derived-view-absence` — this is the sixth
recurrence and the third rule-widening (mt#4121 output-shaped, mt#4227 the synthesizing inverse,
mt#4259 the modality mismatch).

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
