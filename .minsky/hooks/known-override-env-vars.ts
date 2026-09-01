// Hooks-tree list of OPERATOR ESCAPE HATCHES — mt#2597 (evaluation-loop
// Phase 1), made derivable by mt#3882.
//
// The fire-log's override classification (`fire-log.ts`'s `classifyOverride`)
// needs an oracle answering "is this env-var name a documented, registered
// escape-hatch?" per the RFC (Notion 392937f0): `authorized_exception` when
// yes, `unclassified` when an env var was used that ISN'T in the oracle.
//
// DO NOT hand-maintain this list, and do not try to keep it in sync by
// remembering to. It must EQUAL `OPERATOR_OVERRIDE_ENV_VARS` in
// `packages/domain/src/configuration/sources/environment.ts` — that is,
// `HOOK_ONLY_ENV_VAR_CATEGORIES` filtered to `category === "operator-override"`
// — and `known-override-env-vars.test.ts` fails, naming the offending entries,
// the moment it does not. Adding a guard override? Categorize it there; the
// test tells you to add it here.
//
// This module does not import that file directly. The reason recorded here was
// that `.minsky/hooks/` is dependency-free per `SPEC.md` (no `packages/domain`
// imports) "so the hooks tree keeps working even when the main codebase has type
// errors" — mt#4373 retired that convention and disproved that reason (Bun
// strips types at import and never type-checks). So the import is no longer
// FORBIDDEN, and whether to collapse this duplication is now an ordinary
// judgment call — the same status as `guard-health.ts` and
// `mcp-daemon-staleness-detector.ts`, which duplicate a src-side reader for what
// was the same retired reason (see those files' header comments). A TEST file is under no such constraint, which is what
// makes the duplication checkable rather than merely documented.
//
// WHY THE MECHANISM CHANGED (mt#3882). This header used to say "a drift is
// cosmetic, not load-bearing" and ask authors to keep the list in sync by
// hand. Six recorded hand-syncs later it was 63 entries behind the canonical
// registry AND carried 45 entries that were never escape hatches at all
// (reviewer credentials, MCP server config, Chromium paths, a test-fixture
// constant) plus one — `MINSKY_POLICY_COVERAGE_MODE` — whose detector mt#4197
// had retired. The drift claim was true about any single guard's allow/deny
// decision and false about the measurement: with 40% of the registry missing,
// `unclassified` stopped meaning "an unregistered env var was used" and
// started mostly meaning "a registered one nobody mirrored."
//
// @see packages/domain/src/configuration/sources/environment.ts — HOOK_ONLY_ENV_VAR_CATEGORIES / OPERATOR_OVERRIDE_ENV_VARS, the canonical source this equals
// @see .minsky/hooks/known-override-env-vars.test.ts — the equality check, in both directions
// @see .minsky/hooks/fire-log.ts — the sole runtime consumer (classifyOverride)
// @see mt#2597 (this list's origin) · mt#3084, mt#2292, mt#3673, mt#4004, mt#3658, mt#4167 (the hand-syncs that failed) · mt#3882 (this mechanism)
export const KNOWN_OVERRIDE_ENV_VARS: ReadonlySet<string> = new Set([
  "MINSKY_ACK_ASK_ROUTING_DEFERRAL",
  "MINSKY_ACK_BARE_ENTITY_REF",
  "MINSKY_ACK_BARE_PROHIBITION",
  "MINSKY_ACK_BUILD_CLAIM_INJECTION",
  "MINSKY_ACK_CAUSAL_PREMISE",
  "MINSKY_ACK_CODE_MECHANISM_ASSERTION",
  "MINSKY_SKIP_SYMBOL_FREE_CLAIMS",
  "MINSKY_ACK_CONSTRUCTED_IDENTIFIER_BATCH",
  "MINSKY_ACK_CROSS_TURN_HEDGE",
  "MINSKY_ACK_DESTRUCTIVE",
  "MINSKY_ACK_KNOWLEDGE_ACQUISITION",
  "MINSKY_ACK_NEGATIVE_EXISTENCE_CLAIM",
  "MINSKY_SKIP_SECRET_REQUEST_IN_CHAT",
  "MINSKY_ACK_OOB_MERGE",
  "MINSKY_ACK_PRE_NARRATION",
  "MINSKY_ACK_RETROSPECTIVE_TRIGGER",
  "MINSKY_ACK_SUBSTRATE_BYPASS",
  "MINSKY_ACK_TASK_HIJACK",
  "MINSKY_ACK_UNESCALATED_INCIDENT",
  "MINSKY_ACK_UNTAKEN_ACTION",
  "MINSKY_ACK_UNWALKED_TASK",
  "MINSKY_ALLOW_BULK_PROCESS_KILL",
  "MINSKY_ALLOW_CONCURRENT_BULK_MUTATION",
  "MINSKY_ALLOW_NESTED_FORK",
  // gitleaks' `generic-api-key` rule reads the NEXT entry's string as a value
  // assigned to this name, because the name contains "SECRET". Both lines are
  // env-var NAMES, not credentials. The allow marker has to sit on the finding's
  // own line (a preceding comment line does not suppress it), and the sanctioned
  // override is used rather than reordering the list to dodge the heuristic.
  "MINSKY_ALLOW_SECRET_FILE_READ", // gitleaks:allow
  "MINSKY_DISABLE_RUNG2_NOMINATION",
  "MINSKY_DISABLE_RUNG3_CONFIRM",
  "MINSKY_FORCE_BYPASS",
  "MINSKY_FORCE_DUPLICATE_OK",
  "MINSKY_FORCE_EDIT_GENERATED",
  "MINSKY_FORCE_LOOP_TERMINAL",
  "MINSKY_FORCE_PARALLEL",
  "MINSKY_HOOK_OVERRIDE",
  "MINSKY_SKIP_ADR_NUMBERING_COLLISION_CHECK",
  "MINSKY_SKIP_AGENT_DISPATCH_RECORD",
  "MINSKY_SKIP_AT_COVERAGE",
  "MINSKY_SKIP_BRIDGE_RETIREMENT",
  "MINSKY_SKIP_BUNDLE_SMOKE",
  "MINSKY_SKIP_CALIBRATION_CADENCE",
  "MINSKY_SKIP_CANDIDATE_READ_PROVENANCE",
  "MINSKY_SKIP_CHAINED_VERIFICATION_SCAN",
  "MINSKY_SKIP_CLAIM_PROVENANCE",
  "MINSKY_SKIP_CRITERION_RECONCILIATION",
  "MINSKY_SKIP_ENUMERATION_SCOPE",
  "MINSKY_SKIP_SPEC_SCOPE_EXECUTION",
  "MINSKY_SKIP_DAEMON_STALENESS",
  "MINSKY_SKIP_DEPLOY_DOMAIN_CHECK",
  "MINSKY_SKIP_DEPLOY_VERIFY",
  "MINSKY_SKIP_DISPATCH_WATCHDOG_INJECTION",
  "MINSKY_SKIP_DUPLICATE_GENERATED_CONTENT_CHECK",
  "MINSKY_SKIP_DUPLICATE_RECORD",
  "MINSKY_SKIP_DUPLICATE_SIGNATURE_SCAN",
  "MINSKY_SKIP_EVIDENCE_PROVENANCE",
  "MINSKY_SKIP_FLAKINESS_CONTROL",
  "MINSKY_SKIP_FRESHNESS",
  "MINSKY_SKIP_GATE_WALK_PROVENANCE",
  "MINSKY_SKIP_GIT_STATE_INJECTION",
  "MINSKY_SKIP_GUARD_EVENTS_INGEST_HOOK",
  "MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK",
  "MINSKY_SKIP_MEMORY_CAPTURE_NOTICE",
  "MINSKY_SKIP_MERGE_GRANT_CHECK",
  "MINSKY_SKIP_MIGRATION_COLLISION_CHECK",
  "MINSKY_SKIP_MIGRATION_GUARD_CHECK",
  "MINSKY_SKIP_MIGRATION_JOURNAL_CHECK",
  "MINSKY_SKIP_NEW_SURFACE_DESIGN_PASS",
  "MINSKY_SKIP_NUL_CHECK",
  "MINSKY_SKIP_CONFLICT_MARKER_CHECK",
  "MINSKY_SKIP_NO_DEPLOY_IMPACT_CHECK",
  "MINSKY_SKIP_OPERATOR_DEFERRAL",
  "MINSKY_SKIP_OPERATOR_INSTRUCTION_TRIGGER",
  "MINSKY_SKIP_PREPUSH_TESTS",
  "MINSKY_SKIP_PROD_STATE_INJECTION",
  "MINSKY_SKIP_READY_CHAIN_WALK",
  "MINSKY_SKIP_RELATED_TESTS",
  "MINSKY_SKIP_RENDER_PATH_EVIDENCE",
  "MINSKY_SKIP_REQUIRED_CHECKS",
  "MINSKY_SKIP_RETRO_COMPLETENESS",
  "MINSKY_SKIP_SC_COVERAGE",
  "MINSKY_SKIP_SEARCH_PROVENANCE",
  "MINSKY_SKIP_SESSION_PATH_CHECK",
  "MINSKY_SKIP_SILENT_STRETCH",
  "MINSKY_SKIP_CONTEXT_FILL_GAUGE",
  "MINSKY_SKIP_SIZE_BUDGET",
  "MINSKY_SKIP_SIZE_JUSTIFICATION",
  "MINSKY_SKIP_SKILL_STALENESS",
  "MINSKY_SKIP_SMOKE_CHECK",
  "MINSKY_SKIP_SPEC_CRITERION_CLAIM",
  "MINSKY_SKIP_SPEC_READ_CHECK",
  "MINSKY_SKIP_STALE_SIGNAL_SWEEP",
  "MINSKY_SKIP_STOP_AT_DECISION",
  "MINSKY_SKIP_UNOWNED_FINDING_SCAN",
  "MINSKY_SKIP_SUBAGENT_MODEL_CHECK",
  "MINSKY_SKIP_TERMINAL_LINKIFY",
  "MINSKY_SKIP_TEST_FIRST_EVIDENCE",
  "MINSKY_SKIP_TIME_INJECTION",
  "MINSKY_SKIP_TRANSCRIPT_INGEST_HOOK",
  "MINSKY_SKIP_NONEXISTENT_SEARCH_PATH",
  "MINSKY_SKIP_TRUNCATED_OUTCOME_READ",
  "MINSKY_SKIP_UNMERGED_MIGRATION_CHECK",
  "MINSKY_SKIP_UNRENDERED_RESULT_FIELD_SCAN",
  "MINSKY_SKIP_UNTAKEN_ACTION_EVALUATION",
  "MINSKY_SKIP_USABILITY_CLAIM_CHECK",
  "MINSKY_SKIP_WALL_OF_TEXT",
  "MINSKY_UNASKED_DIRECTION_DETECTOR",
]);
