# Turn-End Unescalated-Incident Detector (live)

> Extracted from `.minsky/rules/hook-observers.mdc` (mt#3667) — full narration,
> cross-references, and design rationale for this observer. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

**Hook file:** `.minsky/hooks/turn-end-unescalated-incident-scan.ts`
**Event:** `Stop`
**Status:** LIVE (injecting)
**Override:** `MINSKY_ACK_UNESCALATED_INCIDENT`

## What it detects

A `Stop`-event scan (mt#3593). It fires when the turn's final message **reports an incident AND
names the remediation as the principal's**, and the turn contains **no `asks_create` carrying
`severity: "incident"`**.

The pairing is the whole point: an incident the agent can fix itself does not warrant the
severity marker, and an operator-only chore that is not a severity event belongs in the ordinary
inbox. Only the intersection — a severity event whose remediation is operator-only — should have
escalated the ask's transport.

## Why it is LIVE rather than calibration-first

Deliberately not calibration-first. The family had already spent a prose fix — `mt#3436`, the
severity-transport-binding rule text — and that fix failed three days later with the rule's own
wording verbatim in the agent's context. A log-only third tier would have stopped nothing. It
still writes its calibration record, so the false-positive rate stays measurable even though the
detector injects.

## Why its predicate is a hybrid

It is a hybrid of its two `Stop` siblings by necessity:

- `turn-end-untaken-action` keys on a **phrase** in the final message.
- `turn-end-unwalked-task` keys purely on **tool-call state**.

This one must read the final message for its TRIGGER, because no tool call means "an incident
happened" — there is no mutation that marks it. The ABSENCE half (no severity ask) is structural,
read from tool-call state. Neither sibling's approach alone can express the predicate.

## It reads the argument, not just the call

An `asks_create` **without** the severity marker does not count as discharge. That shape — ask
filed, principal never told — is exactly the R1 incident (mt#3433 / mem#779), where a correctly
diagnosed, correctly filed, correctly severity-reported incident still cost roughly four hours of
avoidable downtime because no notification was sent.

## What it deliberately does NOT check

It does **not** look for a `principal_notify` call. After mt#3595 the substrate sends the
notification itself from the `severity: "incident"` marker, so a correctly-handled incident
contains no such call by design. A predicate requiring one would have fired on every correct
handling — the superseded shape.

## False-positive containment

Quoted and fenced code spans are elided before matching, so a turn that _discusses_ the guard —
this page's own subject matter, for instance — does not trip it.

## Cross-references

- mt#3593 — this detector.
- mt#3436 — the prose fix that preceded it, and failed.
- mt#3595 — the substrate change that made `principal_notify` redundant.
- mt#3433 / mem#779 — the originating incident.
- `communication-contract.mdc §Severity transport binding` — the rule this enforces.
