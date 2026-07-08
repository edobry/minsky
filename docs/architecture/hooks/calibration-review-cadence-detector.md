# Calibration-Review Cadence Detector

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

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
`{lastWarnedAt, lastWarnedFireCount}`). A due log is re-warned only when its
total fire count has grown since the last warning, or `COOLDOWN_MS` (3 days)
has elapsed while still unaddressed — avoiding a nag on every single turn
while still surfacing the reminder periodically if ignored.

**On fire:** injects `additionalContext` naming each due log (fire counts,
distinct-phrase count, and which of the two conditions fired) and instructing
the agent to run `/calibration-review` (or
`mcp__minsky__observability_calibration-review`) before the drift compounds
further.

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
- `.claude/hooks/skill-staleness-detector.ts` — architectural template
  (re-warning suppression, per-turn injection)
- `.claude/hooks/inject-prod-state.ts` — sibling cache-staleness framing
- `src/domain/calibration/calibration-sweep.ts` — the pure sweep logic this
  hook reuses
- `.claude/skills/calibration-review/SKILL.md` — the skill this hook points
  the agent at when a log is review-due
- mt#2483 — the calibration-review sweep command/skill this hook keeps honest
