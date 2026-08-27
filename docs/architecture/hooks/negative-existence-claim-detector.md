# Negative-Existence-Claim Detector (calibration)

> The compiled rule corpus (`hook-observers.mdc`) carries only a terse index entry; this
> file is the durable detail — mechanism, incident history, design rationale, and
> false-positive posture. Read this before changing, citing, or reasoning about the hook.

A `UserPromptSubmit` observer for one narrow, mechanizable slice of the
`assertion-without-verification` family (anchor mt#2544):

> A **negative existence claim** — "X is never called", "nothing implements Y", "zero call
> sites", "no consumer reads Z" — written into a **durable artifact**, justified by a search
> that was **thin** (zero or one hits) or **narrow** (scoped to a proper subtree of the repo),
> about a capability a task in **DONE** status claims to
> have delivered.

It does not judge whether the claim is TRUE — an intractable question. It says: _you are
asserting absence from a thin search, about something a shipped task delivered; read that
task's diff before this lands._

**Hook file:** `.claude/hooks/negative-existence-claim-detector.ts` (source
`.minsky/hooks/negative-existence-claim-detector.ts`)
**Matcher:** `packages/domain/src/detectors/negative-existence-claim.ts`
**Override:** `MINSKY_ACK_NEGATIVE_EXISTENCE_CLAIM`
**Calibration log:** `.minsky/negative-existence-claim-calibration.jsonl`
**Evaluation stream:** `.minsky/negative-existence-claim-evaluations.jsonl`

## Originating incidents

Three uncontained recurrences; the third is the replay fixture in AT1.

**Instance 3 (2026-08-10, mt#3916 — retracted same session; mem#924).** While planning
mt#3881 the agent checked whether mt#2677's MCP progress mechanism had ever been called:

```
grep -rn 'progress?\.(' src packages --include='*.ts' | grep -v '\.test\.'
```

One hit — a doc comment. The conclusion written into a durable artifact was "zero production
call sites; no long-running tool has ever emitted progress." It was **false**. The bridge does
not hand handlers a bare `progress`; it puts the reporter on the execution context as
`onProgress`, and `grep onProgress` returns 25 hits across three wired tools — including the
very tool mt#2677's originating incident was filed against.

Two cheap falsifiers existed. Grepping the thing that CONSTRUCTS the capability rather than the
capability's own name settles it in seconds. And mt#2677 was **DONE** — a task claiming to have
shipped this is a reason to read what it shipped, not to assume it shipped half.

What makes the class worth mechanizing is that nothing about it looked sloppy: the grep ran,
returned a real number, the number was reported honestly, and a full `/plan-task` gate battery
walked cleanly on top of it — gate (o) even recorded the claim as "verified by grep, not
inferred." The defect was in the PATTERN, so every downstream check inherited it. That is why
the detector keys on the SHAPE of the evidence rather than on the claim's plausibility.

## Why this sub-shape and not the family

mt#2544's 2026-08-08 entry deliberately declined a family-wide detector: most of the family
needs semantic judgment. This slice does not. All three conjuncts are machine-checkable, and
the falsifier is deterministic — `git log`/diff on the cited DONE task shows what it shipped.

## The three conjuncts

| #   | Conjunct                                                                         | Where the evidence comes from                                                                                          |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | A negative-existence claim in durable-artifact prose                             | `buildArtifactProseCorpus` (mt#3642), markdown-elided                                                                  |
| 2   | A same-turn search was THIN (<=1 hit) **or** NARROW (scoped to a proper subtree) | search-class `tool_use` joined to its `tool_result` by `tool_use_id`; scope classified from the search's path argument |
| 3   | The prose cites an `mt#N` that is DONE                                           | one bounded `select id from tasks where id in (...) and status = 'DONE'`                                               |

**Conjunct 1 reuses mt#3642's extraction rather than adding a second reader.** That task
extended `code-mechanism-assertion` to scan PR bodies, spec patches, memory bodies and ask
justifications as `tool_use` INPUTs — exactly where this incident's false claim landed. Inline
code is deliberately KEPT during elision (fenced blocks and blockquotes are not), because
"`onProgress` has no callers" is precisely the claim being detected.

**Conjunct 3 runs only after 1 and 2 already hold**, so an ordinary artifact-writing turn costs
no database round trip.

## The two failure directions point OPPOSITE ways, deliberately

This is the design decision most likely to look like an inconsistency, so it is recorded
explicitly.

- **Conjunct 3 fails TOWARD firing.** When the DONE lookup cannot run, every cited id is
  admitted and the record carries `doneLookupUnavailable: true`. ADR-032: _a guard tuned into
  permanent silence is indistinguishable from a dead one._ This family exists because
  silent-when-broken costs weeks to notice, and reporting a false positive is recoverable while
  reporting nothing is not. The flag lets a calibration pass separate these from confirmed hits
  rather than pooling them. Same reasoning as mt#3991's `withoutExistingIds`.
- **Conjunct 2 fails AWAY from firing.** A search result whose shape could not be counted is
  NOT treated as thin. That failure is evidence about the PARSER, not about the corpus —
  treating it as thin would make every unfamiliar tool output a fire.

The asymmetry is the point: in one case the dependency is unavailable, in the other the input
is unrecognized. They warrant opposite defaults.

## The scope leg (mt#4362)

Conjunct 2 originally tested hit COUNT alone. That models thin evidence by **volume**, and the
family's oldest axis is **territory**: a search can be narrow in scope and rich in hits. A
subtree-scoped grep returning eight hits reads as thorough by exactly the signal the detector
measured, while warranting nothing about the ground outside that subtree.

The originating instance is this repo's own: implementing mt#4359, an agent wrote
_"truncateToCodePoints currently has NO call sites"_ into a durable docblock on the strength of
`grep -rn "truncateToCodePoints" .minsky/hooks/` — one directory, **8 hits**. Repo-wide the
symbol appears 16 times. Re-checked, the claim was TRUE, which is what makes the class nasty:
the WARRANT was defective and the CONCLUSION was fine, so no outcome-based check could ever
surface it. `minsky-reviewer[bot]` caught it as NON-BLOCKING on PR #3192; no gate did.

### Scope is classified in the ADAPTER, not the matcher

The matcher reads a `scope` field; it never parses a command string. The grammar that extracts a
path from one (`command-shape.ts`'s `suppliesPattern` + `nonFlagOperands`, consolidated by
mt#4328 and consumed here via `nonexistent-search-path-detector`'s `tokenize`/`pathArgs`) lives
in the hooks tree, and `packages/domain` does not import from there. Classifying in the adapter
consumes the shared grammar exactly once and forks no second parser.

### Three buckets, because the covered tools do not agree on where scope lives

| Bucket          | Tools                                                              | Where the scope comes from                    |
| --------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Shell           | `grep` / `rg` / `ag` / `ack` / `ugrep` via `Bash` / `session_exec` | path operands, parsed by the shared grammar   |
| Structured path | `Grep`, `Glob`, `repo_search`, `git_search`                        | the call's `path` input — no grammar involved |
| Unscopable      | `tasks_search`, `transcripts_search-text`, `session_grep_search`   | no path PREFIX dimension exists               |

Shell-only was considered and rejected: four of the seven covered tool names carry a structured
path, and a `Grep` with `path:` is now at least as common a subtree-scoped shape as a shell
`grep`. Covering only the shell case would leave the larger hole open.

`session_grep_search` is the interesting member of the third bucket — it narrows by
`include_pattern`, a glob FILTER over the whole workspace rather than a path prefix. That is a
real narrowing axis this leg deliberately does not model, so it is classified `unscopable`
**explicitly** rather than allowed to fall through, because "we cannot tell" must never be
silently read as "repo-wide".

### A search naming no path is REPO scope

`grep -rn PATTERN` with no operand defaults to cwd, and the hook runs with the repo root as cwd.
Stated failure mode: an agent that had `cd`'d into a subdirectory would have a genuinely
subtree-scoped search classified `repo` and go unflagged. That direction is a MISS rather than a
false fire — the right way to be wrong for a calibration-first widening.

### A claim carrying the qualifier is the CORRECT case and must not fire

The defect is an unqualified claim resting on a qualified search. "No call sites under
`.minsky/hooks/`" after grepping `.minsky/hooks/` is exactly the authoring this guard exists to
teach, so it is suppressed — compared against the ACTUAL searched path, not against "a qualifier
is present", since a claim scoped to a DIFFERENT subtree is still unqualified about the
territory the evidence came from.

The suppression uses `every`, not `some`: one unqualified claim in a turn is still an
unqualified claim, and silencing a turn because a sibling sentence was careful is the
over-suppression this family keeps re-learning.

**The qualifier test gates only the scope leg.** A repo-wide search returning one hit is thin
however the sentence is worded, so count-thin searches are admitted exactly as before — which is
also what keeps the post-change replay delta attributable to this widening alone.

## Rung placement (ADR-024)

**Rung 1**, the ladder's default stopping point, and on the merits rather than by default: a
claim-phrase match, a hit count and a task-status lookup are all deterministic.

**Do not answer a paraphrase miss by widening `NEGATIVE_EXISTENCE_PATTERNS`.** That is the arms
race ADR-024's `## Context` exists to end. Rung 2 (embedding nomination,
`packages/domain/src/detectors/embedding-nomination.ts`) is the documented escalation, and it is
evidence-gated: measured recurring paraphrase misses, not an opening move. The sufficiency bar
for any rung change is ADR-024 sign-off (b) — 0 known-FP and <=5% new false-negative, measured
on the existing calibration logs.

The phrase family is deliberately SMALL. Discriminating power here comes from the CONJUNCTION,
not the phrase list: a thin search plus a cited DONE task is already suspicious independent of
how the sentence is worded.

## Why the matcher lives in `packages/domain/src/detectors/`

ADR-024's Decision clause requires the ladder be "built on the shared
`packages/domain/src/detectors/` framework so all guidance hooks consume one mechanism instead
of divergent regex copies."

mt#3918's SC6 asked the detector to "resolve its matching through" that framework. Read
literally that is not satisfiable: **there is no Rung-1 matcher there to resolve through.**
`embedding-nomination` is Rung 2; mt#1035's `Detector` interface returns `DetectionSignal[]`
destined for the Ask router, a different surface that no guidance hook implements.

So the clause is satisfied the only way it can be at Rung 1 — the matcher lives in the shared
package and the hook is a thin adapter (corpus extraction, the status lookup, the evaluation
stream, the fire log). This also serves the mt#3999 coordination directly: that task reads the
same surface with a narrower third conjunct and is required by its own spec to consume this
extraction rather than ship a second copy. A hook-local matcher would have forced it to import
from the hooks tree, which is the divergence ADR-024 names.

If a shared Rung-1 matcher later lands, this module is what it generalizes from.

## Two shared-helper additions

- `transcript.ts` now EXPORTS `extractToolResultText` (was module-private). It is the only
  correct way to read a `tool_result` body.
- `transcript.ts` gains `findToolCallsWithResults` — the `tool_use` -> `tool_result` join that
  `findCreatedResourceIds` and `findDeniedToolCalls` each perform inline. This would have been
  the third copy. It carries `hasResult` separately from `resultText` because an empty body and
  a call with no result are different facts: a search that found nothing returns `""`, a call
  still in flight returns nothing, and a hit-counter must not read the second as zero.

## Posture and enforcement

**Calibration-first** (`INJECTION_ENABLED = false`). It writes an evaluation record for every
artifact-writing turn — fired or not, with each conjunct's outcome — so the MISS rate is
measurable rather than just the hit count. A fire-only log cannot distinguish "precise" from
"dead" (mem#534).

The population it measures is artifact-writing turns; a chat-only turn writes no record and
does not enter the denominator.

Flipping `INJECTION_ENABLED` is an **enforcement-posture change and therefore the operator's
call** (mt#3769), decided from the evaluation stream by a `/calibration-review` pass.

**Owed before that flip:** the advisory's DONE-task-id axis has no `…and N more` cap, so its
`attentionCost` (1600, measured 1559 saturated) is classified `render-probe-sample` — a
saturated sample, not a proved ceiling.

## Coverage receipt

ADR-024's done-gate applies: >=1 `source:"live"` true positive within 7 days of ship; zero live
fires in 7 days is a finding about the detector, not a formality. No separate wiring was
needed — `buildCalibrationLogToGuards` derives the receipt from the registration's
`calibrationLog`, verified live rather than assumed.

## Cross-references

mt#3918 (this detector) · mt#2544 (family anchor) · mem#924 (instance 3) · mem#534
(coverage receipts) · mt#3642 (the artifact-prose surface reused here) · mt#3991 (the
bounded-lookup and fail-toward-firing precedent) · mt#3314 (the prose tier this escalates from)
· mt#3999 (consumes this matcher) · ADR-024 (the ladder) · ADR-032 (silence is
indistinguishable from death).
