# flakiness-control-detector

Records a `tasks_create` whose spec claims something about a test failure's MODE — that it is
flaky, or equally that it is not — without recording the isolation control that would settle it.

Index entry: `hook-observers.mdc`. Override: `MINSKY_SKIP_FLAKINESS_CONTROL=1`.
Matcher: `packages/domain/src/detectors/flakiness-attribution.ts`. Adapter:
`.minsky/hooks/flakiness-control-detector.ts`.

## What it is for

The isolation control is one command: run the file alone. It costs about thirty seconds and it
discriminates. A spec that skips it routes the work toward a tolerance-shaped remedy — a bigger
timeout, a retry, a quarantine lane — on an unchecked premise.

In every recorded incident the premise was wrong, and the two directions of error cost
differently:

- **mt#3557** filed three CI timeouts as flaky. Run alone they FAILED: the tests resolved live
  Telegram credentials and sent real messages to the principal's channel on every full-suite run.
  Every tolerance-shaped fix would have preserved the live sends.
- **mt#3551** filed a wall-clock assertion "failing at ~5002ms against a 5s bound." That was bun's
  DEFAULT per-test timeout rather than the assertion; the real bound is 13s and is never reached.
- **mt#3719** filed the DENIAL: "not load-dependent and not timing-dependent … it fails
  deterministically." The control falsified it four minutes later — the file passes alone (3 pass),
  its whole directory passes together (1533 tests), and only the 802-file run fails. The cause was
  cross-file pollution of a module-level singleton: order-dependence, the class the spec ruled out
  by assertion.

Three filings in two days, in opposite directions, all settled by the same command.

## Why the denial fires

A spec asserting a failure is NOT in some class makes a causal claim about failure mode exactly as
much as one asserting it IS. It is the more dangerous shape because it reads as the careful,
already-investigated verdict, so a reader is less likely to ask for the control — which is what
happened to mt#3719.

The two families are matched by separate pattern lists and recorded separately. They share a
remedy, but a false-positive review needs to size them independently: a denial is the likelier
false positive, because a spec may legitimately deny a class it actually did test.

## What silences it

Either evidence shape `/create-task` §2b prescribes:

- **An isolation control** — a test invocation AND at least one observed count (`bun test … → 17
pass / 0 fail`). Both halves are required: a bare command is a plan, not an observation, and the
  failure this detects is precisely a spec that names what WOULD settle the question without saying
  what happened when it was asked. Checked document-wide, because a control that was run is
  evidence wherever it is recorded.
- **The literal `UNVERIFIED`**, within 600 characters of the claim. Checked for PROXIMITY, unlike
  the control: §2b says the marker goes "near the attribution", and a spec that marks some other
  claim `UNVERIFIED` three sections away has not marked this one.

A control that FAILS in isolation is the useful outcome — it means a real defect wearing a timing
costume, which is mt#3557 exactly. The matcher therefore accepts a fail-only observation; requiring
a pass count would miss the most valuable case.

## Posture

Calibration-first (mt#2263 ladder), which in this family means log-only WITH a warning: it writes a
record AND surfaces a WARN, and never denies. Not record-only — the spec asks for the warning (SC2,
AT1), and the local precedent agrees; going silent as well would mean the agent filing the spec
learns nothing until someone reviews the log, which is most of the value gone. What calibration
buys is that the guard never DENIES while its false-positive rate is unmeasured.

Because it injects, its ceiling is measured from a `worstCaseCanary` rather than a `renderProbe` —
a probe is for a guard that renders but never injects, and leaving one here would exclude this
guard from the `MERGED_CONTEXT_BUDGET_CHARS` bucket it genuinely contributes to (mt#4002).

Its deny-tier neighbour on the same surface, `require-duplicate-check-record`, records why the two
differ: a literal-form presence check has no recall/precision axes, so there is nothing to
calibrate. This one matches prose vocabulary, which has both and a real paraphrase frontier.
Flipping it to blocking is the graduation decision the calibration data exists to inform, and it
needs an operator disposition via `/calibration-review`.

**Do not answer a paraphrase miss by widening the pattern lists.** That is the arms race ADR-024's
`## Context` exists to end; Rung 2 (embedding nomination) is the documented escalation and is gated
on measured recurring misses.

## Where the matcher lives, and why

ADR-024's ladder governs the `UserPromptSubmit` guidance-hook family, which matches trigger phrases
in the agent's own prose; this reads a tool call's payload, like the execution-evidence merge gate,
so Rung 1 is right on the merits rather than by default.

But ADR-024's Decision clause separately requires matchers to be built on the shared
`packages/domain/src/detectors/` framework "so all guidance hooks consume one mechanism instead of
divergent regex copies". So the matcher lives there and the hook is a thin adapter, following the
mt#3918 precedent.

## Recorded fields

Beyond the matched claims and their excerpts, each record carries both evidence flags separately —
so a review can tell "no evidence at all" (a true positive) from "evidence present but not where
the check looked" (a matcher bug) — plus `singleFileAcceptanceTestSuspected`.

That last one is a **sizing signal, not a trigger**. mt#3719's acceptance test was "with a
reachable database configured, run the file — it passes", which was already true of the unfixed
code and so could never distinguish a fix. A flakiness-class spec whose acceptance test is a
single-file run, when its evidence came from a full-suite run, is asserting a control it did not
run. It is recorded rather than matched on so a later pass can measure how common the shape is
before deciding whether it earns its own matcher.

## mt#4166 — the two silencers, and why the denial one is a label

Two days after this detector shipped DONE, it stayed silent on mt#4158, a spec whose central
claim — "the failure is deterministic, not flaky" — was false for exactly the reason the detector
exists to catch. The matcher was not at fault; it found the denial. **Both silencers fired, for
reasons unrelated to the denial.**

**Silencer 1 — counts from one condition.** `hasIsolationControl` accepted the spec's recorded
`55 pass, 12 fail, Ran 67 tests`. Those counts were real, and were taken on a machine
simultaneously running a 900-second full suite plus several concurrent agent sessions. Counts
establish WHAT happened; they do not establish that the confound was HELD CONSTANT. For an
attribution that gap is tolerable — the counts at least show the failure is real. For a denial it
is disqualifying, because a denial is a claim about behavior ACROSS load conditions and a
single-condition measurement cannot reach it (mem#821: "to test a hypothesis about a threshold,
you need observations that straddle it").

**Silencer 2 — a marker excusing a claim it was not about.** `hasUnverifiedMarkerNearClaim`
returned one document-wide boolean, so a marker within 600 chars of ANY claim excused EVERY claim.
On mt#4158 an honest `UNVERIFIED` — attached to a side note about whether slow MCP calls shared a
root cause with the slow boot — landed 255 chars from the unrelated word "intermittently" and
thereby excused the load-bearing denial 2,146 chars away. Resolution is now per claim.

### Why the denial silencer is an authored label and not an inference

The obvious fix is to infer the straddle from prose: pair each observed count with a nearby
condition word (`idle machine`, `in isolation` vs `under load`, `full suite`, `concurrently`) and
require one of each family. That was prototyped and **measured against the real mt#4158 text. It
does not discriminate** — mt#4158 and a genuine two-condition record both score "two conditions
present".

The reason is structural, not a tunable window. mt#4158 **claims** `idle machine` (falsely) and
separately **discusses** the full gated suite as the thing that is broken, so both vocabularies
are genuinely near counts. The difference between measuring two conditions and mentioning two
conditions is not in the text — it is in what the author did. **A detector cannot catch a false
statement about the environment.**

So a denial is discharged by a literal `Load control:` record, the same shape `Negative control:`
(mt#3244) and `Execution evidence:` (mt#1459) use for the same class of unknowable: the author
states it and owns the claim. Accepted forms follow mt#3778's lesson — heading or plain label,
optional `**bold**`, optional leading bullet, colon required on the plain form, optional
dash-subject — and a FENCED label does not count (mt#3511/mt#3584), because a quoted convention is
not an assertion of it.

**The label alone is not the record (PR #3034 R1).** The reviewer caught two shapes the first
implementation admitted, both of which carry the label while asserting the opposite of
compliance: the disclaimer (`Load control: was never run`) and the bare heading (`## Load
control` with nothing under it). `hasLoadControl` therefore requires the label to be backed,
within 600 chars, by **two** test invocations and at least one observed count — two, because a
denial is a claim across conditions and one run cannot discharge it however it is labelled.

That check is deliberately structural rather than a negation vocabulary (`never run`, `pending`,
`TODO`): "was never run" is one phrasing of unboundedly many, and chasing them is the paraphrase
arms race ADR-024 §Context exists to end. A record with two runs in it cannot be a disclaimer.

A false `Load control:` record — two invocations and counts that were never observed — is a lie,
and catching lies is not this guard's job. Making the OMISSION visible is.

### A shadow attribution inside every denial

Per-claim resolution exposed a latent bug the document-wide form had hidden: `not load-dependent`
CONTAINS `load-dependent`, so the attribution pattern matched inside the denial and recorded a
second, contradictory claim about the same words. Harmless while one control silenced the whole
document; under per-claim resolution it is a claim that stays lit no matter what evidence the
author records. `extractFlakinessClaims` now skips an attribution match falling inside an
already-recorded denial span — which is what the function's own comment always said it was doing.

## Cross-references

mt#3658 (this detector) · mt#4166 (the two-silencer containment) · mt#3524 (`/create-task` §2b,
the prose tier) · mt#3557 / mt#3551 / mt#3719 (the incidents) · mt#4158 (the recurrence-after-DONE)
· mem#1048 (the bridge memory) · mem#821 (straddle the threshold) · mem#1047 (a proxy answers a
different question) · mt#3575 (mt#3719's actual determination) · mt#3918 (the Rung-1
matcher-placement precedent) · ADR-024 · ADR-028 D1/D2
