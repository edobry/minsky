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
  "Retrospective-trigger": ["retrospective-trigger-scanner"],
  "Retrospective-completeness": ["retrospective-completeness-detector"],
  "Turn-end-untaken-action": ["turn-end-untaken-action-scan"],
  "Turn-end-unwalked-task": ["turn-end-unwalked-task-scan"],
  "Code-mechanism-assertion": ["code-mechanism-assertion-detector"],
  "Negative-existence-claim": ["negative-existence-claim-detector"],
  "Secret-request-in-chat": ["secret-request-in-chat-detector"],
  "Turn-end-bare-ref-scan": ["turn-end-bare-ref-scan"],
  "Turn-end-unescalated-incident": ["turn-end-unescalated-incident-scan"],
  "Stop-at-decision": ["stop-at-decision-scan"],
  "Turn-end-stale-state-assertion": ["turn-end-stale-state-assertion-scan"],
  "Ask-routing deferral": ["ask-routing-deferral-detector"],
  "Operator deferral": ["operator-deferral-detector"],
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
  "Agent-dispatch record": ["record-subagent-invocation"],
  "SubagentStop recording": [],
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
  "post-session-start": "lifecycle plumbing, not an observer",
  "rationalization-review": "test fixture",
  "second-guard": "test fixture \u2014 dispatcher ordering test",
  "session-start": "lifecycle plumbing, not an observer",
};
