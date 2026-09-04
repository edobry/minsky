# Work Completion — extended rationale

> Extracted from `.minsky/rules/work-completion.mdc` (mt#3052 corpus trim). The compiled rule
> corpus carries only the per-turn directive; this file holds the incident narratives and
> extended cross-reference detail that motivated each section. Nothing here changes agent
> behavior — the directive text in the rule is the complete behavioral contract.

## External self-resolving waits: arm a watcher, don't delegate to the operator

**Why this section lives in `work-completion.mdc` rather than `decision-defaults.mdc`:** its
recommended sibling home was already near the per-rule 15,000-char compile ceiling; this section
fits thematically as another don't-hand-to-the-human-what-the-agent-can-do instance.

**Family kinship** (don't hand the human what the agent can do itself): `§Probe before deferring`
(`user-preferences.mdc`, mt#1819); the stop-at-handoff family (mt#2689, memory `06a454a5`);
"long-paused subagent ≠ dead" (memory `5f2154cd`). This is the external-dependency-wait
instance — distinct from capability-deferral and from chain-walk-stop.

**Origins:** 2026-07-19 incident — 3 merge-ready PRs blocked by a GitHub API 503; the agent
delegated the wait instead of arming a poll a parallel agent used correctly. See
`feedback_external_self_resolving_wait_arm_a_watcher_not_delegate_to_operator` (id `cb17d1c3`).

## Temporary mechanism budget

**Why:** mt#1503 / 2026-05-01 incident — the `gh api PUT /merge` bypass for self-authored bot PRs
was framed in `feedback_gh_api_bypass.md` (2026-04-23) as "Escape hatch — not a default path."
Over 3 weeks it became the dominant merge mechanism (~17+ PRs, ~5/week). Four memory entries
observed "the bypass is becoming load-bearing" without escalating. The structural unblockers
(mt#1073, mt#1065, mt#1345, mt#1372, mt#1310, mt#1405, mt#1477) sat in TODO/PLANNING the entire
time. The prioritization loop had no measurement variety for _operational pattern frequency over
time_ (Ashby).

See `feedback_temporary_mechanism_budget.md` for the bridge memory.

### How to apply

- When **writing** a memory or doc that names a workaround: include a budget. Format suggestion: `**Budget:** retire when <count> in <window> exceeded; tracking task: mt#X.`
- When **reading** such a memory at use-time: count uses and check against budget. If exceeded, escalate before applying.
- **Ground threshold numbers in observed cadence, not generic defaults.** The 5-day default is calibrated to Minsky's actual loop frequency (~1/day workaround invocation, ~3/day total feedback-memory creation, multi-per-day task status changes). When defining a new budget, check the cadence of the specific signal first (calibration data files, memory mtimes, PR merge timestamps); pick a window where 2 events on the same pattern is unambiguously a signal, not noise.
- Until the structural detector ships (mt#1034 attention-allocation noticer), this is checklist-driven discipline.

## Recovery layer spec discipline

**Why:** mt#1556 / 2026-05-02 incident — mt#1260's periodic-sweeper spec described what it does
(detect missed reviews + retrigger) but did not enumerate which silent-reviewer modes it covers
vs. doesn't. The implicit framing was "the silent-reviewer class is now covered." In reality the
sweeper runs in-process via `setInterval` _after_ drizzle migrations apply, so it is structurally
unable to recover when the service can't start (mt#1556's actual failure mode). mt#1260 marked
DONE 2026-04-26 → silent-reviewer class declared "covered" → mt#1310 (alerting) and mt#1372
(webhook diagnosis) sat in PLANNING for ~6 days → 2026-05-02 the very class they would have
caught (service-down) crashed the reviewer service silently for ~107 hours.

**mt#3217 / 2026-07-25 incident (enumeration with no reader):** the discipline above was
followed — mt#3001's spec correctly enumerated `## Does NOT cover` (a top-level heading; the
canonical `### Does NOT cover` form is a subsection, but the reviewer instruction below is
heading-level-agnostic) with an entry stating non-commit authorization asks would "never" be
auto-closed. The shipped implementation (PR #2146) closed them anyway and documented the
divergence as intentional in the changed file's own header comment. Every existing gate —
including the reviewer's `submit_spec_verification` Success-Criteria check — passed, because
none of them read the `### Does NOT cover` list at all; it existed only as prose. Cost: an
unanswered operator authorization ask (ask#6024) was silently auto-closed when its parent task
merged (2026-07-25). mt#3215 fixed the behavior; mt#3217 closed the process gap (see the
Mechanism subsection below).

Tracking task: mt#1567.

### How to apply

- When **authoring** a recovery-layer task spec: include both subsections. List failure modes by name, not by area. If a failure mode lacks an owner task, file the owner task before marking the recovery-layer task READY.
- When **reviewing** a recovery-layer PR: verify the runtime behavior matches the spec's `### Covers` list. If the implementation can't actually recover from a listed mode, fix or move to `### Does NOT cover`. Separately, verify the implementation does NOT violate any `### Does NOT cover` entry — as of mt#3217 this is a mechanical instruction to the reviewer (see Mechanism below), not left to reviewer discretion.
- When **transitioning** a recovery-layer task to DONE: confirm every `### Does NOT cover` entry has an owner task and that those owners are at least READY. A DONE recovery-layer task with PLANNING-status non-coverage owners is the false-completion pattern.

### Mechanism: who consumes the `### Does NOT cover` enumeration (mt#3217)

The enumeration requirement above and its consumer were separated in time — mt#1567 shipped the
requirement; mt#3217 shipped the reader. As of mt#3217, `services/reviewer/src/prompt.ts`'s
`submit_spec_verification` instruction (both the tool-emission and prose output-format variants)
walks each `### Does NOT cover` / `## Does NOT cover` entry, one verification call per entry,
using the same Met/Not Met/N/A contract already used for Success Criteria:

- **Met** — the diff's actual behavior leaves that case alone.
- **Not Met** — the diff's actual behavior violates the carve-out. A code comment documenting
  the violation as intentional is explicitly NOT accepted as evidence of compliance — this is
  the exact mt#3001 shape the mechanism targets.
- **N/A** — a later Success Criterion or Acceptance Test explicitly supersedes the carve-out.
  This defers to the reviewer's existing section-precedence hierarchy (Principle 12,
  `prompt.ts:193`, unchanged by mt#3217) rather than amending it: a carve-out written at
  planning time still cannot out-rank a later, deliberate scope change — the exact staleness
  failure mode that hierarchy exists to prevent.

A "Not Met" carve-out forces `REQUEST_CHANGES` through the existing `conclude_review`
instruction — no new merge gate or schema change was needed. Whether a carve-out is ALSO
restated as a testable Acceptance Test (the "acceptance-test convention" this task's spec named
as a candidate mechanism) is good practice where feasible, but is not the hard gate — the
reviewer verifies carve-out entries directly against the diff regardless of whether they were
restated as an AT, so an author who forgets to add a matching AT does not lose coverage.

## Invocation path required for event/poll mechanisms

Full incident detail behind the three failure shapes:

- **Nothing calls it.** mt#1618: `pr_watch_run` shipped complete (polling logic, DB state,
  GitHub API client), but the production `pr-watch.ts` adapter wired a `stubGithubPrClient` that
  returns null/[]/[] for every query instead of a real Octokit-backed client, and no scheduler
  called `pr_watch_run` periodically. The mechanism existed but never fired.
- **It runs; a dependency inside it is dead.** mt#3019: a hook fired on every SubagentStop, but
  its domain import threw — 0 of 62 rows carried any column it owned, for two weeks. mt#3046: a
  post-merge scan fired on every merge; its transcript load threw, was swallowed by
  `catch { return null }`, and null means "nothing to do" — it never ran. Harder than the first
  shape: no missing caller to grep for, no error to find.
- **The change REMOVES the signal a consumer depended on.** mt#3025: the originating incident was
  a DESIGN that stopped a behavior, not a line that deleted a call — which is why the prose bullet
  covers it and the diff-anchored surface below cannot. The inverse of the first shape and
  invisible to it: nothing new is uninvoked, so there is no missing caller to grep for. The
  removal is usually CORRECT; the finding is the missing account of what consumed the signal.

Tracking: mt#1618, mt#3019, mt#3046, mt#3025/mt#4493; hook slice mechanized by
`custom/require-hook-domain-bootstrap` (`code-style.mdc`).

The third shape has a merge-time calibration surface (mt#4493,
`.minsky/hooks/consumer-account-evidence.ts`), log-only per the mt#2263 / ADR-024 ladder — it
never denies. It fires on a PR touching `src/`, `packages/` or `cockpit-tray/` (NOT `scripts/`: a
one-shot script exits to set its own status code, and nothing supervises it) whose diff removes —
or newly guards — a call from a closed token set: `process.exit(`, an emit
(`.emit`/`.tryEmit`/`recordDisconnect`/`sendLoggingMessage`), a close
(`.close`/`.unlisten`/`.unwatch`/`.unsubscribe`), or a state-file write (`local-mcp.json`,
`*-state.json`). A bare `return`/`throw`, `console.*`, and `clearInterval`/`clearTimeout` are
deliberately excluded — stopping your own timer signals nobody else. The PR discharges it with a
`Consumer account:` section naming what consumed the signal and what replaces it.

### How to apply

- **Authoring:** add an `### Invocation path` subsection naming (a) what starts it, (b) where the wiring lives, (c) what config controls it.
- **Implementing:** verify production wiring by searching production callsites, not just the handler. A stub reachable from production code is a silent failure; stubs belong only in test seams.
- **Reviewing:** grep the entry point for a non-test, non-stub caller — and where normal output is "nothing", ask what distinguishes _found nothing_ from _never ran_.
- **Evidence test** (what caught both above): find a positive artifact — a row, a file, a log line — proving the mechanism has EVER succeeded in production.
