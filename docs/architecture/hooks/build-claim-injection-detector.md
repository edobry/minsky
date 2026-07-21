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
