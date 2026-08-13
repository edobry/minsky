# build-claim-injection-detector

**Event:** `UserPromptSubmit` (guard-dispatcher, `GUARD_REGISTRY`)
**Task:** mt#2923 (mt#2707-RFC Part 2 + Threats — the build/deploy-claim seam)
**Mode:** calibration-first (mt#2263 / ADR-024 ladder) — log-only, `INJECTION_ENABLED = false`
**Log:** `.minsky/build-claim-injection-calibration.jsonl` (registered in `CALIBRATION_LOG_REGISTRY`,
`reviewByDays: 30`)
**Override:** `MINSKY_ACK_BUILD_CLAIM_INJECTION=1` (plus the shared `MINSKY_HOOK_OVERRIDE` channel)
**Fail posture:** open — transcript/read/detection errors return null (silent allow)

## What it detects

The mt#2707 RFC identified a seam no REACTIVE detector reaches: a chat-only usability/delivery
claim ("you can use it now," "ready to use," "it's live") has no tool call to gate on — the claim
is prose, not a tool result. This guard fires only at that seam, and only under the canonical
"merged != usable" scenario: a build/deploy-surface merge happened in-session, but no rebuild,
reinstall, or deploy step has run yet.

All three conditions must hold:

| Condition               | Signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (a) build-surface merge | an in-session `*session_pr_merge` tool_use call, AND that merge's deploy-surface verdict is positive. Since mt#3819 the verdict is READ from the record written at merge time from the PR's real changed-file list — by the `require-deploy-verification-before-merge` hook and, since mt#4089, by the domain merge path as well, so non-MCP merge paths are covered; only when no record exists for the merge does it fall back to the pre-mt#3819 proxy — a file-edit tool call (Edit/Write/`session_edit_file`/etc.) anywhere in the session touching a path matching `isDeploySurfaceFile` or `isLocalAppDeploySurfaceFile` (`packages/domain/src/deployment/deploy-surface.ts` — the SAME surface detection mt#2545 uses) |
| (b) usability claim     | the prior assistant turn's text matches one of `USABILITY_CLAIM_PATTERNS` ("you can use it now", "ready to use", "it's live", "go ahead and test", ...)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| (c) no rebuild evidence | NO `deployment_wait-for-latest`/`status`/`logs` tool call, and no Bash/`session_exec` command matching `install-local.sh`, `tauri build`/`dev`, `cargo build`, `(npm\|pnpm\|yarn\|bun) [run] build` (incl. a `build:web`-style scoped script name), `bun run dev`, or `railway up`, anywhere in the session                                                                                                                                                                                                                                                                                                                                                                                                                    |

On fire it injects the claim-confidence format reminder (`claim-confidence.mdc` — "[delivery
state] — [evidential warrant + basis]"), not a block.

## Measured disposition, 2026-08-08 (mt#3755): alive, dormant, kept

The 30-day graduation contract came due with **zero** calibration records ever written and 2,341
recorded evaluations. Three hypotheses were live — broken wiring, deterrence (the guard changed
behavior), or dormancy (the condition is rare). The disposition pass settled it:

- **Not broken.** `bun scripts/run-guard-canaries.ts --json` reports this detector PASS, so the
  full path (dispatcher → registry → `run()` → detection → calibration write) is alive.
- **Not deterrence.** `bun scripts/replay-build-claim-injection.ts --json` replayed the real
  detector over **all 805 transcripts** since 2026-07-23 (**3,048** evaluation points). It would
  have fired **zero** times, and the funnel dies at condition (a) — long before any behavioral
  question about claim language could arise:

  | Blocked at                                                                  | Sessions |
  | --------------------------------------------------------------------------- | -------- |
  | (a) no in-session `*session_pr_merge` tool_use                              | 620      |
  | (a) merged, but no deploy-surface file edited in-transcript                 | 176      |
  | (b) merge + surface edit, but no usability claim                            | 8        |
  | (c) all three met → suppressed by real rebuild evidence (**true negative**) | 1        |

The corpus grows continuously, so absolute counts drift on a re-run; as of 2026-08-08 the funnel
SHAPE and the zero-fire result were the finding, not the exact integers. Both have since changed —
see §Re-measured 2026-08-13 below, which supersedes this paragraph's conclusion without altering
what was measured on the date above.

- **Dormancy, with a locatable cause.** Exactly one session in 805 reached the last condition and
  was correctly suppressed. Condition (a)'s proxy is the binding constraint, for two independent
  reasons: `DEPLOY_SURFACE_PATTERNS` matches only deploy-CONFIG files (`infra/`, Dockerfiles,
  `railway.json`, deploy workflows), and Minsky merges in a main-agent conversation whose
  implementation edits live in a dispatched subagent's transcript. Two of the nine sessions where
  the sibling merge gate fired had **0** file-edit tool calls against 15 and 27 `Agent`
  dispatches.

**Disposition: KEEP, contract re-anchored to `liveSinceDate: "2026-08-08"`** — the date the
canary last PROVED the invocation path alive, which is what that field dates (30-day window now
runs to 2026-09-07). Retiring would
re-open the mt#2707 chat seam, which no other mechanism covers at the CHAT surface — the sibling
mt#2545 gate covers the PR-BODY surface only, and it reads the PR's real changed-file list from
the forge (12 `deny` + 8 `warn` across 705 evaluations in the same window), which is exactly the
signal this detector lacks. Keeping costs ~nothing: `INJECTION_ENABLED` is `false`, so it injects
no context and writes no records. The condition-(a) fix is tracked at **mt#3819** (shipped
2026-08-09; its second, independently-owned half shipped as **mt#4013** on 2026-08-12 — see the
re-measurement below).

Per ADR-024's coverage-receipt done-gate — _"zero live fires in 7 days retroactively fails the
gate and is surfaced for review"_ — this section IS that surfacing. Note the fix is a **Rung-1
correctness fix to a structural precondition**, not a rung escalation: ADR-024's Rung 2/3 gates
concern phrase-matching recall, which the measurement shows is not what is failing.

## Re-measured 2026-08-13 (mt#4083): the condition-(a) blockage is cleared

Both causes the 2026-08-08 pass located have since shipped, from two different tasks:

- **mt#3819** replaced the in-transcript proxy. The deploy-surface verdict is now RECORDED from
  the PR's real changed-file list at merge time
  (`packages/domain/src/deployment/merge-deploy-surface-record.ts` — moved there from
  `.minsky/hooks/` by mt#4089), and the detector reads that record, falling
  back to the old proxy only when none exists (`build-claim-injection-detector.ts:414`). The
  producer is confirmed live: `~/.local/state/minsky/merge-deploy-surface.json` held 200 merge
  records accumulated organically 2026-08-09T03:50Z → 2026-08-12T22:17Z, 43 of them
  `hadDeploySurface: true` carrying real application-source paths. This closes the `UNVERIFIED`
  end-to-end thread mt#3819 shipped with.
- **mt#4013** (merged 2026-08-12T06:08Z, commit `0ed27f48`) added `/^src\//` → `["minsky-mcp"]`
  to `DEPLOY_SURFACE_SERVICE_MAP`, which is the "`DEPLOY_SURFACE_PATTERNS` matches only
  deploy-CONFIG files" half named above. Because the fallback proxy calls the same
  `isDeploySurfaceFile`, this widening applies retroactively to sessions the record store never
  saw.

**Which merge paths actually write the record (mt#4089).** Until mt#4089 the sole writer was the
`require-deploy-verification-before-merge` **PreToolUse hook**, so the record existed only for
merges made through the MCP `session_pr_merge` tool on a hook-enabled harness — a CLI merge, a `gh`
merge, a web-UI merge, or an agent on a harness without Claude Code hooks wrote nothing. That gap
was invisible from the read side, because a missing record is UNKNOWN and degrades to the proxy: it
looks identical to a merge that predates the producer. There are now **two writers** — the hook, and
the domain merge path (`mergeSessionPr`) — both calling the same
`classifyAndRecordMergeDeploySurface` helper, so they cannot compute different verdicts for the same
merge. The store is a key→verdict map, so the second write is an idempotent overwrite rather than a
duplicate entry. The hook's write is retained deliberately: the thin-hooks RFC (Accepted
2026-08-11) moves this logic hook→daemon, but that removal belongs to the phase that stands up the
daemon path. **The consumer is unchanged** — it still reads a missing record as UNKNOWN and falls
back to the pre-mt#3819 proxy, which is what keeps a write failure from ever asserting a wrong
verdict.

Replaying the current detector over the SAME window as the baseline (all transcripts since
2026-07-23), so the two runs are comparable:

| Blocked at                                                                  | 2026-08-08 | 2026-08-13 |
| --------------------------------------------------------------------------- | ---------- | ---------- |
| (a) no in-session `*session_pr_merge` tool_use                              | 620        | 735        |
| (a) merged, but no deploy surface                                           | 176        | 101        |
| (b) merge + surface, but no usability claim                                 | 8          | 143        |
| (c) all three met → suppressed by real rebuild evidence (**true negative**) | 1          | 9          |
| **would fire**                                                              | **0**      | **8**      |
| sessions / evaluation points                                                | 805/3,048  | 996/3,664  |

The corpus grew ~24% between the runs, so raw totals are not comparable on their own — but two of
the movements are not explicable by growth. The condition-(a) bucket **fell** from 176 to 101 in
absolute terms while the corpus grew, which requires sessions that previously blocked there to now
pass it. And the population reaching the phrase test rose from 8 to 143 — the first time condition
(b) has had a real denominator. The split between mt#3819's and mt#4013's contributions is
**unmeasured**: separating them would need a control run against the pre-widening patterns, which
this pass did not do.

**The live log is still empty, and that is not evidence about the live path.**
`.minsky/build-claim-injection-calibration.jsonl` does not exist, so the detector has never matched
in production. `appendCalibrationRecord` has exactly one call site
(`build-claim-injection-detector.ts:640`), below the `if (!result.matched) process.exit(0)` guard —
so an absent file means "never matched," not "matched and failed to write." All 8 would-fire
sessions ENDED on or before 2026-08-10T13:43Z, every one of them under code where at least one of
the two blockers was still in place. **No session in the corpus that fires under today's code has
actually RUN under today's code**, and the fully-fixed configuration has ~31h of organic exposure
as of this measurement. Read the empty log as exposure-limited, not as a dead detector.

**What this changes for the 2026-09-07 window.** The 2026-08-08 pass correctly ruled the rung
gates out of scope: the funnel died at a structural precondition, upstream of any phrase test.
That is no longer where it dies. With 143 sessions now reaching condition (b), a further zero-fire
window becomes a question about `USABILITY_CLAIM_PATTERNS` recall — an ADR-024 **Rung-2** question,
which that ADR evidence-gates on "a measured recall-miss rate." This section supplies the
denominator such a measurement would need; it does not nominate the escalation.

Reproduce with:

```
find ~/.claude/projects -name '*.jsonl' -newermt '2026-07-23' -print0 \
  | xargs -0 bun scripts/replay-build-claim-injection.ts --json
```

## Known v1 limitation

"Merge succeeded" is approximated as "a `*session_pr_merge` tool_use call is present in the
session" — the transcript does not reliably expose a structured, tool_use_id-correlated
merge-result payload this detector can confirm success from. Since this is a non-blocking,
calibration-first injection, a false fire on a FAILED merge attempt is an acceptable v1 cost,
reviewed via the calibration log — the same posture code-mechanism-assertion-detector's own
"Known v1 limitation" note documents for its own approximation.

## Record shape

```json
{
  "timestamp": "…",
  "session_id": "…",
  "matchedPhrases": ["you can use it now"],
  "deploySurfaceFiles": ["cockpit-tray/src-tauri/src/main.rs"]
}
```

Diversity axis for the calibration-review cadence machinery: distinct matched phrases (same
shape family as `causal-premise`).

## Graduation

Injection (the reminder text in `buildInjectionReminder`) activates only after a
`/calibration-review` pass on the accumulated log shows an acceptable false-positive rate — per
the mt#2263 detector ladder. The registry entry declares `reviewByDays: 30`, so the mt#2896
never-reviewed-aging leg forces a disposition ask within 30 days even if fire volume stays low.

## mt#2545 coordination

This task owns ONLY the `UserPromptSubmit` chat-seam injection. mt#2545 owns the pre-merge
PR-body usability-claim block (Gap A) and the cockpit-tray-dev env-mutation skill-step (Gap B).
All three reuse the same `deploy-surface.ts` surface detection — one detection source of truth,
three distinct enforcement surfaces (chat / pre-merge PR body / verification skill).

## Origin

mt#2707 RFC (Notion `3a0937f0-3cb4-81a6-8699-e419a5ce4da0`) Part 2 + Threats — the design record
naming this seam as uncovered by every reactive detector in the corpus (pre-narration,
causal-premise, tool-boundary evidence gate, prod-state). Parent umbrella mt#2544.
