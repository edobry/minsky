// Hooks-tree mirror of HOOK_ONLY_ENV_VARS — mt#2597 (evaluation-loop Phase 1).
//
// The fire-log's override classification (`fire-log.ts`'s `classifyOverride`)
// needs an oracle answering "is this env-var name a documented, registered
// escape-hatch?" per the RFC (Notion 392937f0): `authorized_exception` when
// yes, `unclassified` when an env var was used that ISN'T in the oracle.
//
// The canonical oracle is `HOOK_ONLY_ENV_VARS` in
// `packages/domain/src/configuration/sources/environment.ts` (the mt#1788
// registry every guard/pre-commit override env var MUST appear in, or the
// env-var-to-config dot-path parser crashes the CLI at boot when the var is
// set on a deployed environment). This module CANNOT import that file
// directly: `.minsky/hooks/` is dependency-free per `SPEC.md` (no
// `packages/domain` imports) so the hooks tree keeps working even when the
// main codebase has type errors — the same reason `guard-health.ts` and
// `mcp-daemon-staleness-detector.ts` each duplicate a src-side reader rather
// than importing it (see those files' header comments).
//
// This is therefore a HAND-MAINTAINED SNAPSHOT, not a live import. Staleness
// here is soft-failing by design: a name missing from this set only
// downgrades that override's fire-log classification from
// `authorized_exception` to `unclassified` — it never changes a guard's
// actual allow/deny decision (classification is reporting-only, per the
// RFC's "no scoring/judgment" Phase-1 constraint). Keep in sync when adding a
// new override env var to HOOK_ONLY_ENV_VARS; a drift is cosmetic, not
// load-bearing.
//
// @see mt#2597 — this task
// @see packages/domain/src/configuration/sources/environment.ts — HOOK_ONLY_ENV_VARS, the canonical source this mirrors
// @see .minsky/hooks/fire-log.ts — the sole consumer (classifyOverride)
export const KNOWN_OVERRIDE_ENV_VARS: ReadonlySet<string> = new Set([
  "MINSKY_ACK_ASK_ROUTING_DEFERRAL",
  "MINSKY_ACK_CAUSAL_PREMISE",
  "MINSKY_ACK_CODE_MECHANISM_ASSERTION",
  "MINSKY_ACK_OOB_MERGE",
  "MINSKY_ACK_PRE_NARRATION",
  "MINSKY_ACK_RETROSPECTIVE_TRIGGER",
  "MINSKY_ACK_SUBSTRATE_BYPASS",
  "MINSKY_ACK_TASK_HIJACK",
  "MINSKY_AUTO_MIGRATE",
  "MINSKY_COCKPIT_PERSISTENCE_INIT_TIMEOUT_MS",
  "MINSKY_COCKPIT_PREVIEW",
  "MINSKY_DEPLOY_MEMORY_FILE",
  "MINSKY_DEV_CHROMIUM_EXECUTABLE",
  "MINSKY_DEV_CHROMIUM_USER_DATA_DIR",
  "MINSKY_FORCE_BYPASS",
  "MINSKY_FORCE_DUPLICATE_OK",
  "MINSKY_FORCE_EDIT_GENERATED",
  "MINSKY_FORCE_LOOP_TERMINAL",
  "MINSKY_FORCE_PARALLEL",
  "MINSKY_HOME",
  "MINSKY_HOOK_OVERRIDE",
  "MINSKY_LOADED_COMMIT",
  "MINSKY_MAIN_WORKSPACE",
  "MINSKY_MCP_ALLOW_UNKNOWN_PARAMS",
  "MINSKY_MCP_INIT_RETRY_INTERVAL_MS",
  "MINSKY_MCP_INSTRUCTIONS_BUNDLE",
  "MINSKY_MCP_MAX_SESSIONS",
  "MINSKY_MCP_MEMORY_ENRICHMENT_TIMEOUT_MS",
  "MINSKY_MCP_MEMORY_ENRICHMENT",
  "MINSKY_MCP_PROFILE",
  "MINSKY_MCP_RETRY_AFTER_SECS",
  "MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS",
  "MINSKY_MCP_TOOL_NAMES",
  "MINSKY_MIGRATIONS_FOLDER",
  "MINSKY_NON_INTERACTIVE",
  "MINSKY_PACKAGE_ROOT",
  "MINSKY_POLICY_COVERAGE_MODE",
  "MINSKY_POSTGRES_MAX_CONNECTIONS",
  "MINSKY_PROJECT",
  "MINSKY_REVIEWER_APP_ID",
  "MINSKY_REVIEWER_HEALTH_URL",
  "MINSKY_REVIEWER_INSTALLATION_ID",
  "MINSKY_REVIEWER_PRIVATE_KEY",
  "MINSKY_REVIEWER_TIER2_ENABLED",
  "MINSKY_REVIEWER_WATCH_BOT_LOGIN",
  "MINSKY_REVIEWER_WATCH_INTERVAL_MS",
  "MINSKY_REVIEWER_WATCH_OWNER",
  "MINSKY_REVIEWER_WATCH_REPO",
  "MINSKY_REVIEWER_WATCH_THRESHOLD",
  "MINSKY_RUN_MODE",
  "MINSKY_SESSIONDB_POSTGRES_URL",
  "MINSKY_SHOW_SQL",
  "MINSKY_SKIP_BRIDGE_RETIREMENT",
  "MINSKY_SKIP_BUNDLE_SMOKE",
  "MINSKY_SKIP_CALIBRATION_CADENCE",
  "MINSKY_SKIP_CLI_AUTORUN",
  "MINSKY_SKIP_DAEMON_STALENESS",
  "MINSKY_SKIP_DEPLOY_DOMAIN_CHECK",
  "MINSKY_SKIP_DEPLOY_VERIFY",
  "MINSKY_SKIP_DISPATCH_WATCHDOG_INJECTION",
  "MINSKY_SKIP_FRESHNESS",
  "MINSKY_SKIP_GIT_STATE_INJECTION",
  "MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK",
  "MINSKY_SKIP_MERGE_GRANT_CHECK",
  "MINSKY_SKIP_MIGRATION_JOURNAL_CHECK",
  "MINSKY_SKIP_NUL_CHECK",
  "MINSKY_SKIP_PROD_STATE_INJECTION",
  "MINSKY_SKIP_REQUIRED_CHECKS",
  "MINSKY_SKIP_SESSION_PATH_CHECK",
  "MINSKY_SKIP_SILENT_STRETCH",
  "MINSKY_SKIP_SIZE_BUDGET",
  "MINSKY_SKIP_SKILL_STALENESS",
  "MINSKY_SKIP_SMOKE_CHECK",
  "MINSKY_SKIP_SPEC_READ_CHECK",
  "MINSKY_SKIP_TIME_INJECTION",
  "MINSKY_SKIP_TRANSCRIPT_INGEST_HOOK",
  "MINSKY_SKIP_UNMERGED_MIGRATION_CHECK",
  "MINSKY_STATE_DIR",
  "MINSKY_TRANSCRIPT_INGEST_HOOK_EMBED",
  "MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS",
  "MINSKY_TWO_STRIKES_MODE",
  "MINSKY_TWO_STRIKES_STATE_DIR",
  "MINSKY_UNASKED_DIRECTION_DETECTOR",
  "MINSKY_VERBOSE",
]);
