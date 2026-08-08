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

| Condition               | Signal                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) build-surface merge | an in-session `*session_pr_merge` tool_use call, AND a file-edit tool call (Edit/Write/`session_edit_file`/etc.) anywhere in the session touched a path matching `isDeploySurfaceFile` or `isLocalAppDeploySurfaceFile` (`packages/domain/src/deployment/deploy-surface.ts` — the SAME surface detection mt#2545 uses) |
| (b) usability claim     | the prior assistant turn's text matches one of `USABILITY_CLAIM_PATTERNS` ("you can use it now", "ready to use", "it's live", "go ahead and test", ...)                                                                                                                                                                |
| (c) no rebuild evidence | NO `deployment_wait-for-latest`/`status`/`logs` tool call, and no Bash/`session_exec` command matching `install-local.sh`, `tauri build`/`dev`, `cargo build`, `(npm\|pnpm\|yarn\|bun) [run] build` (incl. a `build:web`-style scoped script name), `bun run dev`, or `railway up`, anywhere in the session            |

On fire it injects the claim-confidence format reminder (`claim-confidence.mdc` — "[delivery
state] — [evidential warrant + basis]"), not a block.

## Measured disposition, 2026-08-06 (mt#3755): alive, dormant, kept

The 30-day graduation contract came due with **zero** calibration records ever written and 2,341
recorded evaluations. Three hypotheses were live — broken wiring, deterrence (the guard changed
behavior), or dormancy (the condition is rare). The disposition pass settled it:

- **Not broken.** `bun scripts/run-guard-canaries.ts --json` reports this detector PASS, so the
  full path (dispatcher → registry → `run()` → detection → calibration write) is alive.
- **Not deterrence.** `bun scripts/replay-build-claim-injection.ts --json` replayed the real
  detector over **all 689 transcripts** since 2026-07-23 (**3,542** evaluation points). It would
  have fired **zero** times, and the funnel dies at condition (a) — long before any behavioral
  question about claim language could arise:

  | Blocked at                                                                  | Sessions |
  | --------------------------------------------------------------------------- | -------- |
  | (a) no in-session `*session_pr_merge` tool_use                              | 515      |
  | (a) merged, but no deploy-surface file edited in-transcript                 | 167      |
  | (b) merge + surface edit, but no usability claim                            | 6        |
  | (c) all three met → suppressed by real rebuild evidence (**true negative**) | 1        |

- **Dormancy, with a locatable cause.** Exactly one session in 689 reached the last condition and
  was correctly suppressed. Condition (a)'s proxy is the binding constraint, for two independent
  reasons: `DEPLOY_SURFACE_PATTERNS` matches only deploy-CONFIG files (`infra/`, Dockerfiles,
  `railway.json`, deploy workflows), and Minsky merges in a main-agent conversation whose
  implementation edits live in a dispatched subagent's transcript. Two of the nine sessions where
  the sibling merge gate fired had **0** file-edit tool calls against 15 and 27 `Agent`
  dispatches.

**Disposition: KEEP, contract re-anchored to `liveSinceDate: "2026-08-06"`.** Retiring would
re-open the mt#2707 chat seam, which no other mechanism covers at the CHAT surface — the sibling
mt#2545 gate covers the PR-BODY surface only, and it reads the PR's real changed-file list from
the forge (12 `deny` + 8 `warn` across 705 evaluations in the same window), which is exactly the
signal this detector lacks. Keeping costs ~nothing: `INJECTION_ENABLED` is `false`, so it injects
no context and writes no records. The condition-(a) fix is tracked at **mt#3819**.

Per ADR-024's coverage-receipt done-gate — _"zero live fires in 7 days retroactively fails the
gate and is surfaced for review"_ — this section IS that surfacing. Note the fix is a **Rung-1
correctness fix to a structural precondition**, not a rung escalation: ADR-024's Rung 2/3 gates
concern phrase-matching recall, which the measurement shows is not what is failing.

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
