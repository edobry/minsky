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
