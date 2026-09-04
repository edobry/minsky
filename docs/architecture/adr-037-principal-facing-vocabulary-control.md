# ADR-037: Control principal-facing agent vocabulary at the authoring step, not the speaking step

## Status

**Proposed** — 2026-08-04. Decided under mt#3599. Awaiting principal ratification; the mechanism
choice is principal-owned per `principal-context.mdc §Decisions Eugene reserves` (this record's
subject is how agents talk to the principal, and the principal asked for the control).

## The call

**Gate coined vocabulary where it ENTERS the always-loaded corpus, not where it reaches the
principal — because the entry point is a tool call that can be blocked and the speaking point is
not.** Ship a glossary of principal-facing terms, a `PreToolUse` guard that blocks a write
introducing an undefined term into an always-loaded artifact, and a log-only post-hoc detector on
the closed set of already-catalogued terms.

- The family's first non-prose, non-post-hoc fix in six recurrences. Six prose fixes shipped DONE
  and it recurred; the one enforcement-tier fix is structurally post-hoc.
- Costs a check on the always-loaded rule set only — a few dozen files, edited a few times a day.
  Not a per-turn cost.
- Fails toward false positives an author can fix in one line, never toward silent misses. This is
  the property that separates it from the allowlist ADR-034 rejected.
- Does not touch brand, essay, or marketing surfaces: they are not always-loaded artifacts, so the
  gate structurally never sees them.
- Adopts ASD-STE100's SHAPE and rejects its ARTIFACT. The dictionary is "All Rights Reserved" with
  no reuse grant; the design idea is not copyrightable.

Accepting this ADR means agreeing that the laundering step is the right place to spend the
enforcement budget, and that a glossary Minsky authors is preferable to a licensed one it cannot
embed.

## Context

On 2026-08-03 the principal stopped an agent's report to ask what "scroll" and "R2/R3" meant, and
whether the agent had invented them. Both were agent-coined, both were undefined, and "R" is used
in two incompatible senses in-repo — `guard-feedback-authoring.mdc:51` calls `R2`/`R3` "round
labels" (a PR review round) while every incident memory means recurrence number. The agent's
defence — that the term was in a rule file — established when it was coined, not by whom. The
principal: _"It was you. You're the only one that writes things in here."_

Verified independently for this record rather than taken from the memory that asserts it: "Push
into scroll" is present at `.minsky/rules/communication-contract.mdc:28`, `CLAUDE.md:180`, and
`AGENTS.md:1007` — three compiled surfaces — as a two-word table cell, defined nowhere.

This is R6 of `family:principal-altitude`. R1 through R5 each got a surface-specific fix and all
seven cited tasks are DONE (`refs_status`, 2026-08-04: mt#2713, mt#2801, mt#2867, mt#2870, mt#3112,
mt#3287, mt#3369). The family's one enforcement-tier fix is the wall-of-text detector, which mem#664
records as structurally unable to prevent this class: it measures at turn end and reports in the
next turn's context.

mt#2801's plain-language rule was supposed to cover this — it names "process-internal vocabulary"
explicitly. Its containment gap has two parts. Its examples are LABEL-shaped (gate letters `(l)`,
premise-audit labels `(iii)`, criterion tables), which trains recognition on things that obviously
look internal; "scroll" is WORD-shaped and passes as ordinary English. And every fix in the family
acts on the SPENDING step — the moment a term reaches the principal — while nothing audits the
LAUNDERING step, where a term enters an always-loaded file and reads to every later agent as
sanctioned vocabulary.

### The constraint that decides this

Claude Code's hook events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Stop` / `SubagentStop`, and `SessionEnd`. **Chat prose is not a tool call.** Nothing fires between
the model emitting a word and the principal reading it.

ADR-031 records the same boundary for this exact detector family from the other side: all eleven
guidance detectors run post-hoc, and its rejected option (d) — detect and inject at `Stop` — was
rejected in part because `Stop`-time `additionalContext` _continues the conversation_ rather than
gating text already delivered.

So there is no fourth option. There are three control points:

| Control point | What it acts on                             | Blocking?                                      | Tier                         |
| ------------- | ------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| **Authoring** | a write introducing a term into an artifact | yes — it is a `PreToolUse` on a real tool call | pre-commit / PreToolUse hook |
| **Context**   | the instruction present while generating    | no                                             | prompt-time prose            |
| **Post-hoc**  | the turn after the term was spoken          | no                                             | between merge gate and prose |

The laundering step lives at the blocking tier. The spending step does not, and no amount of
mechanism design moves it there.

## Decision

Three parts, in dependency order.

### 1. A glossary of principal-facing terms (the substrate)

A single registry — term, one definition, one sense, and whether it is safe to spend on the
principal. Every other part consumes it; without it the gate has nothing to decide against and the
detector has no list.

mt#3598's corpus audit produces the seed set. The format follows ASD-STE100's shape and not its
text: one approved meaning and one part of speech per entry, plus an explicit **domain-terminology
allowance** for Minsky's own nouns (task, ask, changeset, workspace, rung, calibration record).
STE documents that allowance precisely because a base vocabulary cannot cover a domain; Minsky's
operational vocabulary is almost entirely domain nouns, so the allowance is not a footnote here —
it is most of the artifact.

Entries carry a **provenance field**: coined-here, or borrowed from an external practice with a
citation. That field is what a future provenance challenge is answered with, and it is the reason
the glossary is worth having even if the gate below were never built.

### 2. A `PreToolUse` guard at the laundering step (the gate)

Fires on a write that introduces a term to an **always-loaded artifact** — a `.minsky/rules/*.mdc`
with `alwaysApply: true`, and the `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/` outputs they compile
to.

**The matched set is derived, not enumerated.** The implementing guard must compute it at run time
from the frontmatter, never from a number written here:

```
grep -l 'alwaysApply: true' .minsky/rules/*.mdc
```

That returned 24 rules on 2026-08-04 — an illustrative figure for sizing the cost, not a constant.
It drifts every time a rule is admitted or retired, which is exactly why the predicate reads the
frontmatter instead.

The predicate is deliberately not "is this word approved?" It is: **does this write introduce a
term that is neither defined in the write itself nor present in the glossary?** Define-at-first-use,
checked mechanically, against a registry.

**Scope is by path, and that is what makes the voice-surface carve-out structural.** `pz-voice`,
`minsky-brand`, `marketing-site-design`, and `engineering-writing` are all SKILLS
(`.minsky/skills/<name>/`), and no always-loaded rule is a voice, brand, marketing, or writing
surface — verified by grep over the derived set above, 2026-08-04. Essays, RFCs, and site copy are outputs of those
skills and are not corpus artifacts at all. The gate never sees any of it: not by an exemption list
someone has to remember to maintain, but because those writes are outside the matched paths.
Skills are outside for a reason beyond convenience — a skill body is loaded when an agent is
already doing that task, with context, which is a different reading situation from a file that
arrives in every conversation unbidden.

### 3. A log-only post-hoc detector on the closed set (the measurement)

ADR-024 Rung 1, scoped to the terms mt#3598 catalogues: did a turn spend one of those terms on the
principal without defining it? A closed set makes this near-zero false-positive — the detector never
has to judge whether a word is jargon, only whether it is one of N known ones.

It cannot prevent the instance. It is the measurement surface that says whether the gate above is
working, which ADR-024's coverage-receipt gate requires and which no prose fix in this family ever
had. Log-only first, per the calibration ladder; graduation is evidence-gated as usual.

## Options rejected

**Adopt the ASD-STE100 dictionary.** Rejected on two independent grounds.

_Licensing._ Primary sources read 2026-08-04: `https://www.asd-ste100.org/` and
`https://www.asd-ste100.org/STE_downloads.html` (both HTTP 200). The standard is obtained by
requesting a free official copy — "Request a free official copy of the current issue of the
ASD-STE100 standard" — not by open download, and both pages carry "Copyright and a Trademark of
ASD, Brussels, Belgium. All rights reserved. European Union Trade Mark No. 017966390" with no
public license grant for reproduction or derivative works. The FAQ adds that ASD and the STEMG "DO
NOT endorse or certify" third-party STE tooling and that such providers "have not received any
authorization to use the ASD logo, copyright, or trademark." **Free to obtain; not established as
free to embed.** A definitive answer needs the legal notice printed inside the requested copy, or
an email to `stemg@asd-ste100.org` — but it is moot, because of the second ground.

_Fit._ A ~900-word general-English approved list applied to Minsky's operational reporting would
flag nearly every sentence, because nearly every load-bearing noun is a domain noun. The
terminology allowance would have to grow until it stopped discriminating — which is precisely
ADR-034's convergence argument. The shape survives; the artifact does not.

**`danyuchn/asd-ste100-skill` as the mechanism.** Gate (k) probe, 2026-08-04: MIT licensed, not
archived, 308 stars, 6 forks — the gate passes on every check. It is still not a candidate. The
repo is three files, and its own `references/writing-rules.md` states that it "paraphrases rule
_categories_; it does not reproduce the standard's text or its ~900-word dictionary verbatim." The
popular MIT port contains no dictionary at all; it is a ~4 KB prose summary, which is the tier this
decision exists to escape. Useful as a secondary source for the rule categories, cited above for
the terminology allowance.

**A generation-time gate.** Not implementable — see `## Context`. Any proposal in this shape is
really a post-hoc detector, and should be evaluated as one.

**A seventh prose amendment as the primary fix.** The predicted-to-fail option. Per
`/retrospective` §4, prose is the weakest tier for a mechanizable class and must be chosen
deliberately rather than by default; six prior prose fixes in this family shipped DONE and did not
contain it. Prose still ships here — the Leg-B `claim-confidence.mdc` amendment is prose, and
correctly so: the record-versus-assertion distinction is a judgment no deterministic check can make.
It is a companion to the gate, not the fix.

**Why ADR-034's rejection does not transfer.** ADR-034 rejected a curated allowlist for symbol
identification, on the grounds that a list broad enough to cover the observed namespaces "admits
nearly every identifier-shaped token the repo touches, so it stops discriminating," and that a
cached curated set "buys a staleness surface for a problem measured at zero." Both arguments were
weighed here and one of them lands — the convergence argument is exactly why the ASD dictionary is
rejected above.

The staleness argument does not transfer, and the reason is the **direction of failure**. ADR-034's
allowlist was a **recall gate** over an open token space: a term missing from the index becomes a
silent false negative, and "a detector that returns the same answer when it is broken as when it is
healthy carries no information." An incomplete glossary at an authoring gate produces the opposite
— a **false positive**, surfaced to an author who is present, in context, and one line away from
the remedy (define the term, or add it to the glossary). The failure mode IS the intended workflow.
That asymmetry, not a difference of opinion about curated sets, is what separates the two decisions.

## Consequences

**Positive.** The family gets a blocking-tier fix at the step every prior fix missed. The glossary
answers provenance challenges directly, which is the thing the agent could not do on 2026-08-03.
The post-hoc detector gives the family its first real measurement surface. Cost is per-rule-edit,
not per-turn.

**Negative and risks.** The glossary is a new artifact with its own maintenance and its own drift;
an unmaintained glossary degrades the gate into noise, and the mitigation is that its failure is
loud (a blocked write) rather than silent. The gate cannot stop a term being spoken to the
principal in the same turn it is coined, before it ever reaches a file — that path remains covered
only by prose and the post-hoc detector, and it is retained deliberately rather than overlooked,
because no available mechanism closes it. Defining "introduces a term" mechanically is the
implementation's hard part and is where this decision could still fail on measurement; the
implementing task carries that as its own evidence gate.

**What would reopen this.** Any one of: the gate's measured false-positive rate exceeding 10% on a
classified corpus after the glossary stabilises; two or more glossary-scope expansions inside a
5-day window, which would indicate the always-loaded scope is the wrong boundary; or a harness
change exposing a pre-delivery hook on assistant text, which would make the spending step gateable
and change the whole shape.

## Replay against the originating incident

The test this record has to pass: would it have stopped "scroll"?

- **Entering `communication-contract.mdc`** — **yes.** That write is an edit to an always-loaded
  rule adding "Push into scroll" as a table cell, with no definition in the write and no glossary
  entry. The gate fires and blocks at authoring.
- **Being spoken to the principal** — **no**, and nothing can (see `## Context`). But the causal
  chain mem#824 describes runs through the file: the term read back to a later agent as sanctioned
  house vocabulary because it was sitting in an always-loaded rule. Break that link and the term
  never acquires the standing that made it spendable.
- **`R2`/`R3`** — **yes, and it surfaces the sharper problem.** The term is already in the corpus
  in two incompatible senses. A glossary with one meaning per entry cannot hold both, so the
  conflict has to be resolved at entry rather than discovered by a confused reader.

## References

- **mt#3599** — this decision. **mt#3598** — the corpus audit that seeds the glossary; it runs
  after this record is ratified, because its disposition rules depend on the mechanism.
- **mem#824** — the originating incident and the record-versus-assertion distinction Leg B ships.
  **mem#664** — the `family:principal-altitude` root, R1–R5.
- **ADR-024** — the detection-mechanism ladder. Part 3 enters as a Rung-1 consumer under §(d)'s
  coordination requirement, not independently.
- **ADR-031** — the event axis; the source of the no-generation-time-hook constraint.
- **ADR-034** — the allowlist rejection this record engages directly; see the direction-of-failure
  argument above.
- **ADR-022** — Minsky's existing vocabulary decision (workspace / conversation / transport
  session), and the closest first-party precedent for a glossary-shaped control. Its enforcement
  tier is prose. Its containment is not cleanly measurable by grep, because all three senses are
  legitimate in-repo and the rule carries deliberate carve-outs — which is itself an argument for
  part 3: a vocabulary control whose compliance cannot be measured cannot be calibrated. (Amended
  2026-09-04 by mt#4838: the transport sense is now a frozen legacy artifact, not a live one, and
  a fourth sense — the drive, working term — was added; the measurability point above is
  unaffected.)
- `/retrospective` §4 — the enforcement-tier table this decision's tier is named against. Note its
  stated scope is code-defect classes; the tier vocabulary applies here by analogy, not by
  definition.
- ASD-STE100 primary sources, read 2026-08-04: https://www.asd-ste100.org/ ·
  https://www.asd-ste100.org/STE_downloads.html · https://www.asd-ste100.org/STE_faq.html
