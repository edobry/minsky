# duplicate-signature-scan

> Extracted from `.minsky/rules/hook-observers.mdc` (mt#4032) — full narration, the three-tier
> relationship to its siblings, and design rationale. The compiled rule corpus carries only a
> terse index entry; this file is the durable detail.

Checks whether a new task's **duplicate-check record is TRUE**, by looking for signature tokens
the spec shares with an active task it does not concede overlapping.

- **Event:** `PreToolUse` on `mcp__minsky__tasks_create`
- **Enforcement:** calibration-first — records, never denies.
- **Override:** `MINSKY_SKIP_DUPLICATE_SIGNATURE_SCAN=1`
- **Source:** `.minsky/hooks/duplicate-signature-scan.ts` + `.minsky/hooks/duplicate-signature-tokens.ts`
- **Task:** mt#3722

## Three tiers on one record

`/create-task` Step 1a asks the author to record a duplicate check. Three separate guards ask
three different questions about that record, and they are easy to confuse:

| Guard                                               | Question                    | Tier        |
| --------------------------------------------------- | --------------------------- | ----------- |
| `require-duplicate-check-record` (`hook-files.mdc`) | is the record PRESENT?      | deny        |
| **this one**                                        | are its VERDICTS true?      | calibration |
| `duplicate-check-search-provenance` (mt#4004)       | did the claimed search RUN? | calibration |

## Exact substring, no similarity metric — and why

Signature tokens are routes, source paths, and backticked identifiers. The scan runs them as
**one OR-ed query** over `task_specs` and looks for an active task the record does not name.

It deliberately does not use embeddings. The advisory embedding sibling provably cannot
discriminate at the distances real duplicates sit at — mem#819 has the measurement — so a
similarity metric here would produce a confidence-shaped number with no discriminating power.
An exact substring hit is a fact about the two specs.

## What was cut pre-ship, and what is a live tune candidate

A **fourth rule** (matching on cited `mt#NNNN` refs) was cut before shipping at **4/4 false
positives** — an agent citing related tasks is doing the right thing, not duplicating them.

Live tune candidate, threshold met: a match whose ONLY token is a registered env-var or
exported-constant name cited as CONTEXT rather than as subject. Three recorded instances —
`config_credentials_list` in mt#3999, five of six hits on mt#4032, and
`MERGED_CONTEXT_BUDGET_CHARS` in three of four hits on mt#4047. Per
`decision-defaults.mdc §Thresholds` (3+ in 5 days) that is a tune candidate for the next
`/calibration-review` on this guard, not a fix to make inline.

## Covers / Does NOT cover

**Covers:** a spec that shares a concrete signature token with an active task its duplicate-check
record does not concede.

**Does NOT cover:** a genuine duplicate phrased with no shared tokens — the case a similarity
metric would be for, and the case mem#819 shows it cannot actually reach. Nor does it judge
whether a conceded overlap was reconciled CORRECTLY; that stays a human read of the record.

## Cross-references

`.minsky/rules/hook-files.mdc` (`require-duplicate-check-record`, the deny sibling) ·
`duplicate-check-search-provenance.md` (the third tier) · mem#819 (why not embeddings) ·
mt#3673 (the deny tier) · mt#4003 / mt#4004 (the provenance incident and tier) ·
`.claude/skills/create-task` Step 1a (the record this checks).
