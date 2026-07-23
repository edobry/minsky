# Deploy-Verification Merge Gate + Post-Merge Reminder

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A pair of hooks (mt#2353) that close the mt#1459 execution-evidence coverage hole
for deploy/infra PRs that add NO test files. The mt#1459 "Execution evidence:" gate
fires only when a PR adds new test files; a PR that changes DEPLOYED BEHAVIOR but
adds no tests (config-as-code, Dockerfile, railway.json, deploy workflow) skips it
entirely. mt#2345 (2026-06-08) merged `infra/index.ts` +
`services/reviewer/railway.json`, applied them to prod, and was reported DONE on
`pulumi up` exit-0 while the reviewer service crash-looped for ~30 min.

**Hook files:**

- `.claude/hooks/deploy-surface-detector.ts` — pure detector
  (`isDeploySurfaceFile` / `findDeploySurfaceFiles`) over the deploy surface:
  `infra/**`, `services/*/Dockerfile`, `services/*/railway.json`,
  `services/*/deploy.config.ts`, `services/*/railway.config.ts`,
  `.github/workflows/deploy-*.yml`. The surface list is one exported constant.
- `.claude/hooks/require-deploy-verification-before-merge.ts` — PreToolUse on
  `mcp__minsky__session_pr_merge`. Blocks the merge of a deploy-surface PR unless the
  body has a `Deploy verification:` section. Reuses `deriveRepoFromGit` /
  `resolvePrNumber` / `makeProdPrDeps` / `PrFile` from
  `require-execution-evidence-before-merge.ts`.
- `.claude/hooks/deploy-verification-after-merge.ts` — PostToolUse on
  `mcp__minsky__session_pr_merge`. On a deploy-surface merge success, injects a
  MANDATORY reminder to run `mcp__minsky__deployment_wait-for-latest` -> SUCCESS +
  confirm the runtime started; tool-flake is a BLOCKER, not a license to defer;
  "applied" / "pulumi up exit-0" is the action, not the outcome. Informational
  (always exits 0); reads the PR ref from the merge `tool_result` metadata.

**Architectural note (why a gate + injection, not a hard DONE-block):** DONE is set
ATOMICALLY at merge by `applyPostMergeStateSync`, and the deploy only exists AFTER
merge — so the gate cannot require deploy-SUCCESS EVIDENCE pre-merge. The gate requires
a post-merge-verification COMMITMENT in the body; the PostToolUse injection makes the
actual verification mandatory on the merge turn. This is the deploy-surface analog of
the mt#1459 gate + `drive-pr-to-convergence.ts` injection pair. The lifecycle-deferral
(defer DONE in `applyPostMergeStateSync`) is the named escalation rung if this tier
proves insufficient.

**Escape hatches (PreToolUse gate):**

1. PR title contains `[no-deploy-impact]` — the surface match is a false positive
   (e.g. a comment-only edit to a deploy-config file). Allows with a warning.
2. PR body contains a `Deploy verification:` section — the commitment.
3. `MINSKY_SKIP_DEPLOY_VERIFY=1` — operator override, audit-logged.

**Marker acceptance (mt#2648):** both this hook's `Deploy verification:` marker and the
sibling mt#1459 `Execution evidence:` marker (in
`require-execution-evidence-before-merge.ts`) accept, case-insensitive: a plain label
line WITH a required colon (`Deploy verification:`, `Execution evidence:`), OR a Markdown
heading of ANY level (1-6) with an OPTIONAL trailing colon (`## Deploy verification`,
`### Deploy verification:`, and the `Execution evidence` equivalents). The colon remains
required for the non-heading form so bare prose mentions don't false-positive; heading
level and trailing colon are both flexible because agents naturally write evidence as a
Markdown section. Originating incident: PR #1798 (mt#2613, 2026-07-07) was blocked at
merge despite a complete `## Execution evidence` section because it had no trailing
colon — a diagnose-and-edit round-trip this broadened acceptance eliminates. Denial
messages from both hooks now name the accepted forms explicitly.

**Fail-open posture:** unresolvable repo/PR, fetch failure, or non-deploy-surface PR
→ silent allow (the gate never blocks on inability to check). The PostToolUse hook is
informational and exits 0 on any failure.

**Env-var registration:** `MINSKY_SKIP_DEPLOY_VERIFY` is registered in
`HOOK_ONLY_ENV_VARS` (`packages/domain/src/configuration/sources/environment.ts`); the
override-env name's source of truth is the exported `OVERRIDE_ENV_VAR` constant in the
gate hook.

**Paired skill-step:** `/implement-task` §10 was strengthened (mt#2353) with the
deploy-surface trigger list, the MANDATORY-before-done framing,
deferral-text-is-not-evidence, and the three enforced rules (applied != outcome;
tool-flake-is-blocker; DONE != deploy-healthy).

**Local-app deploy surface — cockpit-tray (mt#2976).** The post-merge reminder is
**target-aware**. Alongside the Railway surface above, `cockpit-tray/src-tauri/**` (the tray's
native Rust binary) is recognized as a **local-app** deploy target: the tray "deploys" to the
operator's `/Applications` via `cockpit-tray/scripts/install-local.sh`, and unlike `src/cockpit/**`
(auto-rebuilt + auto-restarted by the tray, mt#2297/mt#2299) its binary is NOT auto-rebuilt — a
merged change is invisible until reinstalled (mt#2942). So a merge touching that path injects a
**reinstall reminder** (`buildTrayReinstallReminder`: run `install-local.sh`; the AGENT does it,
not the operator — telling the operator to reinstall manually is the §Turnkey-not-portal
anti-pattern the mt#2942 retrospective flagged). It is deliberately **reminder-only, not
pre-merge-blocked** — a local reinstall is low-stakes and reversible. The tray surface is kept
SEPARATE from `DEPLOY_SURFACE_PATTERNS` (via `isLocalAppDeploySurfaceFile` /
`LOCAL_APP_DEPLOY_SURFACE_PATTERNS` in `packages/domain/src/deployment/deploy-surface.ts`) so the
pre-merge gate AND the `session.pr.drive` deploy-watch — both keyed on the Railway patterns — never
treat a tray change as a Railway deploy. A PR touching both surfaces gets both reminders. The
Railway override `MINSKY_SKIP_DEPLOY_VERIFY` is scoped to the **Railway** reminder only — it does
NOT suppress the tray reinstall reminder (mt#2976 review): the tray reminder is the sole structural
prompt for a tray merge, so a Railway-motivated skip must not silence it. This is the structural
version of the mt#2942-retrospective interim ("the agent reinstalls the tray for you"), firing
mechanically instead of relying on agent memory across conversations; the eventual
elimination is auto-update (mt#2962, gated on Apple Developer signing mt#2201, declined 2026-07-20).

**Gap A extension — usability-claim check (mt#2545).** A SECOND, independent condition lives on
the same PreToolUse hook (`require-deploy-verification-before-merge.ts`): a build-surface PR
(tray `src-tauri/**` only) whose body asserts altitude-4 usability ("you can use it now" /
"ready to use" / "it's live", per `claim-confidence.mdc` Axis A) without an explicit rebuild +
reinstall acknowledgment is hard-blocked. This closes the specific gap where a PR body claims the
feature is usable immediately post-merge for a build/install-class deliverable, when in fact
`deployed < usable` for that class until the principal (or the agent, per the reinstall-reminder
mechanism above) rebuilds/reinstalls. `[no-deploy-impact]` does NOT bypass this check — a tray
build-surface file IS a deploy/build surface by definition; the only escapes are adding the
rebuild/reinstall acknowledgment itself, or `MINSKY_SKIP_USABILITY_CLAIM_CHECK=1` (independent of
`MINSKY_SKIP_DEPLOY_VERIFY`, since the two checks guard different failure modes).

**Cross-references:**

- mt#2353 — this pair's tracking task
- mt#2345 — originating incident (config-as-code deploy crash reported DONE on
  apply-exit-0); mt#2352 — its re-implementation
- mt#1459 / `require-execution-evidence-before-merge.ts` — sibling gate (test-file surface)
- mt#2648 — broadened marker acceptance (heading forms, optional trailing colon) applied
  to both this hook's `Deploy verification:` marker and the mt#1459 sibling's
  `Execution evidence:` marker
- `drive-pr-to-convergence.ts` — architectural template (PostToolUse injection)
- mt#1787 / bundle-boot-smoke — CI gate for the MCP bundle (does NOT cover Railway
  config-as-code build-resolution changes — this pair's class)
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
- mt#2976 — target-aware extension: the cockpit-tray local-app deploy surface + reinstall reminder
