# Calibration-Review Cadence Detector

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

**Dispatcher status:** migrated onto the ADR-028 guard-dispatcher framework (Phase 2b, mt#2687) —
runs in-process via `dispatch-userpromptsubmit.ts`'s `GUARD_REGISTRY` entry
`calibration-review-cadence-detector` (the LAST entry — this hook sat after the Phase 2a
dispatcher slot in the pre-migration `settings.json` order, and that relative position is
preserved). See `guard-dispatcher-framework.md`.

A `UserPromptSubmit` hook that warns when a hook-calibration JSONL log has
crossed its review threshold, or has sat unreviewed for too long, so a
calibration review cannot silently lapse again (mt#2619). This is the
structural fix for the exact gap the mt#2619 audit found:
`.minsky/calibration-review-watermarks.json` showed exactly ONE calibration
review had ever occurred (retrospective-trigger, watermark stuck at count=12
since 2026-06-13) while THREE detectors sat permanently gated at
`INJECTION_ENABLED=false` past their own documented "review after ~10 fires"
thresholds, and a fourth log (`policy-coverage-calibration.jsonl`) grew to
973KB / 1,457 lines with zero reviews. The `/calibration-review` skill and the
`mcp__minsky__observability_calibration-review` command already do the
mechanical sweep — nothing previously PROMPTED an agent to run them.

**Hook file:** `.claude/hooks/calibration-review-cadence-detector.ts`

**Two independent review-due conditions** (reuses
`src/domain/calibration/calibration-sweep.ts`'s pure `runSweep` /
`CALIBRATION_LOG_REGISTRY` directly — no logic duplication):

1. **`past-threshold`** — the existing count+diversity-aware bar from
   `calibration-sweep.ts`: fires-since-last-review >= `FIRES_THRESHOLD` (10)
   AND distinct-phrases >= `DIVERSITY_THRESHOLD` (3).
2. **`time-stale`** — the log HAS been reviewed before (a watermark exists),
   has >= 1 new fire since that review, AND the review is >= `STALE_DAYS_MS`
   (10 days) old. This closes the exact gap that let retrospective-trigger sit
   forgotten for 3+ weeks: 8 new fires since 2026-06-13 never crossed the
   10-fire count bar, so the mechanical sweep alone would never have flagged
   it. `STALE_DAYS_MS` is grounded in `decision-defaults.mdc §Thresholds`'s
   "10 days for lynchpin tracking" anchor (a calibration log with unreviewed
   new fires is a tracking concern, not active in-flight work).

**Registry extension (mt#2619):** the same PR extended
`CALIBRATION_LOG_REGISTRY` from 3 to 6 entries, adding
`code-mechanism-assertion` (mt#2486), `pre-narration` (mt#2197), and
`policy-coverage` (mt#1575) — the three logs this hook's originating audit
found orphaned. `policy-coverage`'s record shape is NOT a matched-phrase
detector log like the other five (it is a per-tool-call coverage-decision
audit trail); its diversity signal is measured over distinct `reason` values
instead of distinct phrases.

**Re-warning suppression:** mirrors `skill-staleness-detector.ts`'s
`lastReported` pattern via a small persisted state file
(`.minsky/calibration-review-cadence-last-warned.json`, keyed by log path →
`{lastWarnedAt, lastWarnedFireCount, pendingAskWarnedSessionId?}`). A due log
is re-warned only when its total fire count has grown since the last warning,
or `COOLDOWN_MS` (3 days) has elapsed while still unaddressed — avoiding a nag
on every single turn while still surfacing the reminder periodically if
ignored.

**Per-tool-call-volume logs — time-only re-warn (mt#2659):** `policy-coverage`
(mt#1575) fires once per Edit/Write/NotebookEdit call rather than once per
matched pattern, so an active orchestration session's own tool-call volume
re-crosses `FIRES_THRESHOLD` every few turns — the fire-count-growth re-warn
trigger effectively nagged every turn for this log. `shouldReWarn` now skips
the fire-count-growth check for `kind: "policy-coverage"` (and any future log
registered in the same `PER_TOOL_CALL_VOLUME_KINDS` set), leaving only the
`COOLDOWN_MS` time-based trigger.

**Ask-aware suppression (mt#2659):** a due log whose watermark carries an
`openAskId` (written by the `/calibration-review` skill's Step 5 after filing
a disposition Ask) is NOT routed through the normal fire-count/cooldown
warning at all. Instead it shows a single low-noise "disposition pending on
ask `<id>`" line, at most once per `session_id` (tracked via
`pendingAskWarnedSessionId`) — re-running the skill while the prior
flip/tune/keep decision is still awaiting the operator would otherwise just
reproduce the same pending question. The `openAskId` reference is cleared by
the skill (via `clearAskId`) once it confirms via `asks_list` that the ask
has reached a terminal state, at which point normal cadence resumes. The
`observability.calibration-review` command also refuses to silently `--ack`
(and thereby mark "reviewed") a past-threshold log whose watermark already
carries an `openAskId` when the call doesn't also supply `askId` — belt-and-
suspenders against the skill's own Step 1a skip being missed.

**On fire:** injects `additionalContext` naming each due log (fire counts,
distinct-phrase count, and which of the two conditions fired) and instructing
the agent to run `/calibration-review` (or
`mcp__minsky__observability_calibration-review`) before the drift compounds
further — except for openAskId-bearing logs, which get the pending-ask line
instead (see above).

**Fail-open posture:** any error reading the watermark store, the calibration
logs, or the last-warned state exits 0 with a stderr warning. The hook never
blocks the user prompt; a read/parse failure on any of its state files is
treated as "no signal yet," never a crash.

**Override mechanism:** Set `MINSKY_SKIP_CALIBRATION_CADENCE=1` (or `true` /
`yes`) to suppress the warning. The override emits an audit line to stdout
(non-JSON per sibling-hook convention) naming the env-var value and ISO
timestamp.

**Env-var registration:** `MINSKY_SKIP_CALIBRATION_CADENCE` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override
env-var name's source of truth lives in the hook file as the exported
constant `OVERRIDE_ENV_VAR`.

**Known documentation gap (surfaced, not fixed, by this task):** the three
newly-registered detectors — `code-mechanism-assertion-detector.ts` (mt#2486),
`pre-narration-detector.ts` (mt#2197), and `policy-coverage-detector.ts`
(mt#1575) — have no dedicated section in this rule file, unlike their
calibration-first siblings (Causal-Premise Detector, Ask-Routing Deferral
Detector, above). This is itself a symptom of the same "zombie detector"
pattern (a mechanism shipped without the corpus-visibility that would have
prompted its review) and is noted as a follow-up rather than backfilled here
— out of scope for the cadence-mechanism task itself.

**Cross-references:**

- mt#2619 — this hook's tracking task (Track-1 item of the mt#2607 tech-debt
  burndown)
- mt#2659 — ask-aware suppression + policy-coverage time-only re-warn (this
  update); `openAskId` watermark field, `PER_TOOL_CALL_VOLUME_KINDS`,
  `selectPendingAskLogs` / `formatPendingAskLines`
- `.claude/hooks/skill-staleness-detector.ts` — architectural template
  (re-warning suppression, per-turn injection)
- `.claude/hooks/inject-prod-state.ts` — sibling cache-staleness framing
- `src/domain/calibration/calibration-sweep.ts` — the pure sweep logic this
  hook reuses, including `LogWatermark.openAskId`, `advanceWatermarks`'s
  `askId` param, and `clearResolvedAskIds`
- `.claude/skills/calibration-review/SKILL.md` — the skill this hook points
  the agent at when a log is review-due; Step 1a / Step 4 / Step 5 record and
  reconcile `openAskId`
- mt#2483 — the calibration-review sweep command/skill this hook keeps honest
