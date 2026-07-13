# Roadmap Stall Audit — Synthesis + Structural-Process Retrospective

**Task:** mt#1505 (umbrella roadmap stall audit)
**Type:** Research / Synthesis
**Status:** Final (2026-05-08)
**Children:** mt#1539 (Child A — workaround-load-bearing audit, DONE), mt#1540 (Child B — lynchpin-stall audit, DONE)
**Filed structural fix:** mt#1684 (parent-rollup-completion check)
**Notion writeup:** https://www.notion.so/35a937f03cb481119a08f3c47bd8e6e7

## Summary

The roadmap stall audit (mt#1505) decomposed into two diagnostic shapes — workaround-firing × stall-age (Child A, mt#1539) and structural-importance × inactivity (Child B, mt#1540). Both ran 2026-05-04 with full reports in `docs/research/mt1539-workaround-cluster-audit.md` and `docs/research/mt1540-lynchpin-stall-audit.md`.

**Combined output:** 8 stalled clusters identified, 6 new MegaParent rollups filed (mt#1563, mt#1564, mt#1565, mt#1570, mt#1571, mt#1572), plus 2 detector-implementation tasks (mt#1541, mt#1543) for the mt#1035 anchor case (filed during mt#1508 plan-task investigation).

**Structural-process retrospective recommendation:** ship a parent-rollup-completion check (filed as mt#1684) as the highest-leverage next structural fix; schedule monthly re-runs of the audit as a bridge until System 3\* noticer (mt#1541, mt#1543) ships.

## Stalled-cluster table (combined)

| Cluster                                             | Shape    | Rollup                        | Children                                    | Status                         |
| --------------------------------------------------- | -------- | ----------------------------- | ------------------------------------------- | ------------------------------ |
| Bot-PR merge bypass                                 | A        | mt#1503 (reopened 2026-05-07) | mt#1073, mt#1065 (CLOSED), mt#1405, mt#1477 | 0/4 active children done       |
| Session liveness / orphan visibility                | A        | mt#1563                       | mt#1506                                     | TODO                           |
| Auto-mode skill chaining                            | A        | mt#1564                       | mt#1478                                     | TODO                           |
| TOCTOU enumeration in implement-task                | A        | mt#1565                       | mt#1523                                     | TODO                           |
| ADR-008 transport bindings                          | B        | mt#1570                       | mt#454, mt#1001, mt#700                     | PLANNING / TODO / TODO         |
| ADR-007 CognitionProvider retrofit                  | B        | mt#1571                       | mt#1058, mt#1063                            | TODO / TODO                    |
| T0 progressive adoption                             | B        | mt#1572                       | mt#321                                      | TODO                           |
| mt#1035 detector implementation (closed via filing) | A anchor | (no rollup)                   | mt#1541, mt#1543                            | filed during mt#1508 plan-task |

## Cross-shape patterns

Three patterns surfaced across both audits:

1. **ADRs without runtime adoption** (mt#1570, mt#1571). Design shipped, no consumer wiring. ADR-007 (CognitionProvider) and ADR-008 (attention-allocation) are both in this state — design DONE, implementation children unstarted. The gap is invisible because existing AI features call `AICompletionService` directly with no flag indicating non-compliance with ADR-007.

2. **Skills/workflow without structural enforcement** (mt#1563, mt#1564, mt#1565). Each represents a checklist-driven discipline that lives in a memory file but was never baked into a hook or skill step. Auto-mode skill chaining (mt#1478), TOCTOU enumeration (mt#1523), session-liveness probe (mt#1506) all firing routinely with no structural enforcement.

3. **Long-stalled cross-system clusters** (mt#1503). Interdependent tasks where individual filings hide the collective stall. mt#1503 was filed as a MegaParent rollup but was prematurely marked DONE while its 7 children remained TODO/PLANNING — the failure mode the rollup itself was meant to prevent. Reopened 2026-05-07.

## Anchor case verdict

**mt#1035 (System 3\* detector design) — gap closed.** The implementation children (Surface 1: policy-coverage detector → mt#1541; Surface 4: post-mortem analyzer → mt#1543) were not filed for ~9 days after mt#1035 went DONE. During that window, the effective workaround was manual user correction via memory entries every time the agent made unasked preference-bound decisions — the exact failure mode Surface 1 was designed to prevent. mt#1541 + mt#1543 were filed 2026-05-01 during the mt#1508 plan-task investigation. Both currently TODO/PLANNING but no longer invisible on the roadmap.

## Structural-process retrospective

The load-bearing question of mt#1505: _what process or system component would make this kind of review structural so the user doesn't have to ask for it?_

### Mechanism comparison

| #     | Mechanism                                                                                                                      | Build cost                    | Signal quality            | Coverage                | Orthogonal to mt#1034? |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------- | ----------------------- | ---------------------- |
| 1     | Scheduled cron audit (`/schedule` re-run mt#1539+1540)                                                                         | Low                           | Medium                    | Full                    | Yes (bridge)           |
| 2     | MCP tool for aggregate workaround-citation counts                                                                              | Medium                        | High                      | Shape A only            | Yes                    |
| 3     | Hook on memory write (require budget+task on new workaround)                                                                   | Low                           | High                      | New workarounds only    | Yes (prevention)       |
| 4     | Hook on bypass invocation (counter + warning)                                                                                  | Medium                        | High                      | One workaround per hook | Yes                    |
| 5     | System 3\* noticer (mt#1541 + mt#1543 implementations)                                                                         | High                          | High                      | Full                    | downstream of mt#1034  |
| 6     | Cockpit widget on operator dashboard                                                                                           | Low (depends on backing data) | Depends                   | Visualization layer     | Compatible             |
| **7** | **Parent-rollup-completion check** (hook on `tasks_status_set`: target=DONE + has children → require all children DONE/CLOSED) | Low                           | Very high (deterministic) | Different failure mode  | Yes                    |
| 8     | Audit-already-running pre-check (subagent-dispatch guard)                                                                      | Low                           | High                      | Different failure mode  | likely subsumed by #7  |

Mechanisms #7 and #8 were surfaced during this synthesis session, not in the original mt#1505 spec. Both came from observed failure modes:

- **#7** named explicitly in mt#1503's reopening note as needed-but-unfiled — fresh evidence (mt#1503 DONE while 0/7 children DONE).
- **#8** surfaced from this session itself: a subagent investigation ran 2026-05-04 producing a cluster table that was 90% obsolete by 2026-05-08 because the real audits (mt#1539, mt#1540) ran in parallel without the subagent knowing.

### Recommendation

**Ship #7 first, ship #1 as a bridge.**

- **#7 (parent-rollup-completion check)** — filed as mt#1684. Deterministic (no false positives, children-status is ground truth). Cheap (similar pattern to existing PreToolUse hooks: `parallel-work-guard.ts`, `check-branch-fresh.ts`, `block-subagent-bypass-merge.ts`). Catches a specific failure mode with fresh evidence. Orthogonal to mt#1541/mt#1543 (those handle workaround pattern; this handles rollup pattern).

- **#1 (cron audit)** — schedule monthly via `/schedule`, re-running mt#1539 + mt#1540 sequentially with a delta-report against the previous run. Cheapest to build. Provides empirical data for #2 (citation tool) if later prioritized.

- **#3, #4** — file as follow-ups; valuable but more targeted.
- **#5** — long-term subsumer (mt#1541 + mt#1543); flagged as the eventual retirement target for the bridge mechanisms.
- **#8** — subsumed by #7 in practice; if mt#1505 had been DONE only when mt#1539+mt#1540 were DONE, the parallel-audit duplication would have been visible.

### Recurrence decision

mt#1505 should re-run monthly via `/schedule` until mt#1541/mt#1543 ship. The cron routine is Mechanism #1; this synthesis is the first run.

## Meta-finding (this session, 2026-05-04 → 2026-05-08)

A subagent investigation dispatched on 2026-05-04 produced a cluster table that was substantially obsolete by 2026-05-08. The real audits (mt#1539, mt#1540) ran in parallel during the gap, producing different and more thorough outputs (79 memories scanned vs 47; 8 rollups filed vs 4 proposed). The gap surfaced 4 days of drift: mt#1310, mt#1551, mt#1459, mt#1460 all transitioned DONE; mt#1503 transitioned IN-REVIEW → DONE → TODO; mt#1065 was CLOSED.

This is itself a data point for the structural-process retrospective: **subagent investigation results have a freshness budget; for audit-class work in Minsky's loop velocity, ~24h.** Re-verifying premises before mutation per `feedback_premise_verification_precondition` saved this session from filing rollups that already existed and from advancing tasks that had already shipped.

The pattern this surfaces is generalizable beyond audits: any agent action whose validity depends on distributed state (task statuses, PR states, deploy states) needs a state-of-the-world probe at the operation edge, not just at session start. `feedback_freshness_check_at_operation_edge` already encodes this. The audit tier exposes a specific instance of the same shape.

## Actions taken (2026-05-08)

- [x] Filed mt#1684 (parent-rollup-completion check)
- [x] Notion synthesis writeup posted
- [x] DB memory record `e81315d4-6241-4e5b-9118-f44398ae52a5` (`feedback_temporary_mechanism_budget`) updated with audit findings
- [x] Rollup-pattern observations appended to mt#1451 spec (input for mt#1535 convention work)
- [x] In-repo synthesis writeup (this file) committed alongside mt#1539/mt#1540 sibling reports
- [ ] Schedule monthly cron re-run of mt#1539+mt#1540 (pending; depends on `/schedule` skill availability)
- [ ] mt#1505 → IN-REVIEW (pending; this session's PR will trigger the transition)

## Cross-references

- mt#1539 — Child A workaround-load-bearing audit (DONE) — `docs/research/mt1539-workaround-cluster-audit.md`
- mt#1540 — Child B lynchpin-stall audit (DONE) — `docs/research/mt1540-lynchpin-stall-audit.md`
- mt#1684 — parent-rollup-completion check (filed 2026-05-08, this synthesis's primary structural-fix output)
- mt#1503 — bot-PR merge bypass MegaParent (reopened 2026-05-07, evidence for Mechanism #7)
- mt#1541, mt#1543 — System 3\* detector implementations (mt#1035 anchor case closure; long-term subsumer for bridge mechanisms)
- mt#1451 — task-graph reorganization (consumes rollup-pattern observations from this audit)
- DB memory `e81315d4-6241-4e5b-9118-f44398ae52a5` — `feedback_temporary_mechanism_budget` (the bridge memory updated with audit findings)
- DB memory `1f7816cb-7c1b-472e-862a-7d4891e20715` — `feedback_threshold_grounding` (calibration basis)
- Notion synthesis writeup: https://www.notion.so/35a937f03cb481119a08f3c47bd8e6e7
