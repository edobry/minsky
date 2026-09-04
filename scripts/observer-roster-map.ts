// GENERATED-ASSISTED, HAND-REVIEWED — mt#4393.
//
// The join between `.minsky/rules/hook-observers.mdc` (the operational roster, which
// labels entries in PROSE) and `src/generated/interceptor-catalog.json` (which keys on
// `guardName`). They share no key, and the relationship is MANY-TO-ONE in places:
// `Injection (per-turn)` covers four hooks, `Calibration (log-only)` covers four more.
// A count difference between the two is therefore not a coverage measurement — that
// mistake is what mt#4393 was originally filed on.
//
// POPULATION: the roster is for NON-BLOCKING interceptors, per its own header. In
// catalog terms that is `interventions` containing no `deny` — NOT membership in the
// computed `detector`/`injector` families, which both includes merge gates and excludes
// the recorders and stampers the roster already documents. Non-blocking (98) plus
// blocking (52) partitions the catalog's 150 exactly; hook-files.mdc owns the other half.

/** Roster entry label -> the catalog `guardName`(s) it documents. */
export const ROSTER_TO_GUARDS: Record<string, readonly string[]> = {
  "Skill/agent/rule staleness": ["skill-staleness-detector"],
  "Drive-PR-to-convergence": ["drive-pr-to-convergence"],
  "Drive-READY-to-implementation": ["drive-ready-to-implementation"],
  "Warn-peer-task-activity": ["warn-peer-task-activity"],
  "Warn-stale-forward-reference": ["warn-stale-forward-reference"],
  "Coverage-claim-path": ["coverage-claim-path-detector"],
  "Substrate-bypass": ["substrate-bypass-detector"],
  // Many-to-one: the entry's own text names its Stop sibling, so it documents both.
  "Retrospective-trigger": ["retrospective-trigger-scanner", "turn-end-retro-scan"],
  "Retrospective-completeness": ["retrospective-completeness-detector"],
  "Turn-end-untaken-action": ["turn-end-untaken-action-scan"],
  "Turn-end-unwalked-task": ["turn-end-unwalked-task-scan"],
  "Code-mechanism-assertion": ["code-mechanism-assertion-detector"],
  "Negative-existence-claim": ["negative-existence-claim-detector"],
  "Secret-request-in-chat": ["secret-request-in-chat-detector"],
  "Turn-end-bare-ref-scan": ["turn-end-bare-ref-scan"],
  "Turn-end-unescalated-incident": ["turn-end-unescalated-incident-scan"],
  "Turn-end-stale-state-assertion": ["turn-end-stale-state-assertion-scan"],
  "Criterion reconciliation": ["criterion-reconciliation-scan"],
  "Ask-routing deferral": ["ask-routing-deferral-detector"],
  // Many-to-one: the entry says "Six surfaces", and three of them are separately registered
  // guards carved out of the same module because a matcher's tokens must be filed under the
  // registry family that owns them.
  "Operator deferral": [
    "operator-deferral-detector",
    "operator-deferral-artifact-surface-pr",
    "operator-deferral-artifact-surface-spec",
    "operator-deferral-ask-surface",
  ],
  "Wall-of-text": ["wall-of-text-detector"],
  "Silent-stretch": ["silent-stretch-detector"],
  "Context-fill gauge": ["context-fill-gauge"],
  "Chained-verification-commands": ["chained-verification-commands"],
  "Nonexistent-search-path": ["nonexistent-search-path"],
  "Truncated-outcome-read": ["truncated-outcome-read"],
  "CLI-substitutes-MCP": ["cli-mcp-substitution"],
  "Constructed-identifier batch": ["constructed-identifier-batch-detector"],
  "Bare-prohibition dispatch": ["bare-prohibition"],
  "Duplicate-check search provenance": ["duplicate-check-search-provenance"],
  "Duplicate-check candidate read": ["duplicate-check-candidate-read"],
  "Claim provenance": ["claim-provenance-scan"],
  "Unwired task relationship": ["warn-unwired-task-relationship"],
  "Evidence-record provenance": ["evidence-record-provenance"],
  "Duplicate-signature scan": ["duplicate-signature-scan"],
  "Stale-signal sweep": ["stale-signal-sweep"],
  "Unrendered-result-field scan": ["unrendered-result-field-scan"],
  "Enumeration-scope check": ["enumeration-scope-check"],
  "Spec-scope execution": ["spec-scope-execution-check"],
  "Gate-walk provenance": ["gate-walk-provenance"],
  "New-surface design pass": ["new-surface-design-pass"],
  "Flakiness-control detector": ["flakiness-control-detector"],
  "Unowned-finding scan": ["unowned-finding-scan"],
  "Consumer-account": [],
  "Spec-criterion-claim": ["spec-criterion-claim-detector"],
  "Display linkifier": ["linkify-message-display"],
  "Injection (per-turn)": [
    "inject-current-time",
    "inject-git-state",
    "inject-prod-state",
    "inject-dispatch-watchdog",
  ],
  "Memory-capture notice": ["inject-memory-capture"],
  "Answered-ask notice": ["inject-ask-responses"],
  "Ask-conversation stamp": ["stamp-ask-conversation"],
  // These two were swapped. `record-agent-dispatch` is the PreToolUse half that writes the
  // pending row and stamps `(session_id, tool_use_id)`; `record-subagent-invocation` is the
  // SubagentStop half that writes the Stop-time columns. The roster entries describe exactly
  // that split, so the map was mis-attributing one and leaving the other empty.
  "Agent-dispatch record": ["record-agent-dispatch"],
  "SubagentStop recording": ["record-subagent-invocation"],
  "PR-author link": ["stamp-pr-author-link"],
  "Session-creator link": ["stamp-session-creator-link"],
  "Subagent model verification": ["verify-subagent-model"],
  "Session-end ingest": ["transcript-ingest-on-session-end"],
  "Guard-events sweep ingest": ["guard-events-ingest-on-session-end"],
  "Calibration (log-only)": [
    "causal-premise-detector",
    "calibration-review-cadence-detector",
    "build-claim-injection-detector",
    "knowledge-acquisition-detector",
  ],
  "Guard-health tracker": ["guard-health-escalation-detector"],
  "Cross-turn hedge": ["cross-turn-hedge-detector"],
  "Pre-narration": ["pre-narration-detector"],
  "Two-strikes record": ["two-strikes-record"],
  "Warn main-workspace mutation": ["warn-main-workspace-mutation"],
  "Standalone duplicate matcher": ["standalone-duplicate-matcher"],
  "Post-merge unasked-direction scan": ["post-merge-unasked-direction-scan"],
  "Bridge-memory retirement": ["bridge-memory-retirement"],
  "Deploy-verification after merge": ["deploy-verification-after-merge"],
  "Success-criteria injection": ["inject-success-criteria"],
  "MCP daemon staleness": ["mcp-daemon-staleness-detector"],
  "Memory search": ["memory-search"],
  "Typecheck on edit": ["typecheck-on-edit"],
  "Conversation run-state record": ["record-conversation-run-state"],
  "Auto session title": ["auto-session-title"],
};

/**
 * The INVERSE declaration: roster entries that deliberately have no catalog peer, with the
 * reason. Without this, such an entry is a permanent finding, and a check that can never
 * reach zero is one nobody can gate on. A label here MUST also map to an empty guard list —
 * declaring a peer-less entry that in fact has a peer is its own contradiction, and the
 * audit reports it.
 */
export const ROSTER_NO_CATALOG_PEER: Record<string, string> = {
  "Consumer-account":
    "not a registered guard — it rides `require-execution-evidence-before-merge` as that gate's fifth calibration surface (mt#4493), so the catalog enumerates the host, not this surface",
};

/** Non-blocking catalog entries deliberately absent from the roster, with the reason. */
export const ROSTER_EXEMPT: Record<string, string> = {
  "claude-hooks-compile-regen":
    "pre-commit regeneration step \u2014 build machinery, documented in hook-files.mdc",
  "code-formatting": "pre-commit formatting step \u2014 documented in hook-files.mdc",
  "completion-manifest-regen": "pre-commit regeneration step \u2014 documented in hook-files.mdc",
  denier: "test fixture \u2014 a synthetic guard used by the dispatcher's own tests",
  "dispatch-pretooluse":
    "the dispatcher itself, not an observer it dispatches (docs: guard-dispatcher-framework.md)",
  "dispatch-stop": "the dispatcher itself, not an observer it dispatches",
  "dispatch-userpromptsubmit": "the dispatcher itself, not an observer it dispatches",
  "dockerfile-bun-build-regen": "pre-commit regeneration step \u2014 documented in hook-files.mdc",
  "dockerfile-workspace-copy-regen":
    "pre-commit regeneration step \u2014 documented in hook-files.mdc",
  "first-guard": "test fixture \u2014 dispatcher ordering test",
  "interceptor-catalog-regen": "pre-commit regeneration step \u2014 documented in hook-files.mdc",
  "mt3612-live-rewrite": "one-shot migration hook, retired after its run",
  "overridden-guard": "test fixture \u2014 override-path test",
  "post-merge-pull": "lifecycle plumbing, not an observer",
  "record-turn-anchor":
    "framework state — writes the turn-anchor store at Stop and always returns null; its only effect is a file OTHER interceptors read",
  "post-session-start": "lifecycle plumbing, not an observer",
  "rationalization-review": "test fixture",
  "second-guard": "test fixture \u2014 dispatcher ordering test",
  "session-start": "lifecycle plumbing, not an observer",
};
