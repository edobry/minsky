# Workaround-Load-Bearing Cluster Audit

**Task:** mt#1539 (Child A of mt#1505)
**Type:** Research / Audit
**Status:** Draft (2026-05-04)
**Parent:** mt#1505 (umbrella roadmap stall audit)

## Summary

Shape-A diagnostic audit: clusters where a documented workaround fires routinely while structural
unblockers stay stalled. Generalizes the mt#1503 pattern (gh api PUT bypass for bot PRs became the
dominant merge mechanism over 3 weeks despite 7 structural unblockers in TODO/PLANNING).

**Findings:** 5 qualifying clusters identified. 3 rollup tasks filed. 2 deferred (tracking tasks
already in IN-REVIEW, not fully stalled). The mt#1035 implementation gap (anchor case) is closed
by sibling tasks mt#1541 and mt#1543 filed during the mt#1508 planning session.

## Diagnostic Shape (5 Conditions)

A cluster qualifies as "workaround-load-bearing stall" when ALL of:

1. A workaround / temporary mechanism is documented (memory file, skill, doc, or rule) with cited
   tracking task(s).
2. The workaround fires ≥1×/week OR is cited 2+ times in any 14-day window (retrospectives,
   calibration data, PR descriptions).
3. The cited tracking task(s) haven't changed status in ≥5 days.
4. The structural unblockers don't share a parent task or rollup — they appear unrelated on the
   roadmap.
5. The workaround is becoming load-bearing — now used routinely, not as the original escape hatch.

## Sweep Results

### Phase 1 — Memory sweep

Files matching workaround/temporary/bridge keywords:

- `feedback_temporary_mechanism_budget.md` — meta-rule: escape hatches must encode retirement
  threshold. Tracking: mt#1034 (DONE).
- `feedback_gh_api_bypass.md` — `gh api PUT` merge bypass for reviewer deadlocks. Tracking:
  mt#1110 (READY), mt#1228 (DONE).
- `feedback_bot_pr_convergence_via_bypass.md` — bypass as dominant merge mechanism. Tracking:
  mt#1555 (TODO), structural tasks under mt#1503 (DONE rollup, children: mt#1073 PLANNING,
  mt#1065 TODO, mt#1405 TODO, mt#1477 TODO).
- `feedback_check_branch_behind_main_during_iteration.md` — manual freshness check before
  commits. Tracking: mt#1483 (IN-REVIEW — **structural fix shipped as hook, memory superseded**).
- `feedback_behavior_detecting_artifacts_need_execution_evidence.md` — execution evidence
  required for behavior-detecting artifacts. Tracking: mt#1459 (IN-REVIEW), mt#1460 (IN-REVIEW).
- `feedback_orphan_session_visibility_gap.md` — manual session liveness probe. Tracking:
  mt#1506 (TODO).
- `feedback_auto_mode_chains_skills.md` — brief affirmatives chain skills in auto mode.
  Tracking: mt#1478 (TODO).
- `feedback_toctou_enumeration_required.md` — TOCTOU enumeration checklist. Tracking:
  mt#1523 (TODO).
- `feedback_stale_local_main_in_adoption_check.md` — local main not auto-pulled. Tracking:
  mt#1551 (PLANNING).
- `feedback_cascade_defense_in_implementer_prompt.md` — bake convergence rule into implementer
  prompts. Tracking: mt#1387 (DONE — skill step shipped).
- `feedback_reviewer_bot_cot_leakage_forces_bypass.md` — CoT leakage forces bypass. (Same
  bypass cluster as feedback_gh_api_bypass.)
- `feedback_reviewer_bot_self_reversal_signal.md` — self-reversal is bypass signal. (Same
  bypass cluster.)

## Cluster Table

| Memory                                                             | Workaround                                          | Cited tracking task(s)                             | Task status     | Stall age | Cluster            | Rollup action                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------------------- | --------------- | --------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `feedback_bot_pr_convergence_via_bypass.md` + siblings             | `gh api PUT` merge bypass for self-authored bot PRs | mt#1073, mt#1065, mt#1405, mt#1477 (under mt#1503) | PLANNING / TODO | 11–25d    | Bot-PR merge gate  | mt#1503 is existing MegaParent (DONE) — children stalled without shared parent beyond mt#1503 itself |
| `feedback_orphan_session_visibility_gap.md`                        | Manual liveness probe sequence                      | mt#1506                                            | TODO            | 3d        | Session liveness   | filed mt#1561 rollup                                                                                 |
| `feedback_auto_mode_chains_skills.md`                              | Manual skill-chain invocation                       | mt#1478                                            | TODO            | 4d        | Auto-mode UX       | filed mt#1562 rollup                                                                                 |
| `feedback_toctou_enumeration_required.md`                          | Manual TOCTOU checklist in implement-task           | mt#1523                                            | TODO            | 3d        | Safety discipline  | filed mt#1563 rollup                                                                                 |
| `feedback_stale_local_main_in_adoption_check.md`                   | GitHub API reads instead of local main              | mt#1551                                            | PLANNING        | 3d        | Stale-local-main   | wait — mt#1551 in PLANNING (active)                                                                  |
| `feedback_behavior_detecting_artifacts_need_execution_evidence.md` | Manual execution evidence                           | mt#1459, mt#1460                                   | IN-REVIEW       | ~6d       | Execution evidence | wait — structural fix in IN-REVIEW                                                                   |
| `feedback_check_branch_behind_main_during_iteration.md`            | Manual freshness check                              | mt#1483                                            | IN-REVIEW       | ~6d       | Branch freshness   | **RESOLVED** — hook shipped, memory superseded                                                       |

### Excluded / resolved candidates

| Memory                                               | Reason excluded                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `feedback_temporary_mechanism_budget.md`             | Meta-rule, not a workaround itself; tracking task mt#1034 is DONE      |
| `feedback_cascade_defense_in_implementer_prompt.md`  | Structural fix (mt#1387) DONE — skill step shipped                     |
| `feedback_reviewer_bot_cot_leakage_forces_bypass.md` | Same cluster as bot-PR bypass (mt#1503)                                |
| `feedback_reviewer_bot_self_reversal_signal.md`      | Same cluster as bot-PR bypass (mt#1503)                                |
| `feedback_gh_api_bypass.md`                          | mt#1228 (squash-merge prevention hook) DONE; calibration mt#1110 READY |

## Cluster Descriptions (Impact Order)

### Cluster 1: Bot-PR Merge Gate (firing ~5×/week at peak)

**Workaround:** `gh api PUT /pulls/N/merge` bypass for self-authored minsky-ai[bot] PRs.
Documented in `feedback_gh_api_bypass.md` (2026-04-23), `feedback_bot_pr_convergence_via_bypass.md`
(2026-04-27), `feedback_reviewer_bot_cot_leakage_forces_bypass.md` (2026-04-27),
`feedback_reviewer_bot_self_reversal_signal.md` (2026-04-30).

**Firing rate:** ~17–20 PRs since mid-April 2026 (~5/week at peak). Four separate memory
entries document the pattern within 7 days. Named in `feedback_temporary_mechanism_budget.md`
as the canonical load-bearing-workaround case study.

**Tracking tasks:** mt#1073 (PLANNING, adversarial reviewer App), mt#1065 (TODO, token routing),
mt#1405 (TODO, CI trigger investigation), mt#1477 (TODO, pull_request_target migration).

**Status:** mt#1503 is the existing MegaParent rollup (DONE). Children mt#1073/mt#1065/mt#1405/
mt#1477 are stalled in PLANNING/TODO under that parent. The parent rollup exists and is wired.
No new rollup needed — reference mt#1503 as the canonical instance.

**Gap:** mt#1503 has `status: DONE` but 0/4 children done. The "done" likely means the rollup
filing is complete, not that the cluster is resolved. The bypass workaround still fires.

---

### Cluster 2: Session Liveness / Orphan Visibility (firing ~1×/week)

**Workaround:** Manual probe sequence — `session_get(task)` → check `liveness` field → compare
`agentId` proc-id against running `claude` PIDs → check iTerm tab names.
Documented in `feedback_orphan_session_visibility_gap.md` (2026-05-01).

**Firing rate:** At least 1 confirmed incident (mt#1340/PR #886 9-hour silent stall). Pattern
expected 1×/week per session cadence. mt#1506 (design task) filed same day.

**Tracking task:** mt#1506 (TODO — "Investigate and design session ↔ operator-interface binding
as a first-class domain concept"). No parent rollup; mt#1506 appears isolated on the roadmap.

**Criteria check:** (1) documented ✓, (2) fired ≥1× in 3d ✓, (3) mt#1506 in TODO ≥3d ✓,
(4) no sibling cluster parent ✓, (5) becoming routine ✓. **QUALIFIES.**

**Action:** Filed mt#XXXX rollup (see Phase 4).

---

### Cluster 3: Auto-Mode Skill Chaining (firing ~daily)

**Workaround:** Manual re-invocation of next skill after each skill's terminal output. When auto
mode is active and a skill points to the next skill, agent must be explicitly prompted again.
Documented in `feedback_auto_mode_chains_skills.md` (2026-04-30).

**Firing rate:** Every skill-chain hand-off point in auto mode (~daily in auto mode sessions).
Named as a recurrent user-friction point that caused 2 consecutive misreadings of "Proceed."

**Tracking task:** mt#1478 (TODO — "Auto-mode skill chaining: /plan-task → /implement-task →
/prepare-pr → /review-pr walk the chain at gate-passes"). No parent rollup visible.

**Criteria check:** (1) documented ✓, (2) daily in auto mode ✓, (3) mt#1478 in TODO ≥4d ✓,
(4) no sibling parent ✓, (5) load-bearing (user must manually re-invoke chain) ✓. **QUALIFIES.**

**Action:** Filed mt#XXXX rollup (see Phase 4).

---

### Cluster 4: TOCTOU Enumeration Checklist (firing per-PR)

**Workaround:** Manual TOCTOU enumeration in implement-task step §7 (before PR creation) —
checklist-driven discipline instead of structural §7a skill step.
Documented in `feedback_toctou_enumeration_required.md` (2026-05-01).

**Firing rate:** Per-PR frequency (every implement-task invocation that has check-then-act code).
Filed after 1 reproduced incident (mt#1483) where TOCTOU was rationalized away twice across 3
reviewer rounds.

**Tracking task:** mt#1523 (TODO — "Add §7a TOCTOU/concurrency sweep step to implement-task
skill"). No parent rollup visible.

**Criteria check:** (1) documented ✓, (2) per-PR firing ✓, (3) mt#1523 in TODO ≥3d ✓,
(4) no sibling parent ✓, (5) load-bearing (checklist not baked into skill) ✓. **QUALIFIES.**

**Action:** Filed mt#XXXX rollup (see Phase 4).

---

### Cluster 5: Stale Local Main (firing ~2×/week)

**Workaround:** Use `mcp__github__get_file_contents(ref="main")` instead of local file reads
for any load-bearing main-workspace access.
Documented in `feedback_stale_local_main_in_adoption_check.md` (2026-05-01). Two reproductions
on same day, different surfaces (adoption check + verify-task auditor).

**Firing rate:** 2× on 2026-05-01 alone; expected ~2×/week given local main staleness is a
persistent environmental condition.

**Tracking task:** mt#1551 (PLANNING — "Fold audit into /review-pr; retire /verify-task as a
verification surface"). In PLANNING = active, not stalled.

**Criteria check:** (1) documented ✓, (2) 2× in 24h ✓, (3) mt#1551 in PLANNING 3d — **borderline**
(PLANNING = active; not a 5-day stall in the same sense as TODO), (4) no sibling parent ✓,
(5) load-bearing ✓. **BORDERLINE — wait.**

**Action:** Do not file rollup; mt#1551 in PLANNING indicates active design work. Re-evaluate
if mt#1551 stalls at PLANNING for >7d.

---

### Cluster 6: Execution Evidence (deferred — structural fix in flight)

**Workaround:** Manual execution evidence step in `/prepare-pr` skill (§1b) + `[unverified-tests]`
PR title tag. Documented in `feedback_behavior_detecting_artifacts_need_execution_evidence.md`
(2026-04-28).

**Tracking tasks:** mt#1459 (IN-REVIEW — PreToolUse hook on session_pr_merge), mt#1460
(IN-REVIEW — /prepare-pr skill step).

**Action:** Both tracking tasks are IN-REVIEW. Structural fix is in flight. **Not stalled.**
Do not file rollup.

---

### Cluster 7: Branch Freshness (resolved)

**Workaround:** Manual freshness check before commits (superseded by shipped hook).
Tracking task: mt#1483 (IN-REVIEW). Per the memory itself, the hook is shipped and the bridge
discipline is replaced. **RESOLVED.**

## Anchor Case: mt#1035 Implementation Gap

**Diagnostic proof case for Shape A.**

mt#1035 (System 3\* detector design) reached DONE on 2026-04-23 with a concrete recommendation:
ship Surface 1 (policy-coverage detector) and Surface 4 (post-mortem transcript analyzer) as the
v0.1 starting set.

For ~9 days after mt#1035 DONE, no implementation child tasks were filed under mt#1034. During
this window, the effective "workaround" was manual user correction via memory entries whenever the
agent made unasked preference-bound decisions — the exact failure mode Surface 1 was designed to
prevent. Memory entries `feedback_stakes_filter.md`, `feedback_escalation_packaging.md`, and
`feedback_doc_comment_intent_vs_caller_reality.md` all represent corrections that a working
Surface 1 would have caught structurally.

**How the gap was closed:** mt#1541 (Surface 1 implementation) and mt#1543 (Surface 4
implementation) were filed 2026-05-01 during the mt#1508 plan-task investigation — 9 days after
mt#1035 DONE. This audit's investigation process IS the structural fix shape: detect when memory
captures a workaround + tracking task stalls + no rollup exists, then file the rollup.

**Current status:**

- mt#1541 (Surface 1 impl): TODO
- mt#1543 (Surface 4 impl): PLANNING

The gap is acknowledged and rollup tasks are filed. No additional rollup needed here.

## Filed Rollups

_(Placeholder — to be filled in Phase 4)_

| Cluster                  | Rollup task | Children wired |
| ------------------------ | ----------- | -------------- |
| Session liveness         | mt#XXXX     | mt#1506        |
| Auto-mode skill chaining | mt#XXXX     | mt#1478        |
| TOCTOU checklist         | mt#XXXX     | mt#1523        |

## Deferred Candidates

| Cluster            | Reason deferred                                          |
| ------------------ | -------------------------------------------------------- |
| Stale local main   | mt#1551 in active PLANNING — not stalled ≥5d             |
| Execution evidence | mt#1459, mt#1460 in IN-REVIEW — structural fix in flight |

## Cross-References

- mt#1503 — canonical Shape-A cluster (bot-PR merge bypass); existing MegaParent rollup
- mt#1035 — anchor design case; implementation children mt#1541 (TODO), mt#1543 (PLANNING)
- mt#1034 — attention-allocation umbrella (DONE)
- mt#1505 — parent umbrella roadmap stall audit
- mt#1540 — sibling Child B (lynchpin-stall without workaround signal)
- `feedback_temporary_mechanism_budget.md` — budget discipline for new workarounds
- `feedback_threshold_grounding.md` — calibration basis for stall/frequency thresholds
- `docs/research/mt1035-system3-detector.md` — structural template this doc mirrors
