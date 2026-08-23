# evidence-record-provenance

**Trigger:** a `Negative control:` / `Failing-first:` or `Execution evidence:` record, written
into a commit message or a PR body, whose claimed run does not appear in the session's tool calls.

**Event / matcher:** `PreToolUse` on
`mcp__minsky__session_commit|mcp__minsky__session_pr_create|mcp__minsky__session_pr_edit`.

**Posture:** calibration-first, **record-only** — the guard emits a calibration record on every
path and injects nothing. See [Why it injects nothing](#why-it-injects-nothing).

**Override:** `MINSKY_SKIP_EVIDENCE_PROVENANCE=1`.

**Task:** mt#4044. **Tune / graduation:** mt#4067.

---

## What it is

An **evidence record** is a line whose function is to be proof that the author performed a check.
mem#966 states the rule the class violates: the record is a claim about the author's own session,
and the author is its only witness, so a reader has no way to check it.

`duplicate-check-search-provenance` (mt#4004) mechanized that shape for ONE record type at ONE
seam. Its own docblock explains why the shape is checkable where the rest of the
`assertion-without-verification` family (anchor mt#2544) is not:

> This member's claim is about the SESSION: the corresponding call either appears in the
> transcript's tool list or it does not. No judgment, no corpus, no similarity metric.

That is a property of the claim's TARGET, not of the record type carrying it — which is what this
guard generalizes.

### The originating recurrence

mem#966 point 4 said to generalize past duplicate checks on the day mt#4004 shipped. The next
instance landed the following day. mt#4024's commit `98e2ac5fd`, pushed to `task/mt-4024`, carried:

> Negative control — `SharedConversationPage > reads ONLY the public share endpoint`: swapping
> `NO_ENTITY_INDEX` for `useEntityIndex()` … makes it fail with 2 requests instead of 1 …

No control had been run at the time of the commit. It was run immediately after, self-caught, and
the real figure was **7** requests, not 2 — so the pushed claim was both unverified and wrong.
Every gate passed: mt#3244's surface checks the label is PRESENT, exactly as mt#3673 does for
duplicate-check records, and nothing asked whether the run happened.

## The discharge table

Which tool calls discharge which claim lives in `.minsky/hooks/evidence-provenance-table.ts`,
shared with the mt#4004 sibling (which consumes its search half).

| Record                | Claims                               | Discharged by                                                                        |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `Duplicate check:`    | a search ran                         | a `tasks_search` / `tasks_similar` / `refs_status` call (mt#4004, unchanged)         |
| `Execution evidence:` | one claim PER CHECK the block pastes | a run of THAT kind — test, typecheck, lint or format (mt#4236)                       |
| `Negative control:`   | a run observed FAILING               | a FAILING run that either quotes back into the record, or names the record's subject |

### Why the negative-control rule is the odd one

Symmetry would give it the execution-evidence rule, and that rule cannot see the incident. The
mt#4024 session ran `bun test` five times before the commit, so "did a test run?" is discharged.
"Did any test FAIL?" is also discharged — one had, a genuine `PublishConversationDialog` bug. What
discriminates is the SUBJECT: no failing run naming this record's own subject preceded the commit.

Two joins, either of which discharges:

- **Quoted-output join.** The record pastes the runner's `(fail) <suite> > <case>` line and that
  literal appears in a real tool result. Strong: it cannot be satisfied without the run, so a
  fabricated paste matches nothing and still fires. The per-test duration is stripped before
  comparing, since a re-run's timing differs.
- **Subject join.** Paths and backticked spans from the record, matched as exact substrings
  against a failing run's command or output. Backticked test names are split on `>`, because the
  runner interpolates into them (`SharedConversationPage (mt#4024) > reads ONLY …`), so the whole
  span never appears verbatim while both halves do.

A record offering neither is recorded `unadjudicable` — never `clean`. A record that quotes but
whose quote matches nothing is `undischarged`, not unadjudicable: the quote is a checkable claim.

### Granularity, and the ordering the free version did NOT buy (mt#4236)

At `PreToolUse` the transcript holds exactly the calls that already happened, so "before this
write" is a property of the input rather than logic the guard implements. That much is free, and
this section used to stop there — which quietly conflated two different orderings. The free one is
_the run happened before the COMMIT_. The one that matters is _the run happened before the last
EDIT it describes_, and nothing computed it.

**The originating instance (mt#4214 / PR #3082, 2026-08-17).** `validate_typecheck` ran and
returned `errorCount: 0` across eight projects. Tests were written afterwards. The PR body pasted
that `errorCount: 0` as its typecheck evidence, and CI's `build` job then failed on
`.minsky/hooks/success-criteria-coverage.test.ts(593,49): error TS2353` — in `tsconfig.hooks.json`,
a project the earlier local run HAD covered. The evidence was accurate about the tree it observed
and false about the diff it was attached to. Replayed against the real transcript, the pre-mt#4236
guard is SILENT on it.

Two gaps, and their order is the correction mt#4236's planning pass made after reading the source:

1. **Granularity comes first.** `Execution evidence:` names a BLOCK, and a block routinely asserts
   a test run, a typecheck, a lint pass and a format check at once. `sessionRanTests` collapsed all
   of them into one boolean about tests, so a typecheck pasted into that block was not adjudicated
   at all — fresh, stale or fabricated alike. **The originating instance is of THIS class**, not
   the ordering one. `hasExecutionEvidence` is now a wrapper over
   `extractExecutionEvidenceRecords`, the same move mt#4044 made on the negative-control matcher,
   so the accepted forms stay stated once (the mt#4070 hazard).
2. **Ordering second**, per kind. Each claim's LAST matching run is compared by transcript index
   against writes that follow it, filtered by what a run of that kind actually reads. `.ts` for a
   typecheck, `.ts`/`.js` for lint and tests. A `.md` edit after a typecheck is therefore `fresh`,
   not a fire.

`stale-evidence` is a third finding class, deliberately distinct from both undischarged ones
(`no-run-at-all`, `no-run-of-kind`): the run is real and the session contains it, it simply did not
observe the shipped tree. It contributes to `outcome: "matched"` — a detection recorded under
`clean` is invisible to every review that filters on fires.

**`format` records `not-comparable` rather than guessing.** Prettier's file set comes from
`.prettierrc` and `.prettierignore`, which this module does not read, so any ordering answer it
gave would be invented.

#### Why a negative control is exempt

The task spec expected ordering to apply to negative controls too. Built that way and swept over
the 14 most recent transcripts (2026-08-19), it reported `stale-evidence` on **30 of 33** discharged
control records — 91%.

That is not a finding, it is the PROCEDURE. A control is (1) revert the fix, (2) run the test and
observe it red, (3) RESTORE the fix, (4) commit. Step 3 is a write to a file the run reads, always
after step 2, for every correctly-run control. So the comparison returned `stale-evidence` whether
or not the evidence was stale — mem#704's can't-fail probe. The three that came back fresh are the
tell: those restored via `git stash pop`, a shell command `fileWrites` deliberately does not
recognize, so the axis was measuring HOW THE AUTHOR RESTORED. Negative-control claims now record
`not-comparable`.

Measured in the same sweep, the execution-evidence half discriminates: test **0/39** stale,
typecheck **6/17** (35%), lint **4/18** (22%). Re-swept after the R1 narrowing below, over the same
14 transcript FILES — which had grown in the interim, so the totals are larger and cross-run deltas
are not attributable to the change: typecheck **9/23** (39%), lint **4/24** (17%), test **0/45**,
format **0/1**, negative-control **0/41**.

#### What counts as CLAIMING a kind (PR #3165 R1)

The first cut recognized claims by bare tool nouns — `tsc`, `eslint`, `prettier` — plus a bare
`errorCount`. Every one of those matches ordinary prose, which is the exact opposite of the
conservative contract stated above, and `errorCount` was not even kind-specific: `validate_lint`
reports it too, so a lint-only block was read as claiming a TYPECHECK. That PR's own body was the
instance.

A claim now requires something a block can only carry by having PASTED a run: a runner prefix
(`bun run lint`, `bunx eslint`), a flag-bearing invocation (`tsc --noEmit`), a script-name shape
(`format:check`), a tool name that is not an English word (`validate_typecheck`), or a distinctive
output token (`error TS2353`). The originating instance still fires with identical verdicts after
the narrowing, which is what says recall survived.

The `test` kind needed the same treatment for a different reason, and it cannot be asserted the
same way: a block claiming nothing recognizable DEFAULTS to `test`, so "does prose yield a test
claim?" is undecidable in isolation. The decidable form — and the case the narrowing is for — is
whether prose ADDS a `test` claim beside a real one.

**Known false negatives, taken on purpose.** Shell writes (`sed -i`, a heredoc redirect) are not
recognized — parsing a command for an EFFECT rather than a verb invents writes that did not happen,
and firing at an author whose evidence was fine is the dangerous direction this subsystem's
direction-of-error rule forbids. A `tsconfig*.json` edit genuinely does invalidate a typecheck and
is genuinely absent from the coverage set for the same reason.

## Why it injects nothing

Unlike its mt#4004 sibling, this guard warns about nothing. The reason is a measurement taken
**before** it shipped, not caution by default.

Replaying the finished detector over the 40 most recent transcripts
(`bun scripts/replay-evidence-provenance.ts <transcript> --all`):

| kind               | discharged | fired | unadjudicable |
| ------------------ | ---------- | ----- | ------------- |
| negative-control   | 55         | 20    | 5             |
| execution-evidence | 83         | 5     | —             |

Sampling the fires found them dominated by three false-positive classes:

1. **A prose record names what was REVERTED, not the test that went red** — `closeTab`,
   `port_or_known_default`, `pendingReplyBuffer.buffer`, `segment.includes`. The record's
   vocabulary and the runner's output barely intersect. Largest class.
2. **A PR body edited in a LATER conversation than the run it reports.** The evidence exists and
   is simply not in this transcript. Structural, not a matcher problem.
3. **An `Execution evidence:` block whose evidence is not a test run** — a migration generate, a DB
   row sample. All 5 fires of that half came from one such session.

Injecting at that rate is the mem#719 failure mode: noise teaches the reader to discount the true
positives, which is worse than silence for a check whose whole value is being believed the one time
it is right. So the evidence stream is armed and nothing is injected. mt#4067 owns the tune and the
graduation decision, driven by the calibration data rather than by a second guess.

## Replay

`scripts/replay-evidence-provenance.ts` reconstructs the guard's real inputs from a recorded
conversation — the artifact text the tool was called with, and the calls that had already happened.

```bash
bun scripts/replay-evidence-provenance.ts <transcript.jsonl> --list
bun scripts/replay-evidence-provenance.ts <transcript.jsonl> --commit 98e2ac5fd --expect fires
bun scripts/replay-evidence-provenance.ts <transcript.jsonl> --commit 98e2ac5fd --as-of-line 600 --expect silent
bun scripts/replay-evidence-provenance.ts <transcript.jsonl> --all
```

A missing transcript is a SKIP, not a failure — transcripts are local harness state.

`--as-of-line` is the counterfactual knob: judge the same text against a later prefix. A check that
fires on the real ordering and still fires against the whole session is not discriminating on
order, it is just firing. On the originating incident the pair reads:

```
--commit 98e2ac5fd                    prior calls: 136   negative-control=UNDISCHARGED   FIRES
--commit 98e2ac5fd --as-of-line 600   prior calls: 164   negative-control=DISCHARGED     SILENT
```

`--all` is the false-positive sweep, and it is how the table above was produced. A fire RATE over
real history is what decides a graduation; it cannot be estimated from the cases the author
thought of.

## Wiring note

This guard's registration added the **first dispatcher entry** on the commit/PR-body seam. Those
three tool names already appeared in `.claude/settings.json`, but only on standalone hooks
(`check-branch-fresh`, `dispatch-intent-write-gate`), so no `GUARD_REGISTRY` guard could reach a
commit message until the entry existed — the mt#3823 defect class, caught in advance here by
`registry.test.ts`'s parity block. The entry's timeout is DERIVED (mt#3981): the sum of the routed
guards' budgets plus `DISPATCH_TIMEOUT_MARGIN_MS`, asserted for equality by that same block.

Landing the registration also pushed `.minsky/hooks/registry.ts` past the 1500-line `max-lines`
error tier — it sat exactly at the ceiling, so the registry's capacity to hold guards had become a
function of the lint budget. This PR briefly carried its own split to make room; mt#4055 landed the
same refactor on main first (`registry-matcher-pairs.ts`), so the rival split was dropped at rebase
and its headroom is what the new registration now uses. Two competing splits of one file is worse
than either.

## Cross-references

- `.minsky/hooks/evidence-provenance-table.ts` — the shared discharge table
- `.minsky/hooks/duplicate-check-search-provenance.ts` — the `tasks_create` sibling (mt#4004)
- `.minsky/hooks/test-first-evidence.ts` — the negative-control matcher this consumes (mt#3244)
- `docs/architecture/hooks/duplicate-signature-scan.md` — the verdict-correctness tier
- mem#966 — the rule and both recurrences; mem#719 — why a noisy detector costs more than a silent one
- mt#2544 — the `assertion-without-verification` family anchor
