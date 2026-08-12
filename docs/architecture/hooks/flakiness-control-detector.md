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

Calibration-first (mt#2263 ladder): it writes a record, does not block, and does not inject.
`INJECTION_ENABLED` is `false`; `renderWorstCase()` still renders the advisory so the size ceiling
is enforced against something real (mt#4002).

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

## Cross-references

mt#3658 (this detector) · mt#3524 (`/create-task` §2b, the prose tier) · mt#3557 / mt#3551 /
mt#3719 (the incidents) · mt#3575 (mt#3719's actual determination) · mt#3918 (the Rung-1
matcher-placement precedent) · ADR-024 · ADR-028 D1/D2
