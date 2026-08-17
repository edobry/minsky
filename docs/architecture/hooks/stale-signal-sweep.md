# `stale-signal-sweep` (mt#3959)

PreToolUse observer on `mcp__minsky__session_pr_create`. Log-only, fail-open, never denies.

## What it does

Takes the branch's diff against its merge-base with `main`, extracts the operator-facing output
labels the diff **stopped emitting**, and greps three durable corpora for artifacts that still
quote them:

| Surface       | Query                                | Scoping                                               |
| ------------- | ------------------------------------ | ----------------------------------------------------- |
| Task specs    | `task_specs` joined to `tasks`       | non-terminal statuses only                            |
| Memories      | `memories`                           | `superseded_by IS NULL`                               |
| Accepted ADRs | `docs/architecture/adr-*.md` on disk | working tree, so an ADR added by this very PR is seen |

Matching is exact substring — no similarity metric. The token is lifted verbatim from the PR's own
diff, so there is no paraphrase axis for an embedding to widen.

## Why it exists

Fixing a signal fixes it **going forward** and retracts nothing. The conclusions already drawn from
the bad signal sit in the corpus stated as fact, and keep being planned against.

Originating incident (2026-08-10/11, mt#3911 → mt#3902 → mt#3883): the `transcripts
index-embeddings` CLI printed `extracted=${turnsWritten}` — the WRITTEN count under a label that
reads as the EXTRACTED count. That one mislabel produced two false findings, including an entire
phantom defect class ("extraction yields ZERO turns from a large non-empty transcript") that was
written into one spec and handed to another as residual scope. mt#3911 shipped the label fix on
08-10; both false findings were still in the corpus the next day, being planned against, and were
corrected only because someone happened to re-run the number for an unrelated reason.

## The comment-line exclusion is load-bearing

Labels are collected from removed rendering lines, and labels the diff still emits are subtracted —
a label that merely moved is not a changed signal. **Comment lines are excluded from both sides**,
and that is not tidiness.

Running the extractor against mt#3911's real diff (not a reduced fixture) showed its added side
carries the explanatory comment:

```
// list. The previous line printed `extracted=${turnsWritten}` — the wrong
```

That counts as an added `extracted=` emission, cancels the removed one, and makes the detector
report nothing **on the exact diff it exists to catch**. It fails that way silently: a cancelled
label is indistinguishable from a label that was never dropped.

The shape generalizes past this one commit. A PR that fixes a mislabelled signal is unusually likely
to NAME the old label in a comment explaining the fix — so the cancellation is _correlated with true
positives_ rather than randomly distributed. Regression coverage:
`.minsky/hooks/output-label-tokens.test.ts` carries mt#3911's diff verbatim, and the comment case in
miniature.

## Measured false-positive shape

Measured during planning against the live corpus, for the originating token `extracted=` — six task
specs contain it:

| Task             | Reading                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| mt#3902, mt#3911 | contaminated — the two the spec named                                                    |
| mt#3883          | contaminated too, and uncounted by the spec                                              |
| mt#2864          | **correct usage** (`extracted=549`, a clean redaction re-index 3.5 weeks BEFORE the fix) |
| mt#3936, mt#3959 | meta-references discussing the incident                                                  |

So a fire is **not** self-evidently a finding, and the spec's original "precisely the two
contaminated artifacts, and nothing else" claim was wrong in both directions. Two mitigations follow
from this: terminal-status scoping (mt#2864 was already DONE at PR time, mt#3902 and mt#3883 were
active), and the ubiquity ceiling (`MAX_ARTIFACTS_PER_LABEL`), which drops a label matching more
artifacts than a genuine stale-reading cluster would.

## Posture

Log-only because the FP rate is unmeasured and known non-zero (above). Fail-open because a missed
stale reading is cheaper than a blocked `session_pr_create`, and because the sweep needs a live
database a canary process does not have — canary mode short-circuits to a recorded skip before any
DB is touched (mt#3824 R2).

Graduation to any blocking tier is gated on the spec's SC4 backtest, not on this module's authoring.
Per `/calibration-review`, a posture change routes to an operator Ask; a tune does not.

**Re-running the backtest (mt#4134).** The one-guard script this measurement came from has been
replaced by the shared replay harness:

```
bun scripts/backtest-diff-guard.ts --guard stale-signal-sweep --rev-range <a>^..<b> [--include-terminal]
```

Prefer `--rev-range` over `--days`/`--limit` for anything you intend to quote. Those two are both
CEILINGS and git applies the count one after the date filter, so the effective window is whichever
binds FIRST — and the published "60-day backtest — 400 commits, 4 fires" was a case of the count
ceiling binding: 1148 first-parent commits fell inside 60 days, so that sample actually spanned
**12 days** (2026-08-01 → 2026-08-13). The counts were right; the window label was not. The harness
now reports the span it walked and names the ceiling that bound it, so the same mislabel cannot
recur silently.

Re-run over the pinned equivalent range (`1efacf82d^..285927521`) on 2026-08-14: 400 commits, 5
dropping a label, **3 fires** — one fewer than the original 4, which is the as-of-today corpus drift
this guard's own confidence note predicts (the quoting artifact for the fourth has since closed).

## Wiring

`session_pr_create` was **not** a dispatcher-spawning tool before this guard — a registration
without the dispatcher entry in `.claude/settings.json` would never have run. `registry.test.ts`'s
dispatcher-parity block is what catches that, and it did during development. The registry entry
lives in its own module (`.minsky/hooks/registry-stale-signal-sweep.ts`) because `registry.ts` is at
the 1500-line `max-lines` ceiling.

## Override

`MINSKY_SKIP_STALE_SIGNAL_SWEEP=1` (registered in `HOOK_ONLY_ENV_VARS`).

## Cross-references

`.minsky/hooks/output-label-tokens.ts` (pure core) · `.minsky/hooks/stale-signal-sweep.ts` (shell) ·
`duplicate-signature-scan.md` (same matching class, different trigger and corpus) · mt#3913 (the
sibling defect: a field rendered NOWHERE, vs this one's rendered-under-a-wrong-name) · mt#2544
(family anchor) · mem#704 (a probe that cannot discriminate is not verification) · mem#922, mem#827.
