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

| Record                | Claims                 | Discharged by                                                                        |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `Duplicate check:`    | a search ran           | a `tasks_search` / `tasks_similar` / `refs_status` call (mt#4004, unchanged)         |
| `Execution evidence:` | a test run             | any test-running call                                                                |
| `Negative control:`   | a run observed FAILING | a FAILING run that either quotes back into the record, or names the record's subject |

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

### Ordering is free

At `PreToolUse` the transcript holds exactly the calls that already happened, so "before this
write" is a property of the input rather than logic the guard implements.

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
error tier — it sat exactly at the ceiling — so the registry's query layer moved to
`.minsky/hooks/registry-queries.ts`. Data versus queries over it, one-way import; a file-level
disable would have removed the signal instead of the cause.

## Cross-references

- `.minsky/hooks/evidence-provenance-table.ts` — the shared discharge table
- `.minsky/hooks/duplicate-check-search-provenance.ts` — the `tasks_create` sibling (mt#4004)
- `.minsky/hooks/test-first-evidence.ts` — the negative-control matcher this consumes (mt#3244)
- `docs/architecture/hooks/duplicate-signature-scan.md` — the verdict-correctness tier
- mem#966 — the rule and both recurrences; mem#719 — why a noisy detector costs more than a silent one
- mt#2544 — the `assertion-without-verification` family anchor
