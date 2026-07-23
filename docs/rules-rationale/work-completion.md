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

Tracking task: mt#1567.

### How to apply

- When **authoring** a recovery-layer task spec: include both subsections. List failure modes by name, not by area. If a failure mode lacks an owner task, file the owner task before marking the recovery-layer task READY.
- When **reviewing** a recovery-layer PR: verify the runtime behavior matches the spec's `### Covers` list. If the implementation can't actually recover from a listed mode, fix or move to `### Does NOT cover`.
- When **transitioning** a recovery-layer task to DONE: confirm every `### Does NOT cover` entry has an owner task and that those owners are at least READY. A DONE recovery-layer task with PLANNING-status non-coverage owners is the false-completion pattern.

## Invocation path required for event/poll mechanisms

Full incident detail behind the two failure shapes:

- **Nothing calls it.** mt#1618: `pr_watch_run` shipped complete (polling logic, DB state,
  GitHub API client), but the production `pr-watch.ts` adapter wired a `stubGithubPrClient` that
  returns null/[]/[] for every query instead of a real Octokit-backed client, and no scheduler
  called `pr_watch_run` periodically. The mechanism existed but never fired.
- **It runs; a dependency inside it is dead.** mt#3019: a hook fired on every SubagentStop, but
  its domain import threw — 0 of 62 rows carried any column it owned, for two weeks. mt#3046: a
  post-merge scan fired on every merge; its transcript load threw, was swallowed by
  `catch { return null }`, and null means "nothing to do" — it never ran. Harder than the first
  shape: no missing caller to grep for, no error to find.

Tracking: mt#1618, mt#3019, mt#3046; hook slice mechanized by
`custom/require-hook-domain-bootstrap` (`code-style.mdc`).

### How to apply

- **Authoring:** add an `### Invocation path` subsection naming (a) what starts it, (b) where the wiring lives, (c) what config controls it.
- **Implementing:** verify production wiring by searching production callsites, not just the handler. A stub reachable from production code is a silent failure; stubs belong only in test seams.
- **Reviewing:** grep the entry point for a non-test, non-stub caller — and where normal output is "nothing", ask what distinguishes _found nothing_ from _never ran_.
- **Evidence test** (what caught both above): find a positive artifact — a row, a file, a log line — proving the mechanism has EVER succeeded in production.
