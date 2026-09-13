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

| Record                | Claims                               | Discharged by                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Duplicate check:`    | a search ran                         | a `tasks_search` / `tasks_similar` / `refs_status` call (mt#4004, unchanged)                                                                                                                                                    |
| `Execution evidence:` | one claim PER CHECK the block pastes | a run of THAT kind — test, typecheck, lint or format (mt#4236)                                                                                                                                                                  |
| `Negative control:`   | a run observed FAILING               | a FAILING run that either quotes back into the record, or names the record's subject — plus three discharge-only signals (mt#4306): its summary counts as the record states them, an abbreviated quoted line, a bare identifier |

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

#### Three more discharge SIGNALS, none of which condemns (mt#4306)

The two joins above decide both halves — whether a record is judgeable, and whether it is
discharged. mt#4067 measured what happens when a widening reaches the first half: 22 records
dragged from `unadjudicable` into `undischarged`, fires 108 → 129. So everything added since is
matched on the discharge side only; a key that names no run leaves the verdict exactly where it
was. The three, each measured on a frozen population (198 transcripts modified in the 14 days to
2026-09-11, replayed at their recorded line counts) against the four known true positives — the
mt#4024 commit `98e2ac5fd` and the three mt#5078 labelled — none of which any of them touches:

- **Count-pair join.** The record states the red run's summary counts as ONE phrase — `17 pass /
7 fail`, `0 pass, 5 fail`, `5 of 10 failed` — where the runner prints two lines, so neither join
  above can see a paste that was in substance there (3 of mt#5078's 8 labelled join-misses). Both
  numbers must agree with one run's own summary; a lone `1 fail` is not a key. The degenerate
  `0 pass, 1 fail` pair is excluded, and the exclusion is measured rather than guessed: it matched
  an unrelated single-test failure 240 lines earlier in four of four cases, the only false
  discharges the first cut produced. 154 → 133 undischarged; two samples of five read in full,
  9 of 10 the control's own run (the tenth is the excluded pair).
- **Abbreviated quoted line.** A pasted `(fail)` line an author cut with `…` matches when its
  ≥12-character segments appear in order in a failing run's output. Only a line carrying an
  ellipsis takes this path — an exact line is still matched exactly. 5 more.
- **Bare-identifier join.** The subject extractor reads backticked spans and paths, which is the
  right bound for a key that decides adjudicability. An author who writes the subject bare —
  `removing SESSION_START_TOOL_NAME from the set fails it` — and then backticks the incidental
  identifiers of the next sentence hands it the wrong tokens; the `e151405d` record's `sed`
  command and output both carried the subject verbatim and the join still missed. SCREAMING_CASE
  and camelCase identifiers outside backticks are now matched the same way, discharge side only.
  14 more (13 of 14 the control's own run on reading; the 14th a genuine script-shaped control
  credited to an adjacent red run — mt#4309's class).

Net on the frozen population: negative-control **154 → 114 undischarged**, 53 → 33 unadjudicable,
396 → 456 discharged; every execution-evidence count unchanged.

**Two candidates measured and rejected in the same pass, so they are not re-proposed.** Scoping
the subject tokens to the control's own sentence (the "tokens bleed into the next sentence"
reading) recovered 0 — the cause was the bare identifier, above. The revert-edit CONTENT join —
a write-tool input naming the subject, followed by any failing run — recovered 83 and discharged
3 of the 4 true positives, `98e2ac5fd` included: an unrelated red run after an ordinary edit is
common, so the ordering carries no information. That is mt#4044's rejection, now with numbers.

#### A control run WITHOUT a test runner (mt#4309)

Every join above runs over `failingTestRuns` — calls whose command is a test-runner invocation
and whose output carries a runner's failure marker. A control run any other way could never enter
that set, so its record fired whatever it pasted or named. mt#4067 measured the class at 3 of 96
(3.1%) on the artifact side; re-measured at planning over 21 days of parent and subagent writes,
judged against the writer's own prefix (post-mt#5108), it was not one class:

| shape                                                                                                            | claims | disposition                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| runner spellings `TEST_RUN_COMMAND_RE` missed — `bun --cwd <dir> test …`, `bun scripts/run-related-tests.ts …`   | 11     | recognized; real runners, zero false-discharge risk, and `run-related-tests` now also feeds the ordering join's "last test run" |
| a script-harness or probe RUN reporting failure in its own vocabulary (`exit=1`, `13/14`, `FAIL`, `✗`, `Error:`) | 11     | recognized — `failingHarnessRuns`, joined by the same subject/quoted/count joins                                                |
| a typecheck-shaped control: a scratch module through `bunx tsgo --noEmit`, observed `error TS…`                  | 2      | recognized — `failingTypecheckRuns`, COMMAND invocations only                                                                   |
| a read of a log the run wrote (`tail -30 …/related.log`, a saved CI job log)                                     | 6      | deliberately NOT recognized; see below                                                                                          |

**The load-bearing half is run-vs-read, and it was found by the failure it prevents.** The obvious
widening — any command whose output carries a failure marker and names the subject — produced 45
candidates, of which 22 were `sed -n` of a source file, `cat` of a script, `grep -rn` over the
tree or a spec read whose TEXT happened to contain `FAIL` or `Error:` beside the subject's name.
Each would have been a false DISCHARGE, the direction the table module's header forbids. So a
harness run must INVOKE something: `leadingPrograms` strips `VAR=…`, `cd …`, `timeout N`,
`sleep N` and takes each statement's first word; `isRunShapedCommand` needs at least one
interpreter, package runner, `minsky`, or script-by-path among them and no `--help`; a command
that is reads end to end is not a run whatever it prints. The `validate_typecheck` TOOL was
tried as a fourth shape and rejected on the same sweep: 8 discharges, every one a transient
mid-edit type error that happened to name the subject.

Measured on the frozen population (`scripts/measure-control-recognizer-classes.ts`, the same
script on both trees): 657 distinct control claims, undischarged **123 → 99**; discharged
runner 487 (unchanged) + runner-widened 11 + harness 11 + typecheck 2. Every one of the 24 was
read, and none of the 22 read-shaped candidates moved. The residue (99) is mt#4306's vocabulary
class (78), green runs (15), the two log reads, and four with nothing naming the subject.

The log-read class stays a miss on purpose: the run was backgrounded or ran in CI and its output
reached the transcript through a `tail`, which is indistinguishable in SHAPE from the 22 false
candidates. Recognizing it needs a way to tell a run's log from any other file; recorded here so
it is not re-proposed as a plain widening.

Also closed here, from PR #3143's approving review: `extractQuotedFailures` now strips ANSI
BEFORE testing a line against the quoted-line markers, so an anchored `FAIL` preceded by an
escape is extracted and the comparison reuses the same normalized line. Measured inert (0 of 186
red results carry an escape); pinned by a unit test.

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

#### Which writes count: only those inside the workspace (mt#5087)

The write side was bounded by EXTENSION alone, and mt#5078's classification of the newest 15
`stale-evidence` records found the one shape that slips through: a conversation wrote a probe
script to its scratchpad (`<scratchpad>/sc3b.ts`, four edits, then `axis.ts`) after its last test
run, and the run of the REPO was reported stale — 9 of 10 sampled claims were true, this was the
tenth. A run cannot have observed a file outside the tree it ran in, so `fileWrites` now takes a
`WorkspaceScope` and drops any write that lands outside it:

- a **relative** path is inside — only a session tool emits one, and it resolves against the
  session workspace; the harness's `Write`/`Edit` require an absolute path;
- an **absolute** path is inside under the repo root walked up from the hook's `cwd`
  (`findRepoRoot`, so a subdirectory cwd still names the root), or under ANY
  `<state-dir>/sessions/<id>/`;
- anything else — a scratchpad, `/tmp`, `~/.claude/jobs` — is outside and does not count. With no
  `cwd` at all, an absolute path outside every session workspace is outside too: the header's
  direction of error, since counting it could only manufacture a fire.

"Any session workspace" rather than "this one" because the seam's tool input names a `task`, not a
directory, and the lookup would be a DB read inside a hook. Measured over every transcript modified
in the 14 days to 2026-09-11 (198 transcripts, 6,182 writes): 6,000 relative, 82 absolute into a
session workspace, 87 into a scratchpad, 13 elsewhere outside, 3 into the main repo — and of the 19
seams preceded by absolute session-workspace writes, none saw writes into more than one workspace,
so the wider leg costs nothing measured. Replayed after the change: the originating record's test
claim is `fresh`; the 9 true records in the sample keep their exact stale set.
`scripts/replay-evidence-provenance.ts` reads the `cwd` off the call's own transcript line so a
replay is bounded the way the live guard was, and prints the roots it used.

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

Pointed at a per-agent file — `<session-dir>/subagents/agent-<id>.jsonl` — the script replays a
SUBAGENT's writes against the subagent's own calls, which since mt#5108 is what the live guard does
too. That is how the originating window's six fires were shown to be misses (below): the same
writes, replayed against the writer instead of the parent, all came back `discharged`.

## Which transcript is judged (mt#5108)

The guard judges a claim against the calls of the agent that WROTE it, which is not always the
conversation the hook fired in. `ctx.transcriptLines` is the parent conversation's lines by
construction (mt#3293; the `registry.ts` docblock), and that is correct for the sixteen
turn-extraction consumers the field was hoisted for. It is wrong here whenever the write is a
dispatched subagent's — the `implementer` pattern, where the orchestrator's `Agent` child runs the
tests, runs the negative control, and calls `session_pr_create` itself. Every run the record
describes then sits in `<session-dir>/subagents/agent-<agent_id>.jsonl`, the record is judged
against a transcript holding none of them, and a reviewer following the record's `session_id`
finds no run either.

Measured in the 2026-09-10/11 calibration window: 6 of 19 matched records — 2 of 9 distinct fires —
were this class, both in one orchestrator conversation. Replayed against the writers' own files,
all six came back `discharged` (a format check the subagent had run twice; a title-pipeline
control it had observed red twice), and the parent transcript held no `session_pr_*` calls at
all: it had made none of the writes it was being judged for.

**Writer-only, and the alternative was measured rather than reasoned out.** The obvious
generalization — parent AND writer — was replayed over 30 days of subagent writes (227 subagent
transcripts, 48 with replayable writes, 371 writes, 306 records). Against the parent alone (the
full parent transcript, an upper bound on what the live guard could see): 201 undischarged, 90
discharged, 15 unadjudicable. Against the writer alone: 27 / 271 / 8. The union discharged 5
records beyond writer-only; 4 were parent runs that happened AFTER the subagent's write, invisible
to a PreToolUse guard, and the 5th was a parent test run on a different task 17 hours earlier
clearing an "Execution evidence: not applicable" block — a wrong-subject discharge. Union-only
discharges: 0. The orchestrator's runs are not the subagent's evidence, so the parent's lines are
not consulted when `agent_id` is present.

Mechanics: `resolveWriterTranscriptLines` in `.minsky/hooks/transcript.ts` — the writer-side twin
of `resolveParentTranscriptLines`. With no `agent_id` it returns `ctx.transcriptLines` unchanged
(a main-thread write is judged exactly as before). With one, it selects the candidate ending in
`subagents/agent-<agent_id>.jsonl` from `ctx.transcriptCandidates` (the directory-qualified suffix
`record-subagent-invocation.ts` also matches on) and parses that file alone. With an `agent_id`
and no such candidate, the record is `skipped` with the file named: falling back to the parent
would reproduce the miss under a verdict, where nobody would look for an outage. The calibration
record now carries `writerAgentId` and `judgedTranscript` (`parent` / `writer` /
`writer-missing`), so a reviewer can open the transcript the verdict actually rests on.

The 27 residual writer-only fires are the join-vocabulary misses mt#4306 and mt#4309 own (20
negative-control, 7 execution-evidence/test), not this class. The same exposure was found and
closed on the `tasks_create` sibling in the same change; see `duplicate-check-search-provenance.md`.

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
