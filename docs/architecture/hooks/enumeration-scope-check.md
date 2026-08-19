# `enumeration-scope-check`

Records when a PR changes a **serialized contract** and the session's gate-(h) consumer sweep
never reached `docs/`.

- **Task:** mt#4171 (child 3 of mt#2755's decomposition; ADR-042's gate-(h) row)
- **Event / matcher:** `PreToolUse` on `mcp__minsky__session_pr_create`
- **Family:** `registry-pr-create-guards.ts`
- **Posture:** RECORD-ONLY (calibration-first per ADR-024; `tuningOwnership: advisory`)
- **Override:** `MINSKY_SKIP_ENUMERATION_SCOPE=1`
- **Calibration log:** `enumeration-scope`
- **Replay:** `bun scripts/replay-enumeration-scope.ts --sweep <transcript-dir> [--seam-compare]`

## The question it asks, and why it is not its siblings'

`duplicate-check-search-provenance` (mt#4004) asks whether a search happened.
`claim-provenance-scan` (mt#4168) asks whether a claim has a call behind it. Gate (h)'s recorded
failures are neither — in every one, the agent **did** sweep, and the sweep missed a prescribed
directory:

| Incident | What the sweep did                                                                 | What it missed                                                                             |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| mt#1610  | enumerated 25+ code sites                                                          | three `docs/` files; then the Railway env-var consumers entirely, crashing production      |
| mt#3969  | grepped one symbol correctly                                                       | seven callers that never mention it                                                        |
| mt#4252  | a six-row consumer table, ruling the Rust side out by READING `rustConsumedFields` | `docs/principal-channel.md`, whose "exhaustive per variant" sentence the change made false |

So the checkable question is the strictly stronger one: **the sweep ran — did it cover the
prescribed set?**

## Why it fires at `session_pr_create`, against ADR-042's table

ADR-042 assigns gate (h)'s backstop to `PreToolUse` on `tasks_status_set` at READY. Its
**discriminator**, stated in the same Decision section, is to "place each mechanizable one at the
seam where its evidence first exists." Two premises under the READY assignment were measured false
during mt#4171's implementation, and the ADR's own rule then points at `pr`:

**1. The sweep's directories are not structured arguments.** Measured across the 589 on-disk
transcripts in this project (2026-08-19), by tool name:

```
Bash                       27561
session_grep_search          339
repo_search                  180
Grep                          21
git_search                     9
Glob                           5
```

~98% of searching is a shell command string. (Handled — the shared table parses it.)

**2. The change type is not inferable at READY, because the spec does not yet name the artifact.**
Checked against the originating recurrence directly: mt#4252's spec as surfaced at its own READY
transition is **7,590 characters containing zero `/api/…` routes, zero `contract/` references, zero
`-shape.json`, and zero `docs/` paths.** It says "principal-channel" and "health" as bare words. A
trigger able to fire there would have to key on those bare words — prose, with a paraphrase axis,
which is the ADR-024 arms race mt#4171's spec explicitly forbids.

A READY-seam version therefore misses its own founding incident, which mt#4171's AT2 names as
disqualifying: _"a check that cannot see it is not this check."_

**This is the ADR's own move.** §Sibling reconciliation re-scoped gate (n) on identical reasoning:
_"Its mechanism reads a diff and its title promises the gap 'surfaces at plan time.' No diff exists
at plan time. It moves to the `pr` seam… Its value is unchanged; its claim about WHEN is not."_

**mt#4293** owns amending ADR-042's (h) row and re-pricing **mt#4172**, which was to inherit the
`tasks_status_set` family module and dispatcher wiring this row no longer pays for.

## Mechanism

Three exact reads, all over the same window, none of them a matcher over prose.

**The window** is every call since the previous `session_pr_create`. A long conversation ships
several PRs — one measured session created **seven** — and reading the whole prefix credits every
edit in the conversation to whichever PR is being created now. That produced a measured false
positive: a `contract/cockpit-health-shape.json` edit belonging to an earlier task flagged mt#4232's
PR ("Restart the cockpit daemon by signal"), which touched no contract at all. Sweeps are read from
the same window, or a sweep from an earlier task would discharge this PR's claim.

**The trigger** is the session's own edit-call paths against a fixed serialized-surface list:
`contract/*.json`, `src/generated/*.json`, `*-shape.json`. Membership follows **exposure, not
declaration** (mt#4265): an internal-only type and a type serialized into an HTTP response produce
identical-looking diffs, and only the second one's consumers include `docs/`.

Two exclusions, both measured:

- **A route handler is not a serialized surface.** An earlier revision also matched `**/routes/**`,
  `**/api/**` and `**/handlers/**`; that put the flag rate at 35.8% of decided cases, dominated by
  internal cockpit route handlers. Editing a route handler is not evidence its response _shape_
  changed — mt#3398 in that set was a 500→503 status fix. The path cannot discriminate a shape
  change from a behavior change.
- **`contract/README.md` is not one either.** Prose _about_ the contract prescribes no sweep.

**The discharge** is `sessionSweptDirectories` from the shared table, plus a direct `docs/` edit —
reaching the consumer is stronger evidence than sweeping for it, so either counts.

## Three defects the replay caught that a read-through would not

Each was found by measuring, and each is pinned by a test.

1. **A can't-fail probe.** The first whole-tree regex ended in `…(?:\s\.\s|\s\.$|$)/m`, and that
   trailing `$` matches the end of any line — so every `grep` took the whole-tree branch and
   credited all ten directories. The tell was the output, not the code: `contract` came back swept
   in **86.4%** of READY transitions, which is not a thing anyone does (mem#704).
2. **A filter that dropped the structure binding a path to its command.** The recognizer asked "does
   ANY segment run a search?" and then pulled directory tokens from the WHOLE command string,
   pairing a verb from one segment with a path from another. On the mt#4252 session one `Bash` call
   ran `grep -rn … src/cockpit/principal-channel-poller.ts` in one segment and
   `sed -n '1,80p' docs/architecture/adr-035-….md` in another; `docs` was credited off a single-file
   `sed` read — which suppressed the guard on its own originating incident. Extraction is now
   per-segment.
3. **A splitter that severed a grep alternation.** Splitting segments on a single `|` tore
   `grep -rn "A\s*=\|B\s*=" src/foo.ts` in half, leaving a segment with a search verb and no
   directory and another with a directory and no verb. Caught by the guard's own **liveness**
   assertion on a verbatim fixture (mem#1020) — the test that proves a fixture matches _something_
   before any test asserts what it does not match.

## A subtree is not its directory

A search naming `docs/architecture/adr-*.md` has **not** swept `docs/`. It has read one subtree
under a glob that structurally cannot reach `docs/principal-channel.md`, which sits at the `docs/`
root. Crediting it would be mt#4215's defect inside the guard: a path argument that names a
directory is not proof the directory was searched.

This is precisely how mt#4252 escaped an earlier revision — that session ran
`grep -rln "principal-channel\|principal channel" docs/architecture/adr-*.md`, which credited `docs`
and suppressed the fire, while the file the change falsified sat one level above everything that
grep could see.

So a reference counts only when it addresses the directory itself: `docs/`, `docs/*`, `docs/**`, or
a file directly inside it. This trades a small false-positive risk — an author who sweeps several
subtrees separately reads as not having swept the root — for not silently discharging the claim the
gate exists to check. The guard is record-only, so that risk costs a calibration record rather than
a denial.

## Measured behavior

Replay over all 589 on-disk transcripts (2026-08-19), running the shipped `run()` against the
prefix before each `session_pr_create`:

|                                                  | count | of    |
| ------------------------------------------------ | ----- | ----- |
| PR-create calls                                  | 1134  | —     |
| `declined` (no serialized surface in the window) | 1120  | 98.8% |
| `clean` (swept or edited `docs/`)                | 9     | 0.8%  |
| `matched`                                        | 5     | 0.4%  |

**Classification is incomplete and is stated as such.** One of the five is confirmed: mt#4252,
reviewer-caught as BLOCKING on PR #3101. The other four are unclassified pending live calibration —
which is the reason this ships record-only rather than injecting. Per mem#719, a detector emitting
unmatchable output erodes trust in its correct output, and precision here is measured on a
single confirmed case.

`declined` is a distinct outcome from `clean` on purpose (SC3/AT3): conflating them would report
"we checked and found nothing" for a case that was never checked.

## v1 coverage

- **Decides:** the `Config key / schema field` row of gate (h)'s consumer table — the only row whose
  prescribed set includes `docs/`, and the omission every recorded incident shares.
- **Asserts:** `docs` only. The row also prescribes `src`, `tests`, `services` and `.github`; those
  are listed in `CONFIG_KEY_ROW_DIRECTORIES` but not asserted, because `src` is swept by
  essentially every session (measured 92.1%) so requiring it adds fires carrying no information,
  and `services`/`.github` are legitimately irrelevant to many serialized changes.
- **Declines:** every other change type, recorded as `declined`.

## Cross-references

ADR-042 (the seam discriminator this applies, and the row mt#4293 amends) · ADR-024 (the ladder
this sits outside — no paraphrase axis) · ADR-028 D1/D2/D6 (`needsTranscript` is load-bearing) ·
mt#4044 (`evidence-provenance-table.ts`, the shared table this consumes) · mt#4168, mt#4004 (the
weaker siblings on the same substrate) · mt#4215 (a path argument is not proof the path was
searched) · mt#4265 (take the UNION of applicable rows; membership follows exposure) · mt#1880 (the
merge-seam venue, a different question) · mem#704, mem#719, mem#1002, mem#1020.
