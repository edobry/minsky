# Hook module inventory: already-domain / movable / immovable

Classifies every non-test module under `.minsky/hooks/` for mt#4368, which moves guard decision
logic into `packages/domain` so a hook module becomes a thin binding. mt#4374 scopes its extraction
waves from the `movable` table below; mt#4376 consumes the same set.

**Living document.** `.minsky/hooks/hook-module-inventory.test.ts` re-derives every mechanical
column on each run and fails when this file drifts from the tree, so a merged hook cannot age the
census silently. Task: mt#4372. Parent: mt#4368.

## Reproduce the totals

```bash
# denominator — top-level non-test modules (excludes __fixtures__/, fixtures/, test-support/)
find .minsky/hooks -maxdepth 1 -name '*.ts' ! -name '*.test.ts' | wc -l                  # 167

# mt#4368's pinned second figure — a TEXT grep, see the correction below
grep -lE 'packages/domain|@minsky/domain' \
  $(find .minsky/hooks -maxdepth 1 -name '*.ts' ! -name '*.test.ts') | wc -l             # 64

# modules that reach persistence, and so land in ADR-026 tier 1
grep -l ensureHookDomainBootstrap \
  $(find .minsky/hooks -maxdepth 1 -name '*.ts' ! -name '*.test.ts') | wc -l             # 21
```

Measured 2026-08-21. Re-run before quoting any of them — the population drifts with every merged
hook, and ADR-028's own amendment says to re-measure the persistence figure rather than quote it
(it recorded 20 on 2026-08-20; ADR-041 §Question 4 recorded 14 on 2026-08-14).

## The correction this inventory exists to make

mt#4368 reads its pinned `60` as _already-domain_ and the `107` remainder as _movable_. Both are
artifacts of how the figure is produced, and the real picture is different in both directions.

**`grep` matches prose, not imports.** Of the 64 modules the pinned command returns, **29 contain no
`packages/domain` import at all** — the match is a comment, an `@see` pointer, or fixture data.
Several of them say the _opposite_ of what the count records:

| Module                                    | What the grep matched                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `dispatcher.ts:19`                        | "does not need `packages/domain`, so it does not import it"               |
| `coverage-receipt.ts:19`                  | "no `packages/domain` imports"                                            |
| `known-override-env-vars.ts:18`           | "`.minsky/hooks/` is dependency-free per `SPEC.md` (no `packages/domain`" |
| `ask-verification.ts:10`                  | "rather than importing `packages/domain`"                                 |
| `nonexistent-search-path-detector.ts:581` | a synthetic path inside a **test fixture string**                         |

The real import count is **35**, measured with Bun's transpiler (`scanImports`) rather than a regex,
so dynamic `await import(...)` is included and comments are not.

**Importing domain is not the same as having your decision there.** Of those 35 real importers, only
**10** import the function that _is_ the verdict. The rest import an effect, a type, a constant, or a
sub-capability. The clearest case is `check-branch-fresh.ts:70`, which imports `writeFreshnessMarker`
— a write effect — while its decision runs real `git merge` in the working tree.

**So the umbrella's baseline should read 6, not 60** — and the movable population is correspondingly
larger than a subtraction from 60 suggests.

## Totals

| Bucket         | Count   |
| -------------- | ------- |
| already-domain | 11      |
| movable        | 84      |
| immovable      | 80      |
| **total**      | **175** |

Of the 84 movable, **16** land in ADR-026 tier 1 (they reach persistence, so the
`ensureHookDomainBootstrap` requirement attaches); the other 68 are tier 2 —
leaf functions with an explicit required `deps` parameter, no container, no import-time side effect.
mt#4374 SC7 asks for a first wave that avoids tier 1; that is the tier-2 column below.

Immovable splits by reason class:

| Reason class                    | Count |
| ------------------------------- | ----- |
| no-decision: library            | 42    |
| no-decision: store              | 11    |
| host-lifecycle                  | 10    |
| no-decision: registry           | 10    |
| product-baseline closure        | 3     |
| named exclusion / local context | 2     |

`no-decision:*` is the bulk of it and is not a claim that those modules are unmovable code — it says
they carry **no guard decision** for mt#4368 to relocate. A registry is declarative wiring, a store's
content is an effect rather than a verdict, and a library is already a callable function. Several of
the libraries are pure logic and would lift cleanly; they are simply not what this umbrella moves.

## How each column was produced

Two provenance classes, kept apart on purpose.

**Mechanical** — re-derived by the test on every run, so they cannot drift: `role`, `domain import`,
`persistence`, `effects` (for registered guards), `tuning`, `plane`.

- `plane` is the product-baseline closure walked from `BASELINE_ROOTS`
  (`.minsky/hooks/self-containment.test.ts`), the same roots that test walks. It resolves to exactly
  three modules; everything else is plant.
- `effects` for a dispatcher-registered guard is its **declared** `verdictShape` read live from
  `GUARD_REGISTRY` — `recorder`/`mutator` are side-effecting, `validator`/`injector` decide only. For
  an unregistered module the column is derived from fs-write/spawn presence and is marked `derived:`.
- `tuning` is the registry's own `tuningOwnership` (invariant / preference / advisory). It is carried
  here as existing data, not re-judged — mt#3518 owns changing those defaults.

**Judged** — a person read the module: `bucket`, the immovable `reason`, and the `extraction unit`.
The bucket rule, applied in order:

1. In the product-baseline closure → **immovable** (module resolution, not convention).
2. A named RFC exclusion, or untransportable local context → **immovable**.
3. Host-lifecycle entity (dispatcher, its entrypoints, the session/merge/typecheck hooks) →
   **immovable**: it _is_ the harness binding, so there is no decision to relocate.
4. Registry, store, or library → **immovable**, reason `no-decision`.
5. Imports the function that IS its verdict → **already-domain**.
6. Otherwise → **movable**.

**Precedence.** The buckets mix two orthogonal axes — where a module's decision lives, and whether it
_can_ be lifted — so a module can satisfy more than one. Immovable outranks already-domain:
`check-branch-fresh.ts` imports domain and is still immovable.

Rule 5's test is the imported SYMBOL, not the path. Importing `nominate` from
`detectors/embedding-nomination` is a sub-capability (an ADR-024 Rung-2 nominator) and leaves the
decision inline — `code-mechanism-assertion-detector.ts` does exactly that across 2719 lines.

### The one partial case

`operator-deferral-detector.ts` imports `detectCapabilityAbsenceEscalation` — a real verdict function
— and is still classified **movable**. It runs 1711 lines with 14 local predicate functions, and the
domain call covers one of its surfaces rather than its decision. Recording it as already-domain would
overstate the baseline in exactly the way this document exists to correct.

## already-domain (11)

The hook module parses, calls, and relays; the verdict is a domain function. This is the shape
mt#4374 is extracting toward — `flakiness-control-detector.ts` calls itself "the thin adapter".

| Module                                 | Role             | Decision function in domain                                          | Effects                                       | Plane |
| -------------------------------------- | ---------------- | -------------------------------------------------------------------- | --------------------------------------------- | ----- |
| `block-github-mcp-pr-writes.ts`        | standalone-hook  | `checkToolDenial (detectors/github-mcp-pr-write-denial)`             | decides-only (derived: no fs write, no spawn) | plant |
| `block-nested-fork-dispatch.ts`        | standalone-hook  | `decideNestedForkDispatchGate (detectors/nested-fork-dispatch-gate)` | decides-only (derived: no fs write, no spawn) | plant |
| `dispatch-intent-write-gate.ts`        | standalone-hook  | `decideDispatchIntentGate (detectors/dispatch-intent-gate)`          | decides-only (derived: no fs write, no spawn) | plant |
| `drive-pr-to-convergence.ts`           | standalone-hook  | `decidePrConvergenceReminder (detectors/pr-convergence-reminder)`    | decides-only (derived: no fs write, no spawn) | plant |
| `flakiness-control-detector.ts`        | dispatcher-guard | `detectFlakinessAttribution (detectors/flakiness-attribution)`       | side-effecting (injector+recorder)            | plant |
| `negative-existence-claim-detector.ts` | dispatcher-guard | `detectNegativeExistenceClaim (detectors/negative-existence-claim)`  | side-effecting (recorder)                     | plant |
| `post-merge-unasked-direction-scan.ts` | standalone-hook  | `UnaskedDirectionAnalyzer (detectors/unasked-direction-analyzer)`    | decides-only (derived: no fs write, no spawn) | plant |
| `secret-request-in-chat-detector.ts`   | dispatcher-guard | `detectSecretRequestInProse (detectors/secret-request-in-chat)`      | side-effecting (recorder)                     | plant |
| `spec-criterion-claim-detector.ts`     | dispatcher-guard | `detectSpecCriterionClaims (detectors/spec-criterion-claim)`         | side-effecting (recorder)                     | plant |
| `tasks-status-set-guard.ts`            | standalone-hook  | `validateStatusTransition (tasks/status-transitions)`                | decides-only (derived: no fs write, no spawn) | plant |
| `warn-bare-prohibition-dispatch.ts`    | standalone-hook  | `analyzeNegativeConstraints (validation/negative-constraint)`        | side-effecting (derived: writes fs / spawns)  | plant |

## movable (84)

Decision is inline in the hook module. `Extraction unit` names the function a wave lifts; where no
`detect*`/`scan*`/`decide*` export exists the cell says so rather than guessing, and that module
needs a read before it is waved.

### ADR-026 tier 2 — no persistence reach (68)

mt#4374's preferred first wave. No `ensureHookDomainBootstrap`, so no import-time side effect and no
bootstrap requirement.

| Module                                         | Role             | Extraction unit                                                   | Effects                                       | Plane | Tuning     |
| ---------------------------------------------- | ---------------- | ----------------------------------------------------------------- | --------------------------------------------- | ----- | ---------- |
| `ask-permission-bridge.ts`                     | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (derived: no fs write, no spawn) | plant | —          |
| `ask-routing-deferral-detector.ts`             | dispatcher-guard | findOfferShape, detectDeferralPhrases                             | side-effecting (injector+recorder)            | plant | preference |
| `auto-session-title.ts`                        | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (injector)                       | plant | advisory   |
| `block-bulk-process-kill.ts`                   | dispatcher-guard | findKillInvocation, findKillVerb                                  | side-effecting (recorder+validator)           | plant | invariant  |
| `block-concurrent-bulk-mutation.ts`            | dispatcher-guard | findBulkMutationInvocation                                        | side-effecting (recorder+validator)           | plant | invariant  |
| `block-git-gh-cli.ts`                          | standalone-hook  | classifyAgentTypeObservation, classifyRepoScope                   | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `block-out-of-band-merge.ts`                   | standalone-hook  | scanForTriggerPhrases                                             | decides-only (derived: no fs write, no spawn) | plant | —          |
| `block-secret-file-read.ts`                    | dispatcher-guard | findSecretReads, findSecretScriptInvocation                       | decides-only (validator)                      | plant | invariant  |
| `block-subagent-bypass-merge.ts`               | standalone-hook  | findGhApiMethod, findPrMergeEndpointToken                         | decides-only (derived: no fs write, no spawn) | plant | —          |
| `block-subagent-merge-without-grant.ts`        | standalone-hook  | decideMergeGrant                                                  | decides-only (derived: no fs write, no spawn) | plant | —          |
| `bridge-memory-retirement.ts`                  | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (derived: no fs write, no spawn) | plant | —          |
| `build-claim-injection-detector.ts`            | dispatcher-guard | findDeploySurfaceEditPaths, findMergeDeploySurfaceFiles           | side-effecting (recorder)                     | plant | advisory   |
| `causal-premise-detector.ts`                   | dispatcher-guard | detectCausalPremise                                               | side-effecting (recorder)                     | plant | advisory   |
| `chained-verification-commands-detector.ts`    | dispatcher-guard | scanCommand                                                       | side-effecting (recorder)                     | plant | advisory   |
| `check-generated-file-edit.ts`                 | standalone-hook  | scanFileForBanner                                                 | decides-only (derived: no fs write, no spawn) | plant | —          |
| `check-guessed-session-path.ts`                | dispatcher-guard | findMissingSessionPaths, findMissingInToolInput                   | decides-only (validator)                      | plant | invariant  |
| `check-prompt-watermark.ts`                    | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (derived: no fs write, no spawn) | plant | —          |
| `check-task-spec-read.ts`                      | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (derived: no fs write, no spawn) | plant | —          |
| `claim-provenance-scan.ts`                     | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (recorder)                     | plant | advisory   |
| `context-fill-gauge.ts`                        | dispatcher-guard | findLastUsage, measureFill                                        | side-effecting (injector+recorder)            | plant | preference |
| `deploy-verification-after-merge.ts`           | standalone-hook  | decideDeployReminder                                              | decides-only (derived: no fs write, no spawn) | plant | —          |
| `drive-ready-to-implementation.ts`             | standalone-hook  | decideReminder                                                    | decides-only (derived: no fs write, no spawn) | plant | —          |
| `duplicate-check-candidate-read.ts`            | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (injector+recorder)            | plant | advisory   |
| `duplicate-check-search-provenance.ts`         | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (injector+recorder)            | plant | advisory   |
| `enumeration-scope-check.ts`                   | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (recorder)                     | plant | advisory   |
| `evidence-record-provenance.ts`                | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (recorder)                     | plant | advisory   |
| `guard-health-escalation-detector.ts`          | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (injector)                       | plant | advisory   |
| `inject-current-time.ts`                       | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (injector)                       | plant | advisory   |
| `inject-ask-responses.ts`                      | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (derived: writes fs / spawns)  | plant | advisory   |
| `inject-dispatch-watchdog.ts`                  | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (injector)                       | plant | advisory   |
| `inject-git-state.ts`                          | dispatcher-guard | detectDefaultBranch                                               | decides-only (injector)                       | plant | advisory   |
| `inject-memory-capture.ts`                     | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (injector)                       | plant | advisory   |
| `inject-prod-state.ts`                         | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (injector)                       | plant | advisory   |
| `inject-success-criteria.ts`                   | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (derived: no fs write, no spawn) | plant | —          |
| `loop-preflight-pr-merge-check.ts`             | standalone-hook  | checkPrState, checkTaskState                                      | decides-only (derived: no fs write, no spawn) | plant | —          |
| `mcp-daemon-staleness-detector.ts`             | dispatcher-guard | decideAndUpdate                                                   | decides-only (injector)                       | plant | advisory   |
| `memory-search.ts`                             | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (injector)                       | plant | advisory   |
| `new-surface-design-pass.ts`                   | dispatcher-guard | findDesignSkillsInvoked, decideOutcome                            | side-effecting (recorder)                     | plant | advisory   |
| `nonexistent-search-path-detector.ts`          | dispatcher-guard | findPathOperands, scanCommand                                     | side-effecting (recorder)                     | plant | advisory   |
| `operator-deferral-detector.ts`                | dispatcher-guard | detectCapabilityDeferral, detectDenialAnchoredDeferral            | side-effecting (recorder)                     | plant | advisory   |
| `parallel-work-guard.ts`                       | standalone-hook  | findOverlappingFiles, checkOpenPrs                                | decides-only (derived: no fs write, no spawn) | plant | —          |
| `pre-narration-detector.ts`                    | dispatcher-guard | detectPreNarration, detectPreNarrationWithSuppression             | side-effecting (recorder)                     | plant | advisory   |
| `record-turn-anchor.ts`                        | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (recorder)                     | plant | invariant  |
| `require-checks-on-bypass-merge.ts`            | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `require-deploy-verification-before-merge.ts`  | standalone-hook  | checkDeployVerification, checkUsabilityClaim                      | decides-only (derived: no fs write, no spawn) | plant | —          |
| `require-duplicate-check-record.ts`            | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (validator)                      | plant | invariant  |
| `require-execution-evidence-before-merge.ts`   | standalone-hook  | findNewTestFiles, findNewOperationalScripts                       | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `require-growth-justification-before-merge.ts` | standalone-hook  | findTouchedCeilingBreaches, findRulesDirFiles                     | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `require-review-before-merge.ts`               | standalone-hook  | classifyZeroCheckRuns, evaluateCheckRunsPresence                  | decides-only (derived: no fs write, no spawn) | plant | —          |
| `require-session-for-main-workspace-edits.ts`  | standalone-hook  | checkFilePathDenial                                               | decides-only (derived: no fs write, no spawn) | plant | —          |
| `retrospective-completeness-detector.ts`       | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (recorder)                     | plant | preference |
| `silent-stretch-detector.ts`                   | dispatcher-guard | measureSilentStretch, findTurnBoundaryTimestamps                  | side-effecting (injector+recorder)            | plant | preference |
| `skill-staleness-detector.ts`                  | dispatcher-guard | detectStaleness, decideAndUpdate                                  | decides-only (injector)                       | plant | advisory   |
| `stamp-ask-conversation.ts`                    | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `stop-at-decision-scan.ts`                     | dispatcher-guard | detectDecisionStop                                                | side-effecting (recorder)                     | plant | advisory   |
| `substrate-bypass-detector.ts`                 | dispatcher-guard | detectVerbalCommitment, detectSkillBypass                         | side-effecting (injector+recorder)            | plant | preference |
| `truncated-outcome-read-detector.ts`           | dispatcher-guard | scanCommand                                                       | side-effecting (recorder)                     | plant | advisory   |
| `turn-end-bare-ref-scan.ts`                    | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (injector+recorder)            | plant | advisory   |
| `turn-end-retro-scan.ts`                       | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (injector+recorder)            | plant | preference |
| `turn-end-unescalated-incident-scan.ts`        | dispatcher-guard | detectUnescalatedIncident                                         | side-effecting (injector+recorder)            | plant | preference |
| `turn-end-untaken-action-scan.ts`              | dispatcher-guard | detectReservedCategoryHalt, detectDestructiveNamedAction          | side-effecting (injector+recorder)            | plant | preference |
| `turn-end-unwalked-task-scan.ts`               | dispatcher-guard | detectCliMintedIds, detectUnwalkedTasks                           | side-effecting (injector+recorder)            | plant | preference |
| `two-strikes-record.ts`                        | standalone-hook  | detectOutcome                                                     | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `unowned-finding-scan.ts`                      | standalone-hook  | detectUnownedFindings, decideFindings                             | decides-only (derived: no fs write, no spawn) | plant | —          |
| `unrendered-result-field-scan.ts`              | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (recorder)                     | plant | advisory   |
| `validate-task-spec.ts`                        | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (derived: no fs write, no spawn) | plant | —          |
| `verify-subagent-model.ts`                     | standalone-hook  | decideModelCheck                                                  | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `wall-of-text-detector.ts`                     | dispatcher-guard | measureWallOfText, findOpeningPromptIndex                         | side-effecting (recorder)                     | plant | preference |

### ADR-026 tier 1 — reaches persistence (16)

These call `ensureHookDomainBootstrap`. Per mt#4368's direction decision, a guard here must go through
that bootstrap and its acceptance evidence must show the guard **decided**, not merely ran.

| Module                                     | Role             | Extraction unit                                                   | Effects                                       | Plane | Tuning     |
| ------------------------------------------ | ---------------- | ----------------------------------------------------------------- | --------------------------------------------- | ----- | ---------- |
| `calibration-review-cadence-detector.ts`   | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (injector)                       | plant | advisory   |
| `code-mechanism-assertion-detector.ts`     | dispatcher-guard | detectRelayContext, detectCodeMechanismAssertion                  | side-effecting (injector+recorder)            | plant | advisory   |
| `constructed-identifier-batch-detector.ts` | dispatcher-guard | findConsumeSpec, detectBatchedMintAndConsume                      | side-effecting (recorder)                     | plant | advisory   |
| `detect-cli-mcp-substitution.ts`           | dispatcher-guard | scanCommand                                                       | side-effecting (recorder)                     | plant | advisory   |
| `duplicate-signature-scan.ts`              | dispatcher-guard | scanForSignatureMatches                                           | side-effecting (recorder)                     | plant | advisory   |
| `gate-walk-provenance.ts`                  | standalone-hook  | classifyGateWalk, classifyMerge                                   | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `knowledge-acquisition-detector.ts`        | dispatcher-guard | findKeywordOverlap, findAllKeywordOverlaps                        | side-effecting (recorder)                     | plant | advisory   |
| `record-agent-dispatch.ts`                 | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (mutator+recorder)             | plant | invariant  |
| `record-subagent-invocation.ts`            | standalone-hook  | decideRecordingAction, classifyAndRecord                          | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `retrospective-trigger-scanner.ts`         | dispatcher-guard | detectTriggerPhrases, detectTriggerPhrasesWithNomination          | side-effecting (injector+recorder)            | plant | preference |
| `stale-signal-sweep.ts`                    | dispatcher-guard | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (recorder)                     | plant | advisory   |
| `stamp-pr-author-link.ts`                  | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | decides-only (derived: no fs write, no spawn) | plant | —          |
| `stamp-session-creator-link.ts`            | standalone-hook  | (no detect*/scan*/decide\* export — extraction unit needs a read) | side-effecting (derived: writes fs / spawns)  | plant | —          |
| `turn-end-stale-state-assertion-scan.ts`   | dispatcher-guard | findPendingClaims, classifyResolved                               | side-effecting (recorder)                     | plant | advisory   |
| `warn-peer-task-activity.ts`               | standalone-hook  | decidePeerActivity, callerSessionIdFromCwd                        | side-effecting (injector+recorder)            | plant | advisory   |
| `warn-stale-forward-reference.ts`          | standalone-hook  | findForwardReferences, decideStaleForwardReference                | side-effecting (injector+recorder)            | plant | advisory   |

## immovable (80)

| Module                                    | Role                | Reason                                                                                                                                                                                                                                                                                             | Effects                                       | Plane   |
| ----------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------- |
| `agent-dispatch-stamp.ts`                 | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `ask-conversation-map.ts`                 | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `ask-grant-store.ts`                      | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `ask-verification.ts`                     | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `authored-spec-text.ts`                   | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | side-effecting (derived: writes fs / spawns)  | plant   |
| `bare-entity-ref-scan.ts`                 | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `canary-runner.ts`                        | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | side-effecting (derived: writes fs / spawns)  | plant   |
| `canary-transcript.ts`                    | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `check-branch-fresh.ts`                   | standalone-hook     | Untransportable local context: runs real `git merge`/`git merge --abort` in the working tree. RFC §What's still open lists this guard as 'likely stays fat' — an OPEN question, not the exclusion list; classified immovable here on the observed git-in-worktree behaviour, not on RFC authority. | decides-only (derived: no fs write, no spawn) | plant   |
| `claim-provenance-corpus-fixtures.ts`     | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `code-mechanism-assertion-dedup-store.ts` | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `command-shape.ts`                        | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `consumer-account-evidence.ts`            | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `coverage-receipt.ts`                     | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `deploy-surface-detector.ts`              | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `dispatch-intent-store.ts`                | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `dispatch-pretooluse.ts`                  | dispatch-entrypoint | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | decides-only (derived: no fs write, no spawn) | plant   |
| `dispatch-stop.ts`                        | dispatch-entrypoint | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | decides-only (derived: no fs write, no spawn) | plant   |
| `dispatch-timeout-budget.ts`              | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `dispatch-userpromptsubmit.ts`            | dispatch-entrypoint | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | decides-only (derived: no fs write, no spawn) | plant   |
| `dispatcher.ts`                           | dispatcher          | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | side-effecting (derived: writes fs / spawns)  | plant   |
| `domain-bootstrap.ts`                     | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `duplicate-signature-tokens.ts`           | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `elision.ts`                              | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `entity-linkify.ts`                       | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `evidence-provenance-table.ts`            | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `fire-log.ts`                             | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `guard-events-ingest-on-session-end.ts`   | standalone-hook     | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | side-effecting (derived: writes fs / spawns)  | plant   |
| `guard-feedback-format.ts`                | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `guard-grant-store.ts`                    | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `guard-health-escalation-notify-store.ts` | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `guard-health.ts`                         | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `guard-tuning-store.ts`                   | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `handoff-status.ts`                       | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `hook-child-env.ts`                       | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `interceptor-coordinates.ts`              | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `interceptor-descriptions-settings.ts`    | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `interceptor-descriptions.ts`             | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `interceptor-provenance-paths.ts`         | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `judged-input-capture.ts`                 | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `known-guard-names.ts`                    | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `known-override-env-vars.ts`              | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `linkify-liveness.ts`                     | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `linkify-message-display.ts`              | standalone-hook     | RFC §What never migrates — MessageDisplay (the streaming linkifier) is named on the exclusion list.                                                                                                                                                                                                | side-effecting (derived: writes fs / spawns)  | plant   |
| `markdown-sections.ts`                    | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `merge-gate-fire-log.ts`                  | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `merge-gate-task-resolution.ts`           | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | side-effecting (derived: writes fs / spawns)  | plant   |
| `merge-grant-store.ts`                    | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `output-label-tokens.ts`                  | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `parallel-work-guard-overrides.ts`        | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `parallel-work-guard-standalone.ts`       | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `post-merge-pull.ts`                      | standalone-hook     | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | side-effecting (derived: writes fs / spawns)  | plant   |
| `post-session-start.ts`                   | standalone-hook     | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | side-effecting (derived: writes fs / spawns)  | plant   |
| `pr-context.ts`                           | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `pr-file-predicates.ts`                   | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `record-conversation-run-state.ts`        | standalone-hook     | product-baseline closure — SPEC.md's observability-baseline rule: transitive imports must stay node-stdlib + same-directory, because the baseline runs from an arbitrary install path.                                                                                                             | decides-only (derived: no fs write, no spawn) | product |
| `registry-command-string-guards.ts`       | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | decides-only (derived: no fs write, no spawn) | plant   |
| `registry-delegation-guards.ts`           | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | decides-only (derived: no fs write, no spawn) | plant   |
| `registry-effects.ts`                     | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | decides-only (derived: no fs write, no spawn) | plant   |
| `registry-matcher-pairs.ts`               | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | decides-only (derived: no fs write, no spawn) | plant   |
| `registry-pr-create-guards.ts`            | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | decides-only (derived: no fs write, no spawn) | plant   |
| `registry-prompt-injection-guards.ts`     | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | side-effecting (derived: writes fs / spawns)  | plant   |
| `registry-prompt-scan-guards.ts`          | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | side-effecting (derived: writes fs / spawns)  | plant   |
| `registry-task-create-guards.ts`          | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | decides-only (derived: no fs write, no spawn) | plant   |
| `registry-turn-end-guards.ts`             | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | decides-only (derived: no fs write, no spawn) | plant   |
| `registry.ts`                             | registry            | no decision to lift — declarative wiring (ADR-028 D2's single source of truth for guard name/matcher/budget).                                                                                                                                                                                      | side-effecting (derived: writes fs / spawns)  | plant   |
| `render-path-evidence.ts`                 | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `session-start.ts`                        | standalone-hook     | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | side-effecting (derived: writes fs / spawns)  | plant   |
| `standalone-dup-probe.ts`                 | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `success-criteria-coverage.ts`            | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `task-statuses.ts`                        | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `test-first-evidence.ts`                  | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `transcript-ingest-on-session-end.ts`     | standalone-hook     | product-baseline closure — SPEC.md's observability-baseline rule: transitive imports must stay node-stdlib + same-directory, because the baseline runs from an arbitrary install path.                                                                                                             | side-effecting (derived: writes fs / spawns)  | product |
| `transcript.ts`                           | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |
| `turn-anchor-store.ts`                    | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `turn-end-scan-store.ts`                  | store               | no decision to lift — local state store; its content is an effect, not a verdict.                                                                                                                                                                                                                  | side-effecting (derived: writes fs / spawns)  | plant   |
| `typecheck-on-edit.ts`                    | standalone-hook     | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | side-effecting (derived: writes fs / spawns)  | plant   |
| `typecheck-on-stop.ts`                    | standalone-hook     | host-lifecycle entity — RFC §What never migrates: these keep the relay forever. It IS the harness binding, so there is no decision to relocate.                                                                                                                                                    | side-effecting (derived: writes fs / spawns)  | plant   |
| `types.ts`                                | library             | product-baseline closure — SPEC.md's observability-baseline rule: transitive imports must stay node-stdlib + same-directory, because the baseline runs from an arbitrary install path.                                                                                                             | side-effecting (derived: writes fs / spawns)  | product |
| `unrendered-result-fields.ts`             | library             | no decision to lift — shared library consumed by guards.                                                                                                                                                                                                                                           | decides-only (derived: no fs write, no spawn) | plant   |

## Divergence: matched by the pinned grep, no import (31)

Every module below is inside mt#4368's `60` and reaches no domain code. Listed per mt#4372 SC3, which
requires the grep figure to be carried as a cross-check with its divergences named.

**Scope: the `.minsky/hooks/` source-of-truth twin only** (PR #3321 R1 asked). Every module name in
this document — this table and the three bucket tables alike — refers to `.minsky/hooks/<name>`,
which is what mt#4368 defines as the unit ("`.claude/hooks/**` generated output — the source tree
`.minsky/hooks/**` is the unit"). The census test agrees structurally rather than by convention: it
enumerates `HOOKS_DIR`, which resolves to `.minsky/hooks`, so a generated twin is never counted and
a change to the generator's naming cannot silently add or drop rows here.

| Module                                         | Bucket    |
| ---------------------------------------------- | --------- |
| `ask-conversation-map.ts`                      | immovable |
| `ask-grant-store.ts`                           | immovable |
| `ask-verification.ts`                          | immovable |
| `block-secret-file-read.ts`                    | movable   |
| `claim-provenance-corpus-fixtures.ts`          | immovable |
| `code-mechanism-assertion-dedup-store.ts`      | immovable |
| `context-fill-gauge.ts`                        | movable   |
| `coverage-receipt.ts`                          | immovable |
| `dispatch-pretooluse.ts`                       | immovable |
| `dispatcher.ts`                                | immovable |
| `drive-ready-to-implementation.ts`             | movable   |
| `duplicate-signature-tokens.ts`                | immovable |
| `enumeration-scope-check.ts`                   | movable   |
| `fire-log.ts`                                  | immovable |
| `guard-grant-store.ts`                         | immovable |
| `hook-child-env.ts`                            | immovable |
| `inject-memory-capture.ts`                     | movable   |
| `inject-success-criteria.ts`                   | movable   |
| `known-guard-names.ts`                         | immovable |
| `known-override-env-vars.ts`                   | immovable |
| `merge-gate-task-resolution.ts`                | immovable |
| `merge-grant-store.ts`                         | immovable |
| `nonexistent-search-path-detector.ts`          | movable   |
| `parallel-work-guard-standalone.ts`            | immovable |
| `parallel-work-guard.ts`                       | movable   |
| `record-conversation-run-state.ts`             | immovable |
| `registry-prompt-scan-guards.ts`               | immovable |
| `registry-task-create-guards.ts`               | immovable |
| `require-execution-evidence-before-merge.ts`   | movable   |
| `require-growth-justification-before-merge.ts` | movable   |
| `unrendered-result-fields.ts`                  | immovable |

## Real domain importers (35)

| Module                                        | Bucket         | Persistence |
| --------------------------------------------- | -------------- | ----------- |
| `block-github-mcp-pr-writes.ts`               | already-domain | —           |
| `block-nested-fork-dispatch.ts`               | already-domain | —           |
| `build-claim-injection-detector.ts`           | movable        | no          |
| `check-branch-fresh.ts`                       | immovable      | —           |
| `dispatch-intent-store.ts`                    | immovable      | —           |
| `dispatch-intent-write-gate.ts`               | already-domain | —           |
| `drive-pr-to-convergence.ts`                  | already-domain | —           |
| `check-generated-file-edit.ts`                | movable        | no          |
| `check-task-spec-read.ts`                     | movable        | no          |
| `code-mechanism-assertion-detector.ts`        | movable        | yes         |
| `constructed-identifier-batch-detector.ts`    | movable        | yes         |
| `deploy-surface-detector.ts`                  | immovable      | —           |
| `domain-bootstrap.ts`                         | immovable      | —           |
| `duplicate-signature-scan.ts`                 | movable        | yes         |
| `flakiness-control-detector.ts`               | already-domain | —           |
| `gate-walk-provenance.ts`                     | movable        | yes         |
| `knowledge-acquisition-detector.ts`           | movable        | yes         |
| `memory-search.ts`                            | movable        | no          |
| `negative-existence-claim-detector.ts`        | already-domain | —           |
| `operator-deferral-detector.ts`               | movable        | no          |
| `post-merge-unasked-direction-scan.ts`        | already-domain | —           |
| `record-agent-dispatch.ts`                    | movable        | yes         |
| `record-subagent-invocation.ts`               | movable        | yes         |
| `require-deploy-verification-before-merge.ts` | movable        | no          |
| `retrospective-trigger-scanner.ts`            | movable        | yes         |
| `secret-request-in-chat-detector.ts`          | already-domain | —           |
| `spec-criterion-claim-detector.ts`            | already-domain | —           |
| `stale-signal-sweep.ts`                       | movable        | yes         |
| `stamp-pr-author-link.ts`                     | movable        | yes         |
| `stamp-session-creator-link.ts`               | movable        | yes         |
| `standalone-dup-probe.ts`                     | immovable      | —           |
| `task-statuses.ts`                            | immovable      | —           |
| `tasks-status-set-guard.ts`                   | already-domain | —           |
| `turn-end-stale-state-assertion-scan.ts`      | movable        | yes         |
| `two-strikes-record.ts`                       | movable        | no          |
| `warn-bare-prohibition-dispatch.ts`           | already-domain | —           |

## Cross-checks against the two required sources

mt#4372 SC5 requires the immovable set to be checked against both, with agreements and divergences
recorded.

**Thin-hooks RFC §What never migrates** (Notion `3b9937f0-3cb4-81a1-8604-c32c862a0329`, Accepted
2026-08-11, rev. 3) names three things. Agreement on all three:

- _Host-lifecycle entities keep the relay forever_ — the dispatcher, its three entrypoints, and the
  session/merge/typecheck hooks are immovable here.
- _Pre-commit/husky is excluded outright_ — out of this census's population; `.minsky/hooks/` holds
  no husky module, so there is nothing to classify.
- _MessageDisplay (the streaming linkifier)_ — `linkify-message-display.ts`, immovable, RFC cited.

**Divergence, recorded rather than resolved.** The branch-freshness guard is commonly cited as being
on that exclusion list. It is not: the RFC puts it under **§What's still open** — "guards needing
untransportable local context (the branch-freshness guard runs real git merges in the working tree;
likely stays fat)" — an open question carrying a hedge. `check-branch-fresh.ts` is classified
immovable here on its observed behaviour, and the reason cell says so instead of citing RFC authority
the source does not give. mt#4368's SC5 carries the same conflation and is annotated there.

**`.minsky/hooks/SPEC.md`'s observability-baseline rule** — the product tier `minsky init` provisions
for other Minsky-managed projects. Agreement: all three closure members
(`record-conversation-run-state.ts`, `transcript-ingest-on-session-end.ts`, `types.ts`) are immovable.
This is the source the RFC could not supply — it is a module-resolution fact, not a convention, and it
survives mt#4373's retirement of the self-containment invariant because the baseline runs from an
arbitrary install path where no `packages/domain` resolves.

## Sources

- mt#4368 — parent; §Direction decision (2026-08-20, principal) is the authorization.
- `docs/architecture/adr-026-dependency-injection-convention.md` — the tier-1/tier-2 split.
- `docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md` — D2 (the registry as source of
  truth) and the 2026-08-20 amendment retiring self-containment.
- `.minsky/hooks/SPEC.md` §System Overview item 2 — the observability-baseline rule.
- `.minsky/hooks/self-containment.test.ts` — `BASELINE_ROOTS`, consumed directly by this inventory's test.
- Thin-hooks RFC (Notion `3b9937f0-3cb4-81a1-8604-c32c862a0329`, Accepted 2026-08-11, rev. 3).
