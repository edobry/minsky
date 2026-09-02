/**
 * Environment Variable Configuration Source
 *
 * Maps environment variables to configuration values using automatic pattern matching and explicit mappings. Provides the highest priority configuration source.
 */

import type { PartialConfiguration } from "../schemas";
import { elementAt } from "@minsky/shared/array-safety";

/**
 * Environment variable to configuration path mappings
 *
 * These mappings define how environment variables are translated into
 * configuration object paths.
 */
export const environmentMappings = {
  // Note: MINSKY_BACKEND removed - deprecated property, use tasks.backend config instead

  // Workspace configuration (NEW)
  MINSKY_WORKSPACE_MAIN_PATH: "workspace.mainPath",

  // GitHub configuration
  GITHUB_TOKEN: "github.token",
  GH_TOKEN: "github.token", // Fallback for GitHub CLI
  GITHUB_ORGANIZATION: "github.organization",
  GITHUB_REPOSITORY: "github.repository",
  GITHUB_BASE_URL: "github.baseUrl",
  GITHUB_API_URL: "github.baseUrl",

  // GitHub App service account configuration
  MINSKY_APP_ID: "github.serviceAccount.appId",
  MINSKY_APP_PRIVATE_KEY_FILE: "github.serviceAccount.privateKeyFile",
  MINSKY_APP_INSTALLATION_ID: "github.serviceAccount.installationId",
  MINSKY_GITHUB_APP_PRIVATE_KEY: "github.serviceAccount.privateKey",

  // AI provider configuration
  OPENAI_API_KEY: "ai.providers.openai.apiKey",
  OPENAI_ORGANIZATION: "ai.providers.openai.organization",
  OPENAI_BASE_URL: "ai.providers.openai.baseUrl",

  ANTHROPIC_API_KEY: "ai.providers.anthropic.apiKey",
  ANTHROPIC_BASE_URL: "ai.providers.anthropic.baseUrl",

  GOOGLE_API_KEY: "ai.providers.google.apiKey",
  GOOGLE_AI_API_KEY: "ai.providers.google.apiKey",
  GOOGLE_PROJECT_ID: "ai.providers.google.projectId",

  COHERE_API_KEY: "ai.providers.cohere.apiKey",

  MISTRAL_API_KEY: "ai.providers.mistral.apiKey",

  AI_DEFAULT_PROVIDER: "ai.defaultProvider",

  // Observability provider configuration (mt#1791)
  BRAINTRUST_API_KEY: "observability.providers.braintrust.apiKey",
  BRAINTRUST_PROJECT_NAME: "observability.providers.braintrust.projectName",
  BRAINTRUST_API_URL: "observability.providers.braintrust.apiUrl",

  // Persistence configuration (modern — populates `persistence.*`)
  MINSKY_PERSISTENCE_BACKEND: "persistence.backend",
  MINSKY_PERSISTENCE_POSTGRES_URL: "persistence.postgres.connectionString",

  // Persistence configuration (modern key). MINSKY_POSTGRES_URL is the canonical
  // escape hatch documented in persistence-config.ts and surfaced in factory /
  // validation error messages; it requires an explicit mapping because the
  // auto-conversion fallback would route it to "postgres.url" instead of
  // "persistence.postgres.connectionString".
  MINSKY_POSTGRES_URL: "persistence.postgres.connectionString",

  // Session-mode connection string for LISTEN/NOTIFY operations (mt#1852).
  // Supavisor transaction pooler (:6543) is LISTEN-incompatible; session mode
  // (:5432) keeps backend connections alive across commands. When unset, the
  // provider auto-derives by swapping :6543 → :5432 from connectionString.
  MINSKY_POSTGRES_SESSION_URL: "persistence.postgres.sessionConnectionString",

  // Fail-fast Postgres connect for short-lived CLI invocations (mt#2982).
  // Hook-shelled `minsky` CLI calls (see .minsky/hooks/types.ts execWithPath)
  // inject a short value so a hanging/reconnecting DB yields a fast, clearly
  // attributed connect failure instead of hanging to the guard's spawn-kill
  // (default connect_timeout 10s vs guard budgets of 4-8s). Explicit mapping
  // required: the auto-conversion fallback would route CONNECT_TIMEOUT to
  // "persistence.postgres.connect.timeout", which the persistence schema
  // rejects at boot. Value type registered in fieldTypes below — the schema
  // is z.number().int() with no coercion.
  MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT: "persistence.postgres.connectTimeout",

  // Supabase Management API credentials (developer-local; consumed by
  // `just supabase-usage`). Distinct from the Postgres connection string,
  // which lives under MINSKY_PERSISTENCE_POSTGRES_URL.
  MINSKY_SUPABASE_ACCESS_TOKEN: "supabase.accessToken",

  // Supabase Storage credentials for the transcript raw archive (ADR-025 /
  // mt#2680). Explicit mappings are required: the dot-path auto-conversion
  // would route MINSKY_SUPABASE_SERVICE_ROLE_KEY to
  // `supabase.service.role.key` (a rejected path) and crash the loader at
  // boot when the var is set on a deployed environment.
  MINSKY_SUPABASE_URL: "supabase.url",
  MINSKY_SUPABASE_SERVICE_ROLE_KEY: "supabase.serviceRoleKey",
  MINSKY_TRANSCRIPT_ARCHIVE_BUCKET: "transcriptArchive.bucket",

  // Reviewer webhook-service configuration (mt#2269). Consumed by the
  // `reviewer.retrigger` command to authenticate against the reviewer
  // service's /retrigger endpoint. Explicit mappings are required so a value
  // set on a deployed environment routes to the correct config path instead of
  // the dot-path auto-conversion (which would produce `reviewer.webhook.secret`
  // / a rejected key) and crash the loader at boot.
  MINSKY_REVIEWER_WEBHOOK_SECRET: "reviewer.webhookSecret",
  MINSKY_REVIEWER_URL: "reviewer.url",

  // Bot-identity de-hardcoding (mt#2392). The merge-gate waiver logic, the
  // reviewer-watch detector, and the check-run submitter resolve bot identities
  // from these config paths (falling back to Minsky's own App logins when
  // unset) so external projects can run Minsky against their own bots.
  MINSKY_REVIEWER_BOT_LOGIN: "reviewer.botLogin",
  MINSKY_REVIEWER_CHECK_RUN_NAME: "reviewer.checkRunName",
  MINSKY_GITHUB_BOT_IDENTITY_LOGIN: "github.botIdentityLogin",

  // MCP operator->service auth token (mt#2346). Promoted from HOOK_ONLY_ENV_VARS
  // to a real config path (its standing TODO). Consumed by `reviewer.retrigger`
  // to authenticate against the reviewer service's /retrigger endpoint without
  // the webhook HMAC secret. Explicit mapping mirrors the reviewer.* entries
  // above; the dot-path auto-conversion would also produce `mcp.auth.token`, but
  // an explicit entry documents intent and is robust to future renames.
  MINSKY_MCP_AUTH_TOKEN: "mcp.auth.token",

  // Principal Telegram channel (mt#3228, made launch-independent by mt#3230).
  // Explicit entries because the dot-path auto-conversion would produce
  // `principal.channel.*` — a top-level `principal` key the strict schema
  // rejects, crashing the loader at boot for anyone with these set. The
  // environment source is merged LAST, so these still override the config file
  // for deployed services that set them.
  MINSKY_PRINCIPAL_CHANNEL_ENABLED: "principalChannel.enabled",
  MINSKY_PRINCIPAL_CHANNEL_CWD: "principalChannel.cwd",
  MINSKY_PRINCIPAL_CHANNEL_PERMISSION_MODE: "principalChannel.permissionMode",
  MINSKY_PRINCIPAL_CHANNEL_ALLOWED_USER_IDS: "principalChannel.allowedUserIds",

  // Cockpit daemon configuration (mt#3641) — operator-configured extra
  // allowed Host name(s) layered onto the mt#2538 Host-header allowlist
  // (e.g. a Tailscale MagicDNS name). Explicit mapping because the dot-path
  // auto-conversion would produce `cockpit.allowedHosts` too (harmless here,
  // but explicit entries are the house convention for every other section
  // above, and this documents intent + survives a future rename).
  MINSKY_COCKPIT_ALLOWED_HOSTS: "cockpit.allowedHosts",
  // mt#3988: the port the cockpit daemon serves on AND the tray supervises.
  // Mapped (not hook-only) because both the daemon and `config get` read it
  // through the normal configuration tree; the tray reads the RESOLVED value
  // via `minsky config get cockpit.port` rather than this variable directly,
  // so the two cannot disagree.
  MINSKY_COCKPIT_PORT: "cockpit.port",
  // mt#4239: which MCP servers a driven session is provisioned with. Mapped
  // (not hook-only) because the cockpit reads it through the normal
  // configuration tree, the same way it reads `cockpit.port`. Needs the `csv`
  // conversion registered below — `cockpit.allowedHosts` is the precedent.
  MINSKY_COCKPIT_DRIVEN_SESSION_MCP_SERVERS: "cockpit.drivenSession.mcpServers",

  // OAuth configuration
  MINSKY_OAUTH_SIGNING_KEY: "oauth.signingKey",

  // Logger configuration
  MINSKY_LOG_MODE: "logger.mode",
  LOG_MODE: "logger.mode",
  LOGLEVEL: "logger.level",
  LOG_LEVEL: "logger.level",
  MINSKY_LOG_LEVEL: "logger.level",
  ENABLE_AGENT_LOGS: "logger.enableAgentLogs",
  MINSKY_ENABLE_AGENT_LOGS: "logger.enableAgentLogs",
  LOG_FILE: "logger.logFile",
  MINSKY_LOG_FILE: "logger.logFile",
} as const;

/**
 * Hook-only environment variables (mt#1644).
 *
 * These vars are read by `.claude/hooks/*.ts` subprocesses (external
 * consumers — the hook tree lives outside this package's import graph) but
 * have NO config-schema home. They are deliberately NOT in
 * `environmentMappings`.
 *
 * Without this skip-list, the auto-mapping fallback in
 * `loadEnvironmentConfiguration` would route them to camelCase config paths
 * (e.g. `MINSKY_FORCE_PARALLEL` -> `force.parallel`), which mt#1612's
 * strict-mode top-level validation rejects, crashing the CLI at startup.
 *
 * Both `loadEnvironmentConfiguration` and `getEnvironmentConfiguration`
 * honor this set so the loaded-config and metadata-reporting paths stay
 * consistent — diagnostics that consume `metadata.loadedVariables` see the
 * same view of "what env vars affected configuration" that the loader used.
 *
 * Register a new hook-only `MINSKY_*` var by adding it to
 * `HOOK_ONLY_ENV_VAR_CATEGORIES` below WITH a category — the set exported here
 * is derived from that record's keys (mt#3882), so there is nothing to keep in
 * sync by hand and nothing to edit directly.
 */
// Exported so the lint rule `eslint-rules/no-unregistered-minsky-env-var.js`
// (mt#1788) can grep this file for the canonical allowlist. The rule does
// AST-based extraction (since ESLint runs under Node and can't import .ts),
// so the export is a parallel signal — the const stays here regardless.

/**
 * What KIND of hook-only var an entry is (mt#3882).
 *
 * This distinction used to exist only in prose at each var's definition site,
 * which is why `.minsky/hooks/known-override-env-vars.ts` — the hooks-tree
 * list of operator escape hatches — could not be checked against anything and
 * drifted 63 entries behind in one direction while carrying 45 entries that
 * were never escape hatches in the other. Recording it HERE, once, is what
 * lets a test derive that list instead of asking every future guard author to
 * remember an unwritten rule.
 *
 * - `operator-override` — a guard, gate or detector consults this var as its
 *   OWN override: setting it makes that mechanism not apply its decision
 *   (skip, allow, suppress). This is the population the fire log's
 *   `authorized_exception` classification is about, and the exact set
 *   `KNOWN_OVERRIDE_ENV_VARS` must equal. An opt-IN that turns on additional
 *   behavior is not one of these — it overrides nothing.
 * - `test-fixture` — set by tests or the guard-canary harness, never by an
 *   operator in normal use.
 * - `tunable` — everything else: thresholds, paths, credentials, feature
 *   flags, service config, process-to-process signals. Legitimate to set;
 *   simply not an override of anybody's decision.
 */
export type HookOnlyEnvVarCategory = "operator-override" | "test-fixture" | "tunable";

/**
 * The canonical registry, keyed by var name so each entry's category sits
 * beside the comment its author was already writing.
 *
 * **An entry does NOT require a read site, and a test asserting otherwise would
 * be wrong (PR #3077 R1).** This registry's job is to make the dot-path parser
 * SKIP a name, which depends on whether an operator might SET the var — not on
 * whether any code reads it. `MINSKY_SESSIONDB_POSTGRES_URL` is the worked
 * example: no `.ts` file reads it (sessiondb was retired in mt#1610), and its
 * entry is load-bearing precisely for that reason, because
 * `services/reviewer/DEPLOY.md` and `docs/supabase-pooler-switch.md` still show
 * operators setting it. Drop the entry and the parser starts mapping
 * `sessiondb.postgres.url`, which strict validation rejects at boot — the exact
 * mt#1785 crash. The reverse direction (an access with no entry) IS mechanically
 * enforced, by `custom/no-unregistered-minsky-env-var`.
 *
 * **The record shape is load-bearing, not a style choice.**
 * `eslint-rules/no-unregistered-minsky-env-var.js` cannot import this file
 * (ESLint runs under Node, which will not load TypeScript), so it extracts
 * names by matching the SOURCE TEXT with two line-anchored regexes. A
 * `  MINSKY_FOO: "operator-override",` line is matched by its `mappingKeyRe`
 * (`/^[ \t]*["']?(MINSKY_[A-Z0-9_]+)["']?[ \t]*:/gm`). An array of objects
 * (`{ name: "MINSKY_FOO", … }`) would match NEITHER of its regexes, silently
 * yielding an empty registry — and its empty-registry branch flags every
 * `process.env.MINSKY_*` read in the repo. Keep one entry per line, name
 * first, colon after.
 */
export const HOOK_ONLY_ENV_VAR_CATEGORIES: Readonly<Record<string, HookOnlyEnvVarCategory>> = {
  // mt#3101 — NOT hook-read: this one is read by domain code
  // (`provenance/authorship-judging-flag.ts`). It belongs in this set for the
  // set's actual reason rather than its historical name — it is a `MINSKY_*`
  // var with no config-schema home, so without an entry the auto-mapping
  // fallback would route it to `authorship.tierJudging` and mt#1612
  // strict-mode validation would reject it, crashing the CLI whenever it is
  // set. Default-off switch for merge-time AI authorship-tier judging
  // (ask#5581).
  MINSKY_AUTHORSHIP_TIER_JUDGING: "tunable",
  MINSKY_FORCE_PARALLEL: "operator-override", // .claude/hooks/parallel-work-guard.ts
  MINSKY_FORCE_DUPLICATE_OK: "operator-override", // .claude/hooks/parallel-work-guard.ts (mt#1435 — tasks_create dup guard)
  MINSKY_ALLOW_NESTED_FORK: "operator-override", // .claude/hooks/block-nested-fork-dispatch.ts (mt#3045) — launch-time-only override for an undeclared nested fork dispatch
  MINSKY_SKIP_FRESHNESS: "operator-override", // .claude/hooks/check-branch-fresh.ts
  MINSKY_TWO_STRIKES_STATE_DIR: "tunable", // .claude/hooks/two-strikes-record.ts
  MINSKY_TWO_STRIKES_MODE: "tunable", // .claude/hooks/two-strikes-record.ts
  MINSKY_SKIP_BUNDLE_SMOKE: "operator-override", // .claude/hooks/require-review-before-merge.ts (mt#1787)
  MINSKY_SKIP_REQUIRED_CHECKS: "operator-override", // .claude/hooks/require-review-before-merge.ts (mt#1938)
  MINSKY_SKIP_SMOKE_CHECK: "operator-override", // .claude/hooks/require-review-before-merge.ts (mt#2060)
  MINSKY_SKIP_DEPLOY_VERIFY: "operator-override", // .claude/hooks/require-deploy-verification-before-merge.ts (mt#2353)
  MINSKY_SKIP_SUBAGENT_MODEL_CHECK: "operator-override", // .claude/hooks/verify-subagent-model.ts (mt#3257) — subagent model-verification observer override
  MINSKY_SKIP_CHAINED_VERIFICATION_SCAN: "operator-override", // .claude/hooks/chained-verification-commands-detector.ts (mt#3910) — chained-verification-command observer override
  MINSKY_SKIP_TRUNCATED_OUTCOME_READ: "operator-override", // .claude/hooks/truncated-outcome-read-detector.ts (mt#4096) — truncated-outcome-read observer override
  MINSKY_SKIP_NONEXISTENT_SEARCH_PATH: "operator-override", // .claude/hooks/nonexistent-search-path-detector.ts (mt#4215) — nonexistent-search-path observer override
  MINSKY_SKIP_GUARD_EVENTS_INGEST_HOOK: "operator-override", // .claude/hooks/guard-events-ingest-on-session-end.ts (mt#4035) — SessionEnd guard-events sweep-tick override
  MINSKY_GUARD_EVENTS_SWEEP_INTERVAL_MS: "tunable", // src/cockpit/sweepers.ts (mt#4035) — cockpit guard-events sweep-backstop cadence override (positive integer ms)
  MINSKY_TEST_WATCHDOG_MS: "tunable", // scripts/spawn-with-watchdog.ts (mt#3156) — wall-clock budget override for the test-runner watchdog
  MINSKY_TEST_READY_TIMEOUT_MS: "test-fixture", // src/commands/mcp/start-command.test.ts (mt#3140) — readiness-marker deadline override for the shutdown-path tests
  MINSKY_TEST_CLOCK_SHIFT_DAYS: "test-fixture", // tests/clock-shift.ts (mt#4726) — moves the wall clock forward by N days for the whole suite, so a fixture pinned to an absolute instant expires in a scheduled nightly instead of on a real PR. Set only by scripts/run-tests-clock-shifted.ts; UNSET is inert and every ordinary run is unaffected
  // mt#4017 — NOT hook-read: this one is read by scripts/drizzle-config-loader.ts,
  // which calls loadConfiguration() itself, so the var is present in process.env
  // when the loader's own environment source parses it. It is the sanctioned-
  // caller gate signal drizzle.pg.config.ts sets on that script's subprocess
  // environment before invoking it — the script refuses to print its stdout
  // (a live DB connection string) without it. No config-schema home; without
  // this entry the auto-mapping fallback would route it to
  // `drizzle.loader.gate` and mt#1612 strict-mode validation would reject it,
  // crashing the loader itself on the very invocation the gate exists to allow.
  MINSKY_DRIZZLE_LOADER_GATE: "tunable",
  // Pre-push test-gate controls (.husky/pre-push -> scripts/run-tests-gated.ts).
  // Neither has a config-schema home, so without entries here the auto-mapping
  // fallback would route them to `skip.prepushTests` / `prepush.fullSuite` and
  // mt#1612 strict validation would reject them — crashing the CLI for anyone
  // who has them set. MINSKY_SKIP_PREPUSH_TESTS predates mt#3562 and was never
  // registered; added here because it is the same one-line defect as the new
  // var beside it, not as a separate change.
  MINSKY_SKIP_PREPUSH_TESTS: "operator-override", // .husky/pre-push (mt#2716) — skip the local suite entirely
  MINSKY_PREPUSH_FULL_SUITE: "tunable", // scripts/run-tests-gated.ts (mt#3562) — force the unscoped full suite
  MINSKY_SKIP_NUL_CHECK: "operator-override", // src/hooks/pre-commit.ts (mt#1824) — NUL-byte check override
  MINSKY_SKIP_CONFLICT_MARKER_CHECK: "operator-override", // src/hooks/pre-commit.ts (mt#4307) — conflict-marker check override
  MINSKY_SKIP_NO_DEPLOY_IMPACT_CHECK: "operator-override", // src/hooks/commit-msg.ts (mt#4397) — skip verifying a [no-deploy-impact] claim against the deploy-surface predicate
  MINSKY_SKIP_MIGRATION_JOURNAL_CHECK: "operator-override", // src/hooks/pre-commit.ts (mt#2087) — migration journal consistency check override
  MINSKY_SKIP_DEPLOY_DOMAIN_CHECK: "operator-override", // src/hooks/pre-commit.ts (mt#2208) — deploy-domain ownership check override
  MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK: "operator-override", // src/hooks/pre-commit.ts (mt#2268) — immutable-migration (edit-applied-migration) check override
  MINSKY_SKIP_MIGRATION_COLLISION_CHECK: "operator-override", // src/hooks/pre-commit.ts (mt#2948) — journal-when-immutability + concurrent-migration-collision check override
  MINSKY_SKIP_MIGRATION_GUARD_CHECK: "operator-override", // src/hooks/pre-commit.ts (mt#3299) — unguarded DROP INDEX / CREATE UNIQUE INDEX check override
  MINSKY_SKIP_DUPLICATE_GENERATED_CONTENT_CHECK: "operator-override", // src/hooks/pre-commit.ts (mt#3299) — duplicate-generated-content check override
  MINSKY_SKIP_ADR_NUMBERING_COLLISION_CHECK: "operator-override", // src/hooks/pre-commit.ts (mt#3613) — ADR-numbering-collision check override
  MINSKY_SKIP_RELATED_TESTS: "operator-override", // src/hooks/pre-commit.ts (mt#2932) — fast changed-file-scoped related-test gate override
  MINSKY_SKIP_CLI_AUTORUN: "tunable", // src/cli.ts (mt#1892) — gates the auto-main() invocation for build scripts that need to import createCli without running it
  // mt#2335 — loaded-source freshness signal. Set by scripts/cli-entry.ts BEFORE
  // it imports the bundle, read by src/mcp/source-freshness.ts (surfaced in
  // debug.systemInfo). Must be registered so the env-var-to-config dot-path
  // parser skips them at boot (mt#1785 class) instead of mapping e.g.
  // MINSKY_LOADED_COMMIT -> loaded.commit.
  MINSKY_LOADED_COMMIT: "tunable", // scripts/cli-entry.ts -> src/mcp/source-freshness.ts
  MINSKY_RUN_MODE: "tunable", // scripts/cli-entry.ts -> src/mcp/source-freshness.ts
  MINSKY_PACKAGE_ROOT: "tunable", // scripts/cli-entry.ts -> src/mcp/source-freshness.ts
  // mt#1788 sweep — pre-existing src/ reads now registered as hook-only.
  // Many of these arguably belong in environmentMappings with a proper config
  // path; that promotion is a follow-up. The immediate goal is making the
  // env-var-to-config parser SKIP them so Railway env-var sets don't crash
  // the loader. Each entry is annotated with a representative read site.
  MINSKY_NON_INTERACTIVE: "tunable", // src/cli.ts, src/utils/interactive.ts (UX flag)
  MINSKY_VERBOSE: "tunable", // src/adapters/cli/utils/error-handler.ts (debug flag)
  MINSKY_SHOW_SQL: "tunable", // (debug flag — promote to logger.* if it grows)
  MINSKY_STATE_DIR: "tunable", // src/mcp/disconnect-tracker.ts (process-local path override)
  MINSKY_COCKPIT_URL: "tunable", // .claude/hooks/record-conversation-run-state.ts (mt#3161) — cockpit daemon origin override for the run-state writer
  // mt#4149 — preflight budgets for the browser-driving `scripts/verify-*.ts`
  // family, all read in `scripts/lib/verify-preflight.ts`. Registered because an
  // operator raising one of these on a contended machine would otherwise crash
  // the CLI at boot: the dot-path parser maps e.g.
  // MINSKY_VERIFY_REACH_TIMEOUT_MS -> verify.reach.timeout.ms, which strict
  // config validation rejects.
  MINSKY_VERIFY_REACH_TIMEOUT_MS: "tunable", // scripts/lib/verify-preflight.ts — "is anything listening?" budget (default 3000)
  MINSKY_VERIFY_HEALTH_TIMEOUT_MS: "tunable", // scripts/lib/verify-preflight.ts — health-body read + identity-parse budget (default 5000)
  MINSKY_VERIFY_SLOW_CONFIRM_TIMEOUT_MS: "tunable", // scripts/lib/verify-preflight.ts — how long to keep measuring a target that already missed its budget (default 30000)
  MINSKY_DEPLOY_MEMORY_FILE: "tunable", // (deployment-time bootstrap; not config)
  MINSKY_MAIN_WORKSPACE: "test-fixture", // (test-fixture constant)
  MINSKY_ALLOW_TEST_DB: "test-fixture", // src/cockpit/db-providers.ts (mt#3254) — opts a test into a real LOCAL database; without it the production resolution path refuses to hand a live connection to a test process
  MINSKY_VERIFY_DATABASE_URL: "test-fixture", // scripts/verify-driven-session-conversations.ts (mt#4323) — points the live probe at a scratch database so its DDL/ORDER BY assertions can run pre-merge without applying the migration to production first
  MINSKY_SESSIONDB_POSTGRES_URL: "tunable", // legacy detection (post-mt#1610 retire)
  MINSKY_MCP_MAX_SESSIONS: "tunable", // src/mcp/server.ts (server config — promote to mcp.maxSessions)
  MINSKY_MCP_PROFILE: "tunable", // src/utils/cold-start-profile.ts (debug flag)
  MINSKY_MCP_RETRY_AFTER_SECS: "tunable", // src/mcp (server config — promote to mcp.retryAfterSecs)
  MINSKY_MCP_SESSION_IDLE_TIMEOUT_MS: "tunable", // src/mcp (server config — promote to mcp.sessionIdleTimeoutMs)
  MINSKY_MCP_SESSION_REAPER_INTERVAL_MS: "tunable", // src/mcp/server.ts (mt#3814 — sweep interval; pairs with the idle timeout above, which was untunable without it)
  MINSKY_MCP_SESSION_ADMISSION_WATERMARK_MB: "tunable", // src/mcp/daemon/memory-admission.ts (mt#3814 — resident-memory watermark above which the shared daemon refuses NEW sessions)
  MINSKY_MCP_TOOL_NAMES: "tunable", // src/mcp/server.ts (naming convention flag)
  MINSKY_MCP_ALLOW_UNKNOWN_PARAMS: "tunable", // src/mcp/command-mapper.ts (mt#2778 — escape hatch: downgrade undeclared-param rejection to a warn log; promote to mcp.allowUnknownParams if it grows)
  MINSKY_MCP_ALLOW_INVALID_PARAM_VALUES: "tunable", // src/adapters/mcp/shared-command-integration.ts (mt#3155 — escape hatch: downgrade wrong-typed provided-value rejection to a warn log; promote to mcp.allowInvalidParamValues if it grows)
  MINSKY_MCP_MEMORY_ENRICHMENT: "tunable", // src/mcp (feature flag)
  MINSKY_MCP_MEMORY_ENRICHMENT_TIMEOUT_MS: "tunable", // src/mcp (feature config)
  MINSKY_MCP_INSTRUCTIONS_BUNDLE: "tunable", // src/mcp/middleware/memory-bundle.ts (mt#1625 spike — opt-in flag)
  MINSKY_MCP_INIT_RETRY_INTERVAL_MS: "tunable", // src/commands/mcp/start-command.ts (mt#1962 — init retry backoff)
  MINSKY_POSTGRES_MAX_CONNECTIONS: "tunable", // src/domain (pool config — promote to persistence.postgres.maxConnections)
  MINSKY_COCKPIT_PERSISTENCE_INIT_TIMEOUT_MS: "tunable", // src/cockpit/shared-persistence.ts (mt#2244 — init-timeout override)
  // mt#1994 — hook-only override env vars whose only read site is in
  // .claude/hooks/*.ts (outside the mt#1788 ESLint rule's prior scan path).
  // Each is documented in CLAUDE.md or the hook's own header as a user-facing
  // escape valve. Without registration, setting any of these crashes the CLI
  // at boot because the env-var-to-config dot-path parser converts e.g.
  // `MINSKY_ACK_OOB_MERGE` → `ack.oob.merge`, which the strict config schema
  // rejects (`Unrecognized key: "ack"`). The mt#1994 PR also extends the
  // ESLint rule to scan .claude/hooks/**/*.ts so future hook authors can't
  // reintroduce the gap.
  MINSKY_ACK_OOB_MERGE: "operator-override", // .claude/hooks/block-out-of-band-merge.ts (mt#1695)
  MINSKY_FORCE_EDIT_GENERATED: "operator-override", // .claude/hooks/check-generated-file-edit.ts (mt#1699)
  MINSKY_SKIP_SKILL_STALENESS: "operator-override", // .claude/hooks/skill-staleness-detector.ts (mt#1622)
  MINSKY_HOME: "tunable", // .claude/hooks/mcp-daemon-staleness-detector.ts + src/mcp/daemon-state.ts (state-dir override)
  MINSKY_FORCE_LOOP_TERMINAL: "operator-override", // .claude/hooks/loop-preflight-pr-merge-check.ts
  MINSKY_SKIP_DAEMON_STALENESS: "operator-override", // .claude/hooks/mcp-daemon-staleness-detector.ts
  MINSKY_CANARY_MODE: "test-fixture", // .claude/hooks/types.ts (mt#3004, PR #2145 R1) — canary-mode gate set only by scripts/run-guard-canaries.ts + tests; the two seams below are honored only while it is "1"
  MINSKY_DAEMON_TRACKER_HOME: "test-fixture", // .claude/hooks/mcp-daemon-staleness-detector.ts (mt#3004) — canary-gated tracker-home override for the guard-canary suite
  MINSKY_MEMORY_SEARCH_CANARY_STUB: "test-fixture", // .claude/hooks/memory-search.ts (mt#3004) — canary-gated fixture-file stub replacing the CLI subprocess in the guard-canary suite
  MINSKY_UNASKED_DIRECTION_DETECTOR: "operator-override", // .claude/hooks/post-merge-unasked-direction-scan.ts
  // mt#1767 / mt#2560 — auto-migration controls in postgres-provider.ts.
  // Process-only; they govern boot-time behavior, not runtime config. Adding to
  // the hook-only set so Railway env-var sets (e.g. MINSKY_AUTO_MIGRATE=1 as the
  // local/dev opt-in) don't crash the loader via the env-var-to-config dot-path
  // parser.
  MINSKY_AUTO_MIGRATE: "tunable", // src/domain/persistence/providers/postgres-provider.ts (auto-migrate opt-in, default OFF per mt#2560)
  MINSKY_MIGRATIONS_FOLDER: "tunable", // src/domain/persistence/providers/postgres-provider.ts (migrations path override)
  MINSKY_ACK_SUBSTRATE_BYPASS: "operator-override", // .claude/hooks/substrate-bypass-detector.ts (mt#2020) — override for substrate-bypass warning injection
  MINSKY_ACK_RETROSPECTIVE_TRIGGER: "operator-override", // .claude/hooks/retrospective-trigger-scanner.ts (mt#2057) — override for retrospective-trigger warning injection
  MINSKY_SKIP_RETRO_COMPLETENESS: "operator-override", // .claude/hooks/retrospective-completeness-detector.ts (mt#3601) — override for the log-only retrospective structural-completeness scan
  MINSKY_DISABLE_RUNG2_NOMINATION: "operator-override", // .claude/hooks/retrospective-trigger-scanner.ts (mt#3408) — kill switch for the ADR-024 Rung-2 embedding nomination stage; Rung 1 keeps running
  MINSKY_RUNG2_NOMINATION_ENFORCE: "tunable", // .claude/hooks/retrospective-trigger-scanner.ts (mt#3408) — opt-in to letting Rung-2 nominations contribute to the injected reminder; default is log-only (measured 3/3 FP, see the constant's docblock)
  MINSKY_KA_RUNG2_NOMINATION: "tunable", // .claude/hooks/knowledge-acquisition-detector.ts (mt#3772) — opt-in to Rung-2 embedding nomination for the skill-relevance gate; default is the lexical gate, because the 0.455 threshold was derived from a different exemplar band and is unmeasured here
  MINSKY_CMA_RUNG2_NOMINATION: "tunable", // .claude/hooks/code-mechanism-assertion-detector.ts (mt#4155) — opt-in to Rung-2 embedding nomination for the identity/equivalence claim class ("X is the single reader"), which carries no behavior verb any PREDICATE_PATTERNS entry matches; default is the lexical path, because the 0.455 threshold was derived from the retrospective-trigger exemplar band and is unmeasured on this corpus
  MINSKY_ARD_ACTIONABLES_NOMINATION: "tunable", // .claude/hooks/ask-routing-deferral-detector.ts (mt#4807) — opt-in to Rung-2 embedding nomination for the actionables-decision DETECTOR, which finds a Tier-0 decision stated flatly inside the terminal actionables block: the one place `communication-contract.mdc` already forbids putting one, and the class the two pattern families structurally cannot reach (measured over 846 transcripts, recall on flat declaratives is ~2% because the patterns match offer PHRASING). Default off, and LOG-ONLY even when on — matches never join the array that feeds `buildReminder`, so `INJECTION_ENABLED` cannot reach this family
  MINSKY_ARD_RUNG2_NOMINATION: "tunable", // .claude/hooks/ask-routing-deferral-detector.ts (mt#4404) — opt-in to Rung-2 embedding nomination for the settled-decision SUPPRESSOR, which reaches the renderings `SETTLED_DECISION_PATTERNS` cannot (participial lead, present progressive, conditional mood, default-plus-escape continuation); default is the lexical path, because the threshold that decides a suppression must be measured on this corpus before it is allowed to silence anything — a wrong value here silences a genuine deferral rather than merely missing one
  MINSKY_ODD_RUNG2_NOMINATION: "tunable", // .claude/hooks/operator-deferral-detector.ts (mt#4649) — phase 2 of the same climb, for the PERMISSION-ASK surface. Deliberately a SEPARATE flag from MINSKY_ARD_RUNG2_NOMINATION rather than one shared switch: ADR-024 gates rung climbs per detector on that detector's own evidence, so coupling them would make either detector's residual unattributable. Off by default for phase 1's reason, which is sharper here — a false suppression on this surface silences a PERMISSION ASK, and the exclusions it sits beside are load-bearing precisely because an in-authority ask and a genuinely-reserved one have the same shape
  MINSKY_SKIP_SYMBOL_FREE_CLAIMS: "operator-override", // .claude/hooks/code-mechanism-assertion-detector.ts (mt#3726) — turn the symbol-FREE Rung-2 cohort (invocation-path both signs, subsystem-property, external-system-mechanism, log-attribution) back off while leaving mt#4155's identity family running, so a calibration review that finds this cohort noisy can quiet it without reverting a family whose records are clean; the cohort ships with NO suppression (its claims carry no symbol to look up), which is its known over-fire source
  MINSKY_DISABLE_RUNG3_CONFIRM: "operator-override", // .claude/hooks/retrospective-trigger-scanner.ts (mt#3652) — kill switch for the ADR-024 Rung-3 Haiku confirm stage; Rungs 1-2 keep running (nominations revert to log-only)
  MINSKY_ACK_PRE_NARRATION: "operator-override", // .claude/hooks/pre-narration-detector.ts (mt#2197) — override for pre-narrated/fabricated-outcome warning injection
  MINSKY_SKIP_SESSION_PATH_CHECK: "operator-override", // .claude/hooks/check-guessed-session-path.ts (mt#2195) — override for guessed/nonexistent session-path guard
  MINSKY_ALLOW_SECRET_FILE_READ: "operator-override", // .claude/hooks/block-secret-file-read.ts (mt#3282) — override for the secret-bearing-file read guard
  MINSKY_ALLOW_CONCURRENT_BULK_MUTATION: "operator-override", // .claude/hooks/block-concurrent-bulk-mutation.ts (mt#4055) — override when two concurrent runs of one script are genuinely intended
  MINSKY_ALLOW_BULK_PROCESS_KILL: "operator-override", // .claude/hooks/block-bulk-process-kill.ts (mt#4081) — override when a mass kill of the working set is genuinely what was asked for
  MINSKY_SKIP_DUPLICATE_RECORD: "operator-override", // .claude/hooks/require-duplicate-check-record.ts (mt#3673) — override for the tasks_create duplicate-check-record gate
  MINSKY_SKIP_FLAKINESS_CONTROL: "operator-override", // .claude/hooks/flakiness-control-detector.ts (mt#3658) — override for the tasks_create flakiness-isolation-control detector
  MINSKY_SKIP_DUPLICATE_SIGNATURE_SCAN: "operator-override", // .claude/hooks/duplicate-signature-scan.ts (mt#3722) — skip the log-only corpus scan for signature-token overlap
  MINSKY_SKIP_STALE_SIGNAL_SWEEP: "operator-override", // .claude/hooks/stale-signal-sweep.ts (mt#3959) — skip the log-only sweep for artifacts quoting an output label this PR stopped emitting
  MINSKY_SKIP_UNRENDERED_RESULT_FIELD_SCAN: "operator-override", // .claude/hooks/unrendered-result-field-scan.ts (mt#3913) — skip the log-only scan for *Result counter fields no output site renders
  MINSKY_SKIP_NEW_SURFACE_DESIGN_PASS: "operator-override", // .claude/hooks/new-surface-design-pass.ts (mt#4124) — skip the log-only scan for a branch that ADDS a render-path surface with no design skill invoked
  MINSKY_SKIP_AGENT_DISPATCH_RECORD: "operator-override", // .claude/hooks/record-agent-dispatch.ts (mt#2292) — skip the dispatch-row DB write on the raw Agent spawn path; the prompt stamp is still emitted, so the Stop side can still correlate
  MINSKY_SKIP_BRIDGE_RETIREMENT: "operator-override", // .claude/hooks/bridge-memory-retirement.ts (mt#2062) — suppress bridge-memory retirement reminder
  MINSKY_SKIP_READY_CHAIN_WALK: "operator-override", // .claude/hooks/drive-ready-to-implementation.ts (mt#3373) — suppress the READY -> /implement-task chain-walk reminder
  MINSKY_COCKPIT_PREVIEW: "tunable", // src/cockpit/server.ts (mt#2096) — preview-mode guard disabling mutation endpoints
  MINSKY_COCKPIT_RP_ID: "tunable", // src/cockpit/server.ts (mt#4023) — WebAuthn relying-party id for the public deployment; defaults to the Railway hostname. Changing it invalidates every enrolled passkey, since a credential is bound to the rpID it was created under.
  MINSKY_COCKPIT_ORIGIN: "tunable", // src/cockpit/server.ts (mt#4023) — expected WebAuthn origin; defaults to `https://<rpID>`. Override only when the scheme or port differs from that default.
  MINSKY_FORCE_BYPASS: "operator-override", // .claude/hooks/block-subagent-bypass-merge.ts (mt#1869) — override for bypass-merge block
  MINSKY_SKIP_TIME_INJECTION: "operator-override", // .claude/hooks/inject-current-time.ts (mt#2181) — skip current-time injection
  MINSKY_SKIP_TRANSCRIPT_INGEST_HOOK: "operator-override", // .claude/hooks/transcript-ingest-on-session-end.ts (mt#2192) — skip session-end transcript ingest
  MINSKY_TRANSCRIPT_INGEST_HOOK_EMBED: "tunable", // .claude/hooks/transcript-ingest-on-session-end.ts (mt#2192) — opt in to synchronous embedding step at session end
  MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS: "tunable", // src/cockpit/server.ts (mt#2321) — cockpit transcript sweep-backstop cadence override (positive integer ms)
  MINSKY_TRANSCRIPT_BACKFILL_INTERVAL_MS: "tunable", // src/cockpit/transcript-backfill-sweep.ts (mt#4601) — embedding-backfill cadence override (positive integer ms); its own knob because the backfill got its own sweep, and a ~45s job wants a different cadence from a ~12min ingest
  MINSKY_SKIP_GIT_STATE_INJECTION: "operator-override", // .claude/hooks/inject-git-state.ts (mt#2275) — skip git-state injection
  MINSKY_SKIP_PROD_STATE_INJECTION: "operator-override", // .claude/hooks/inject-prod-state.ts (mt#2506) — skip prod-state injection
  MINSKY_SKIP_MEMORY_CAPTURE_NOTICE: "operator-override", // .claude/hooks/inject-memory-capture.ts (mt#3997) — skip resident-memory capture notice
  MINSKY_SKIP_DISPATCH_WATCHDOG_INJECTION: "operator-override", // .claude/hooks/inject-dispatch-watchdog.ts (mt#2646) — skip dispatch-watchdog injection
  MINSKY_SKIP_UNMERGED_MIGRATION_CHECK: "operator-override", // packages/domain/src/persistence/postgres-migration-operations.ts (mt#2277) — skip unmerged-migration guard for prod apply
  // mt#2324 — process-only overrides read via the BRACKET form
  // (process.env["MINSKY_*"]) in src/. They surfaced once the
  // no-unregistered-minsky-env-var ESLint rule was extended to catch
  // static-literal computed access (the rule previously skipped all bracket
  // reads). Registering them hook-only so a value set on a deployed
  // environment doesn't crash the env-var-to-config dot-path parser at boot.
  MINSKY_DEV_CHROMIUM_USER_DATA_DIR: "tunable", // src/cockpit/dev-chromium.ts (dev Chromium profile dir override)
  MINSKY_DEV_CHROMIUM_EXECUTABLE: "tunable", // src/cockpit/dev-chromium.ts (dev Chromium binary path override)
  MINSKY_REVIEWER_WATCH_OWNER: "tunable", // src/adapters/shared/commands/reviewer-watch.ts (watch-target owner override; mt#2455)
  MINSKY_REVIEWER_WATCH_REPO: "tunable", // src/adapters/shared/commands/reviewer-watch.ts (watch-target repo override; mt#2455)
  MINSKY_REVIEWER_WATCH_BOT_LOGIN: "tunable", // src/adapters/shared/commands/reviewer-watch.ts (reviewer-bot login default)
  MINSKY_REVIEWER_WATCH_THRESHOLD: "tunable", // src/adapters/shared/commands/reviewer-watch.ts (missed-review alert threshold default)
  MINSKY_REVIEWER_WATCH_INTERVAL_MS: "tunable", // src/adapters/shared/commands/reviewer-watch.ts (daemon poll-interval default)
  MINSKY_ACK_CAUSAL_PREMISE: "operator-override", // .claude/hooks/causal-premise-detector.ts (mt#2216) — override for causal-premise warning injection
  MINSKY_ACK_CODE_MECHANISM_ASSERTION: "operator-override", // .claude/hooks/code-mechanism-assertion-detector.ts (mt#2486) — override for code-mechanism-assertion warning injection
  MINSKY_ACK_NEGATIVE_EXISTENCE_CLAIM: "operator-override", // .claude/hooks/negative-existence-claim-detector.ts (mt#3918) — override for the thin-search negative-existence-claim detector
  MINSKY_ACK_CROSS_TURN_HEDGE: "operator-override", // .claude/hooks/cross-turn-hedge-detector.ts (mt#4701) — override for the hedge-decay detector (a claim hedged in one turn, asserted in a later one)
  MINSKY_SKIP_SPEC_CRITERION_CLAIM: "operator-override", // .claude/hooks/spec-criterion-claim-detector.ts (mt#4153) — override for the spec-criterion unverified-assertion / invented-precondition detector
  MINSKY_SKIP_SECRET_REQUEST_IN_CHAT: "operator-override", // .claude/hooks/secret-request-in-chat-detector.ts (mt#2428) — override for the secret-request-in-chat detector
  MINSKY_ACK_ASK_ROUTING_DEFERRAL: "operator-override", // .claude/hooks/ask-routing-deferral-detector.ts (mt#2471) — override for chat-deferral warning injection
  MINSKY_SKIP_SPEC_READ_CHECK: "operator-override", // .claude/hooks/check-task-spec-read.ts (mt#2515) — override for the unread-task-spec bind/advance guard
  // The two evidence-record provenance guards (mem#966's family). Both were
  // documented as overrides before being registered here; measured behaviour of
  // the gap is a spurious `Unrecognized top-level config key: skip` warning on
  // every CLI invocation while the var is set — the auto-mapping fallback routes
  // `MINSKY_SKIP_*` to a top-level `skip` key. Not a crash, but it makes the
  // documented escape hatch noisy enough to look broken.
  MINSKY_SKIP_SEARCH_PROVENANCE: "operator-override", // .claude/hooks/duplicate-check-search-provenance.ts (mt#4004) — duplicate-check record claiming a search that never ran
  MINSKY_SKIP_CANDIDATE_READ_PROVENANCE: "operator-override", // .claude/hooks/duplicate-check-candidate-read.ts (mt#4167) — duplicate-check record distinguishing candidates whose specs were never opened
  MINSKY_SKIP_CLAIM_PROVENANCE: "operator-override", // .claude/hooks/claim-provenance-scan.ts (mt#4168) — a file-collision or negative-ownership claim written with no discharging call
  MINSKY_SKIP_CRITERION_RECONCILIATION: "operator-override", // .claude/hooks/criterion-reconciliation-scan.ts (mt#4213) — a spec explains a criterion is unmet while leaving that criterion untouched
  MINSKY_SKIP_ENUMERATION_SCOPE: "operator-override", // .claude/hooks/enumeration-scope-check.ts (mt#4171) — a PR changing a serialized contract whose gate-(h) consumer sweep never reached docs/
  MINSKY_SKIP_SPEC_SCOPE_EXECUTION: "operator-override", // .claude/hooks/spec-scope-execution-check.ts (mt#4544) — a PR whose bound spec enumerates in-scope paths the session never edited
  MINSKY_SKIP_EVIDENCE_PROVENANCE: "operator-override", // .claude/hooks/evidence-record-provenance.ts (mt#4044) — Negative control / Execution evidence record claiming a run that never happened
  MINSKY_SKIP_GATE_WALK_PROVENANCE: "operator-override", // .claude/hooks/gate-walk-provenance.ts (mt#1880) — merge-seam record of whether the bound task was ever gated (a task.status_changed → READY row)
  MINSKY_ACK_TASK_HIJACK: "operator-override", // packages/domain/src/session/task-correspondence.ts (mt#2514) — override for the pre-merge PR-task-correspondence (cross-bind) guard
  // mt#2414 — project identity resolver override. Read by
  // packages/domain/src/project/identity.ts at identity-resolution time (not
  // via the config-schema path). Placing it here so the env-var-to-config
  // dot-path parser skips it at boot — the auto-conversion would produce
  // "minsky.project" which is rejected as an unrecognised key.
  MINSKY_PROJECT: "tunable", // packages/domain/src/project/identity.ts (project identity override)
  // mt#2452 — reviewer-service env vars consumed by services/reviewer/src/config.ts
  // via direct process.env reads (NOT via the domain config loader). Without
  // registration here, the auto-mapping fallback maps them to reviewer.* paths
  // (e.g. MINSKY_REVIEWER_APP_ID → reviewer.app.id) that the strict
  // reviewerConfigSchema (z.strictObject — only webhookSecret and url) rejects,
  // crashing the domain container boot with "Unrecognized keys: app, tier2,
  // private, installation" when services/reviewer runs bootDomainContainer().
  //
  // NOTE: MINSKY_REVIEWER_WEBHOOK_SECRET and MINSKY_REVIEWER_URL are NOT here —
  // they have explicit entries in environmentMappings (reviewer.webhookSecret and
  // reviewer.url respectively) so the auto-mapping skip fires on the
  // `envVar in environmentMappings` check before reaching this set.
  //
  // Enumeration of all MINSKY_REVIEWER_* vars set on the Railway reviewer service
  // (per infra/index.ts defineVariables("reviewer", ...)):
  MINSKY_REVIEWER_APP_ID: "tunable", // services/reviewer/src/config.ts (GitHub App ID for reviewer identity)
  MINSKY_REVIEWER_INSTALLATION_ID: "tunable", // services/reviewer/src/config.ts (GitHub App installation ID)
  MINSKY_REVIEWER_PRIVATE_KEY: "tunable", // services/reviewer/src/config.ts (GitHub App private key — PEM)
  MINSKY_REVIEWER_TIER2_ENABLED: "tunable", // services/reviewer/src/config.ts + tier-routing.ts (tier-2 feature flag)
  // mt#2076 — cockpit reviewer-bot-status widget: URL override for the reviewer
  // /health endpoint probe. Read by src/cockpit/widgets/reviewer-bot-status.ts
  // at module-load time. Not a config-schema field; registering here so the
  // env-var-to-config dot-path parser skips it at boot.
  MINSKY_REVIEWER_HEALTH_URL: "tunable", // src/cockpit/widgets/reviewer-bot-status.ts (health probe URL override)
  MINSKY_SKIP_CALIBRATION_CADENCE: "operator-override", // .claude/hooks/calibration-review-cadence-detector.ts (mt#2619) — skip calibration-review-due warning injection
  MINSKY_SKIP_MERGE_GRANT_CHECK: "operator-override", // .claude/hooks/block-subagent-merge-without-grant.ts (mt#2651) — override for the ADR-028 D5 subagent merge-capability-grant guard
  MINSKY_HOOK_OVERRIDE: "operator-override", // .claude/hooks/dispatcher.ts (mt#2650) — ADR-028 D3 unified guard-dispatcher override (comma-separated guard names, or "all")
  MINSKY_SKIP_SIZE_BUDGET: "operator-override", // src/hooks/pre-commit.ts (mt#2802) — override for the rules-compile monolithic-target size-budget check (claude.md, agents.md); also covers the mt#2874 per-rule 15K ceiling extension (one audited escape hatch, not two)
  MINSKY_SKIP_SILENT_STRETCH: "operator-override", // .claude/hooks/silent-stretch-detector.ts (mt#2824) — override for the silent tool-only-stretch heartbeat detector
  MINSKY_SKIP_WALL_OF_TEXT: "operator-override", // .claude/hooks/wall-of-text-detector.ts (mt#2870) — override for the turn-report wall-of-text shape detector
  MINSKY_SKIP_TERMINAL_LINKIFY: "operator-override", // .claude/hooks/linkify-message-display.ts (mt#2565) — display every streaming delta unchanged instead of linkifying entity refs
  MINSKY_SILENT_STRETCH_GAP_MINUTES: "tunable", // .claude/hooks/silent-stretch-detector.ts (mt#3518) — preference-class threshold: heartbeat gap minutes (default 10)
  MINSKY_SKIP_CONTEXT_FILL_GAUGE: "operator-override", // .claude/hooks/context-fill-gauge.ts (mt#4291) — override for the context-fill gauge
  MINSKY_CONTEXT_FILL_WARN_RATIO_PCT: "tunable", // .claude/hooks/context-fill-gauge.ts (mt#4291) — preference-class threshold: warn tier as % of context window (default 80)
  MINSKY_CONTEXT_FILL_CRITICAL_RATIO_PCT: "tunable", // .claude/hooks/context-fill-gauge.ts (mt#4291) — preference-class threshold: critical tier as % of context window (default 95)
  MINSKY_SILENT_STRETCH_TOOL_CALLS: "tunable", // .claude/hooks/silent-stretch-detector.ts (mt#3518) — preference-class threshold: heartbeat call count (default 15)
  MINSKY_WALL_OF_TEXT_WORD_BUDGET: "tunable", // .claude/hooks/wall-of-text-detector.ts (mt#3518) — preference-class threshold: turn-report lead word budget (default 200)
  MINSKY_SKIP_OPERATOR_INSTRUCTION_TRIGGER: "operator-override", // .claude/hooks/substrate-bypass-detector.ts (mt#2303) — skip the log-only operator-instruction-as-feature-delivery calibration surface
  MINSKY_SKIP_OPERATOR_DEFERRAL: "operator-override", // .claude/hooks/operator-deferral-detector.ts (mt#2459) — skip BOTH log-only operator-deferral surfaces (capability-deferral prose + AskUserQuestion option labels)
  MINSKY_SKIP_SIZE_JUSTIFICATION: "operator-override", // .claude/hooks/require-growth-justification-before-merge.ts (mt#2874) — override for the growth-justification merge gate (rules-touching PR that grows CLAUDE.md beyond the threshold without a Size-budget justification: marker)
  MINSKY_ACK_BUILD_CLAIM_INJECTION: "operator-override", // .claude/hooks/build-claim-injection-detector.ts (mt#2923) — override for the build/deploy-claim-seam warning injection
  MINSKY_SKIP_USABILITY_CLAIM_CHECK: "operator-override", // .claude/hooks/require-deploy-verification-before-merge.ts (mt#2545 Gap A) — override for the build-surface altitude-4 usability-claim merge gate
  MINSKY_SKIP_AT_COVERAGE: "operator-override", // .claude/hooks/require-execution-evidence-before-merge.ts (mt#3033) — override for the calibration-first acceptance-test cross-reference check (log-only; skips both detection and calibration-log write)
  MINSKY_SKIP_SC_COVERAGE: "operator-override", // .claude/hooks/success-criteria-coverage.ts (mt#3350) — override for the calibration-first `## Success Criteria` cross-reference check (log-only; sibling of MINSKY_SKIP_AT_COVERAGE, deliberately separate so one surface can be silenced without the other)
  MINSKY_SKIP_TEST_FIRST_EVIDENCE: "operator-override", // .claude/hooks/test-first-evidence.ts (mt#3244) — override for the calibration-first test-first check (log-only): a bugfix-shaped PR modifying an existing test file must record a negative control, i.e. the test observed FAILING against the un-fixed tree. Third sibling of the two above, separate for the same reason.
  MINSKY_SKIP_RENDER_PATH_EVIDENCE: "operator-override", // .claude/hooks/render-path-evidence.ts (mt#2421) — override for the calibration-first render-path check (log-only): a PR touching a user-facing render path should carry a URL or image the principal can open. Fourth sibling, separate for the same reason. Trigger is deliberately test-INDEPENDENT (mt#3810 shipped blind WITH passing happy-dom tests).
  MINSKY_ACK_DESTRUCTIVE: "operator-override", // packages/domain/src/safety/destructive-override.ts (mt#3021) — non-interactive escape hatch for the shared destructive-action override contract (mass-deletion sanity gate, session-delete/cleanup git-state guard); value IS the required reason string, so it can't degrade into a bare-boolean override.
  MINSKY_ACK_KNOWLEDGE_ACQUISITION: "operator-override", // .claude/hooks/knowledge-acquisition-detector.ts (mt#2708) — override for the knowledge-acquisition (research-relevant-to-loaded-skill, no propagation) calibration surface
  MINSKY_ACK_CONSTRUCTED_IDENTIFIER_BATCH: "operator-override", // .claude/hooks/constructed-identifier-batch-detector.ts (mt#3125) — override for the batched id-minting + id-consuming tool-call detector
  MINSKY_ACK_UNTAKEN_ACTION: "operator-override", // .claude/hooks/turn-end-untaken-action-scan.ts (mt#3179) — override for the turn-end announced-but-untaken-action Stop guard
  MINSKY_SKIP_UNTAKEN_ACTION_EVALUATION: "operator-override", // .claude/hooks/turn-end-untaken-action-scan.ts (mt#4117) — override for the per-scan evaluation stream ONLY; distinct from MINSKY_ACK_UNTAKEN_ACTION above, which acks the whole guard and changes fire behavior — this one silences just the fired/not-fired/suppressed evaluation write
  MINSKY_ACK_UNWALKED_TASK: "operator-override", // .claude/hooks/turn-end-unwalked-task-scan.ts (mt#3536) — override for the turn-end filed-but-unwalked-task Stop guard
  MINSKY_ACK_UNESCALATED_INCIDENT: "operator-override", // .claude/hooks/turn-end-unescalated-incident-scan.ts (mt#3593) — override for the turn-end operator-only-incident-without-severity-ask Stop guard
  MINSKY_SKIP_UNOWNED_FINDING_SCAN: "operator-override", // .claude/hooks/unowned-finding-scan.ts (mt#4246) — override for the log-only findings-section owner scan at the DONE transition
  MINSKY_SKIP_STOP_AT_DECISION: "operator-override", // .claude/hooks/stop-at-decision-scan.ts (mt#3653) — override for the log-only turn-end stop-at-ripe-decision Stop scan
  MINSKY_ACK_BARE_PROHIBITION: "operator-override", // .claude/hooks/warn-bare-prohibition-dispatch.ts (mt#3162) — override for the bare-prohibition dispatch-prompt detector
  MINSKY_ACK_BARE_ENTITY_REF: "operator-override", // .claude/hooks/turn-end-bare-ref-scan.ts (mt#3286) — override for the turn-end bare/malformed entity-deeplink Stop guard
  // mt#4217 — sixteen vars the mt#1788 ESLint rule could not see for as long as
  // it existed. They are read as a bare `env.MINSKY_FOO` member access on a
  // dependency-injected env object rather than `process.env.MINSKY_FOO`, and the
  // rule matched only the latter; nine of them sit in `src/mcp/**`, a tree it was
  // already scanning. Every one is `tunable` — a runtime threshold, a path, or an
  // arming switch.
  //
  // The five DISABLE_/FORCE_ switches are deliberately NOT `operator-override`
  // even though they suppress a mechanism's decision: that category is scoped to
  // a var a hook GUARD consults as its own override, because that is the
  // population the fire log's `authorized_exception` classification is about and
  // `.minsky/hooks/known-override-env-vars.ts` must equal (mt#3882). These gate
  // runtime exit watchers, which write no fire-log record, so mirroring them
  // would add names their consumer can never see.
  //
  // mt#4099 (ceiling reads the wrong quantity) and mt#4211 (its polling cost)
  // own the mechanism these configure; if either renames or retires a var, its
  // entry here follows.
  MINSKY_MCP_MEMORY_CEILING_MB: "tunable", // src/mcp/orphan-exit.ts (mt#3886) — resident-memory ceiling, in MB
  MINSKY_MCP_MEMORY_CEILING_POLL_MS: "tunable", // src/mcp/orphan-exit.ts + stdio-proxy/child-memory-ceiling.ts — ceiling poll interval
  MINSKY_MCP_FORCE_MEMORY_CEILING_EXIT: "tunable", // src/mcp/orphan-exit.ts — arm the ceiling even on the hosted entrypoint
  MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT: "tunable", // src/mcp/orphan-exit.ts + stdio-proxy/child-memory-ceiling.ts — never arm the ceiling
  MINSKY_MCP_PARENT_DEATH_POLL_MS: "tunable", // src/mcp/orphan-exit.ts (mt#3764) — parent-death watcher poll interval
  MINSKY_MCP_DISABLE_PARENT_DEATH_EXIT: "tunable", // src/mcp/orphan-exit.ts — skip wiring the parent-death watcher
  MINSKY_MCP_NEVER_CONNECTED_TIMEOUT_MS: "tunable", // src/mcp/orphan-exit.ts — never-connected exit deadline
  MINSKY_MCP_FORCE_NEVER_CONNECTED_EXIT: "tunable", // src/mcp/orphan-exit.ts — arm regardless of the hosted signature
  MINSKY_MCP_DISABLE_NEVER_CONNECTED_EXIT: "tunable", // src/mcp/orphan-exit.ts — never arm the never-connected exit
  MINSKY_MCP_MEMORY_CAPTURE_MB: "tunable", // src/mcp/memory-capture.ts (mt#3973) — resident threshold that triggers a capture
  MINSKY_MCP_MEMORY_CAPTURE_POLL_MS: "tunable", // src/mcp/memory-capture.ts — capture poll interval
  MINSKY_MCP_DISABLE_MEMORY_CAPTURE: "tunable", // src/mcp/memory-capture.ts — disable resident-memory capture entirely
  MINSKY_MCP_CAPTURE_HEAP_SNAPSHOT: "tunable", // src/mcp/memory-capture.ts — also write a heap snapshot with the capture
  MINSKY_LOCAL_MCP_TOKEN_PATH: "tunable", // src/mcp/daemon/local-daemon.ts + src/mcp/shim/main.ts (ADR-038) — local-daemon token file path
  MINSKY_SHIM_DAEMON_URL: "tunable", // src/mcp/shim/main.ts (ADR-038) — daemon URL the per-conversation shim dials
  MINSKY_HOOK_SOURCE_DIR: "tunable", // packages/domain/src/setup/hook-provisioning.ts — hook-source dir override for provisioning

  // ---------------------------------------------------------------------
  // scripts/ tree (mt#4223). The rule's scan path gained `scripts/` in the
  // same change; these are the 18 reads it then reported.
  //
  // All 18 are `tunable`. None is `operator-override`: that category is
  // scoped above to the population the fire log's `authorized_exception`
  // classification is about, which `.minsky/hooks/known-override-env-vars.ts`
  // must EQUAL — and a dev/CI script writes no fire-log record, so adding one
  // here would put a name in the mirror its consumer can never see. Same
  // reasoning as the memory-ceiling block above.
  //
  // Consequence is NOT uniform across them, and the split is worth keeping in
  // view when one of these is retired or renamed. It turns on whether the
  // derived top-level segment is DECLARED in `configurationSchema`:
  //   - undeclared (`cdp`, `latency`, `peek`, `probe`, `screenshot`, `smoke`,
  //     `transcript`, `transcripts`, `ask`, `claude`, `conversation`, `film`,
  //     `require`, `skip`, `postgres`) — the loader warns `Unrecognized
  //     top-level config key` and ignores it, so registering is behavior-
  //     neutral and simply silences a warning nobody was reading.
  //   - DECLARED — the value reaches a live config path. Exactly one of these
  //     18 is in that case; see MINSKY_GITHUB_TOKEN below.
  // ---------------------------------------------------------------------
  MINSKY_ASK_ID: "tunable", // scripts/verify-terminal-ask-render.ts — ask to render in the probe
  MINSKY_CDP_URL: "tunable", // scripts/verify-*.ts (14 render probes) — Chrome DevTools endpoint the probe drives
  MINSKY_CLAUDE_PROJECTS_DIR: "tunable", // scripts/measure-transcript-discovery-cost.ts + verify-postgres-text-safety.ts — harness transcript root
  MINSKY_CONVERSATION_ID: "tunable", // scripts/verify-conversation-{orientation,turn-target,weight}.ts — conversation under test
  MINSKY_EXPAND_BURSTS: "tunable", // scripts/verify-conversation-weight.ts (mt#4250) — click every action-burst fold open before measuring, so a collapsed/expanded pair proves folding hides rows rather than dropping them
  MINSKY_DRAG_RATES: "tunable", // scripts/measure-peek-drag-frames.ts — comma-separated input rates in Hz the drag is measured at (default 30,60,120)
  MINSKY_FILM_CONVERSATION_ID: "tunable", // scripts/verify-session-film-camera.ts — conversation for the session-film probe
  MINSKY_TRACKING_RUNS: "tunable", // scripts/measure-peek-drag-tracking.ts — repetitions per drag mode (default 30)
  MINSKY_LATENCY_OUT: "tunable", // scripts/verify-cockpit-navigation-latency.ts — results file path
  MINSKY_LATENCY_RUNS: "tunable", // scripts/verify-cockpit-navigation-latency.ts — iteration count
  MINSKY_PEEK_TASK_ID: "tunable", // scripts/verify-peek-pane-layout.ts — task rendered in the peek pane
  MINSKY_PROTECTION_PREVIEW_DEGRADED: "tunable", // scripts/preview-protection-surface.ts — force one broken check so the degraded render is previewable (default off)
  MINSKY_PROTECTION_PREVIEW_PORT: "tunable", // scripts/preview-protection-surface.ts — port the no-database design preview serves on (default 4310)
  MINSKY_PROTECTION_SHOT: "tunable", // scripts/verify-protection-surface.ts — screenshot output path (default /tmp/mt4287-protection.png)
  MINSKY_PROBE_TASK_ID: "tunable", // scripts/verify-similarity-terminal-visibility.ts — task the probe queries
  MINSKY_REQUIRE_DERIVED_LINK_PROBE: "tunable", // scripts/verify-derived-conversation-link.ts — fail instead of skipping when preconditions are absent
  MINSKY_REQUIRE_PRESENCE_DERIVATION_PROBE: "tunable", // scripts/verify-presence-conversation-derivation.ts — same, for the presence probe
  MINSKY_SCREENSHOT_PATH: "tunable", // scripts/verify-{interceptors-axes,terminal-ask}-render.ts and verify-conversation-weight.ts (mt#4250) — where the probe writes its PNG
  MINSKY_TRANSCRIPTS_DIR: "tunable", // scripts/measure-*.ts + replay-*.ts (5 files) — transcript corpus root
  MINSKY_TRANSCRIPT_CORPUS: "tunable", // scripts/audit-unknown-harness-tags.ts — corpus selector

  // A documented skip for the `npm-pack-install-smoke` CI check. NOT
  // `operator-override` despite the SKIP_ name and the surface similarity to
  // MINSKY_SKIP_BUNDLE_SMOKE (which IS that category): that one is consulted by
  // `.claude/hooks/require-review-before-merge.ts`, a hook GUARD that writes
  // fire-log records and is therefore in the mirrored population. This one is
  // read by a CI script, which is not. Categorizing it `operator-override`
  // would make `known-override-env-vars.test.ts` demand a mirror entry for a
  // consumer that can never appear in the fire log (mt#4223).
  MINSKY_SKIP_PACK_INSTALL_SMOKE: "tunable", // scripts/verify-npm-pack-install.ts — skip the npm-pack-install CI smoke

  // Postgres connection strings for env-gated smoke scripts. `tunable` rather
  // than an `environmentMappings` config path: they select a DISPOSABLE target
  // for one script's live run, and the real config path
  // (`persistence.postgres.connectionString`) already has two explicit mappings
  // (MINSKY_POSTGRES_URL, MINSKY_PERSISTENCE_POSTGRES_URL). Adding a third
  // alias would let a smoke-test target silently become the process-wide
  // persistence target — the opposite of what these scripts want. Both derive
  // undeclared top-level segments (`postgres`, `smoke`) today, so registering
  // them changes no behavior; it stops the derivation from ever reaching a
  // declared namespace if one is added later (mt#4223).
  MINSKY_POSTGRES_CONNECTION_STRING: "tunable", // scripts/smoke-{prod-state-cache,transcript-sweep,transcript-watcher}.ts — DATABASE_URL fallback
  MINSKY_SMOKE_PG_URL: "tunable", // scripts/smoke-setup-db.ts — disposable Postgres target for the setup-db smoke

  // The ONLY one of the 18 whose registration changes behavior, and the reason
  // this sweep is not merely lint hygiene (mt#4223). `github` IS a declared
  // top-level key, so before this entry the generic fallback derived
  // `github.token` and made this var a THIRD, undeclared alias for the GitHub
  // token beside the explicit GITHUB_TOKEN / GH_TOKEN mappings at the top of
  // this file — verified by loading the config with it set. Its only read site
  // uses it as a script-local fallback for a USER token, so feeding the
  // process-wide GitHub client from it was never intended; nobody wrote that
  // alias, the dot-path parser did. Registering it `tunable` skips the
  // derivation and removes the alias. The two documented aliases are unchanged.
  MINSKY_GITHUB_TOKEN: "tunable", // scripts/smoke-reviewer-watch.ts — user-token fallback for the reviewer-watch smoke
};

/**
 * Every registered hook-only var, regardless of category — the set the
 * env-var-to-config dot-path parser skips. Derived, so a var cannot be
 * registered without also being categorized.
 */
export const HOOK_ONLY_ENV_VARS: ReadonlySet<string> = new Set(
  Object.keys(HOOK_ONLY_ENV_VAR_CATEGORIES)
);

/**
 * The operator escape hatches (mt#3882) — the fire log's
 * `authorized_exception` oracle, and the exact set
 * `.minsky/hooks/known-override-env-vars.ts` must equal.
 *
 * The hooks tree is dependency-free by design (`SPEC.md`), so it cannot import
 * this; it carries a literal list instead. `known-override-env-vars.test.ts`
 * asserts the two are equal in BOTH directions, which is what makes the
 * duplication safe: an entry added here without a mirror entry fails, and a
 * mirror entry whose canonical entry was deleted or recategorized fails too.
 * The second direction is not hypothetical — `MINSKY_POLICY_COVERAGE_MODE`
 * outlived its detector (retired by mt#4197) in the mirror for a day, and a
 * superset contract cannot see that.
 */
export const OPERATOR_OVERRIDE_ENV_VARS: ReadonlySet<string> = new Set(
  Object.entries(HOOK_ONLY_ENV_VAR_CATEGORIES)
    .filter(([, category]) => category === "operator-override")
    .map(([name]) => name)
);

/**
 * Type conversion functions for environment variables
 */
const typeConverters = {
  string: (value: string): string => value,
  number: (value: string): number => Number(value),
  boolean: (value: string): boolean => {
    const normalized = value.toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  },
  json: (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      return value; // Fall back to string if JSON parsing fails
    }
  },
  /**
   * Comma-separated list (mt#3230). For array fields whose natural env form is
   * `a,b,c` rather than a JSON array — an operator setting an allowlist in a
   * shell should not have to write `["1","2"]` and get the quoting right.
   * Empty and whitespace-only entries are dropped, so a trailing comma or a
   * blank value yields `[]` rather than `[""]`.
   */
  csv: (value: string): string[] =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
} as const;

/**
 * Field type mappings for automatic conversion
 */
const fieldTypes: Record<string, keyof typeof typeConverters> = {
  // Numbers
  "github.serviceAccount.appId": "number",
  "github.serviceAccount.installationId": "number",
  "persistence.postgres.connectTimeout": "number",
  "logger.maxFileSize": "number",
  "logger.maxFiles": "number",
  "ai.providers.openai.maxTokens": "number",
  "ai.providers.anthropic.maxTokens": "number",
  "ai.providers.google.maxTokens": "number",
  "ai.providers.cohere.maxTokens": "number",
  "ai.providers.mistral.maxTokens": "number",
  "ai.providers.openai.temperature": "number",
  "ai.providers.anthropic.temperature": "number",
  "ai.providers.google.temperature": "number",
  "ai.providers.cohere.temperature": "number",
  "ai.providers.mistral.temperature": "number",

  // Booleans
  "logger.enableAgentLogs": "boolean",
  "logger.includeTimestamp": "boolean",
  "logger.includeLevel": "boolean",
  "logger.includeSource": "boolean",
  "ai.providers.openai.enabled": "boolean",
  "ai.providers.anthropic.enabled": "boolean",
  "ai.providers.google.enabled": "boolean",
  "ai.providers.cohere.enabled": "boolean",
  "ai.providers.mistral.enabled": "boolean",
  "principalChannel.enabled": "boolean",

  // Comma-separated lists (mt#3230)
  "principalChannel.allowedUserIds": "csv",
  // Comma-separated list (mt#3641)
  "cockpit.allowedHosts": "csv",
  // Comma-separated list (mt#4239). Same necessary-but-not-sufficient split the
  // `cockpit.port` comment below describes: without this entry the env layer
  // hands the schema a raw STRING and `z.array(z.string())` rejects it.
  "cockpit.drivenSession.mcpServers": "csv",
  // mt#3988: without this entry the env layer hands the schema the raw STRING
  // and `cockpit.port`'s `z.number()` rejects it, so setting
  // MINSKY_COCKPIT_PORT crashes config resolution instead of overriding the
  // port. Registering the var in `environmentMappings` above is necessary but
  // NOT sufficient — the conversion is declared here, separately.
  "cockpit.port": "number",

  // JSON (arrays and objects)
  "ai.providers.openai.models": "json",
  "ai.providers.anthropic.models": "json",
  "ai.providers.google.models": "json",
  "ai.providers.cohere.models": "json",
  "ai.providers.mistral.models": "json",
  "ai.providers.openai.headers": "json",
  "ai.providers.anthropic.headers": "json",
  "ai.providers.google.headers": "json",
  "ai.providers.cohere.headers": "json",
  "ai.providers.mistral.headers": "json",
} as const;

/**
 * Load configuration from environment variables
 */
export function loadEnvironmentConfiguration(): PartialConfiguration {
  const config: Record<string, unknown> = {};

  // Process explicit mappings
  for (const [envVar, configPath] of Object.entries(environmentMappings)) {
    const value = process.env[envVar];
    if (value !== undefined && value !== "") {
      setConfigValue(config, configPath, value);
    }
  }

  // Process MINSKY_ prefixed variables (automatic mapping)
  for (const [envVar, value] of Object.entries(process.env)) {
    if (envVar.startsWith("MINSKY_") && value !== undefined && value !== "") {
      // Skip if already handled by explicit mapping
      if (envVar in environmentMappings) continue;

      // Skip hook-only env vars — see HOOK_ONLY_ENV_VARS docstring (mt#1644).
      if (HOOK_ONLY_ENV_VARS.has(envVar)) continue;

      // Convert MINSKY_PREFIX to config path
      const configPath = envVarToConfigPath(envVar);
      if (configPath) {
        setConfigValue(config, configPath, value);
      }
    }
  }

  return config;
}

/**
 * Convert environment variable name to configuration path
 */
function envVarToConfigPath(envVar: string): string | null {
  // Remove MINSKY_ prefix
  const withoutPrefix = envVar.replace(/^MINSKY_/, "");

  // Convert SCREAMING_SNAKE_CASE to dot.notation.path
  const parts = withoutPrefix.toLowerCase().split("_");

  // Handle known patterns
  if (parts[0] === "ai" && parts[1] === "providers" && parts.length >= 3) {
    // AI_PROVIDERS_OPENAI_API_KEY -> ai.providers.openai.apiKey
    const provider = elementAt(parts, 2, "env var AI provider part");
    const field = parts.slice(3).join("_");
    return `ai.providers.${provider}.${camelCase(field)}`;
  }

  if (parts[0] === "persistence") {
    // PERSISTENCE_BACKEND -> persistence.backend
    // PERSISTENCE_POSTGRES_CONNECTIONSTRING -> persistence.postgres.connectionString
    if (parts.length === 2) {
      return `persistence.${camelCase(elementAt(parts, 1, "persistence field"))}`;
    } else if (parts.length >= 3) {
      const tail = parts.slice(2).join("_");
      return `persistence.${parts[1]}.${camelCase(tail)}`;
    }
  }

  if (parts[0] === "workspace") {
    // WORKSPACE_MAIN_PATH -> workspace.mainPath
    if (parts[1] === "main" && parts[2] === "path") {
      return "workspace.mainPath";
    }
  }

  if (parts[0] === "logger" || parts[0] === "log") {
    // LOGGER_MODE -> logger.mode
    // LOG_LEVEL -> logger.level
    const field = parts.slice(1).join("_");
    return `logger.${camelCase(field)}`;
  }

  // Default: convert to camelCase path
  return parts.map(camelCase).join(".");
}

/**
 * Convert snake_case to camelCase
 */
function camelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Set a nested configuration value using dot notation path
 */
function setConfigValue(config: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = config;

  // Navigate to the parent object
  for (let i = 0; i < parts.length - 1; i++) {
    const part = elementAt(parts, i, "environment setConfigValue parts");
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  // Set the final value with type conversion
  const finalKey = elementAt(parts, parts.length - 1, "environment setConfigValue finalKey");
  const fieldType = fieldTypes[path] || "string";
  const convertedValue = typeConverters[fieldType](value);

  current[finalKey] = convertedValue;
}

/**
 * Get environment configuration with metadata
 */
export function getEnvironmentConfiguration(): {
  config: PartialConfiguration;
  metadata: {
    loadedVariables: string[];
    mappings: Record<string, string>;
  };
} {
  const loadedVariables: string[] = [];
  const mappings: Record<string, string> = {};

  // Track which environment variables were loaded
  for (const [envVar, configPath] of Object.entries(environmentMappings)) {
    if (process.env[envVar] !== undefined && process.env[envVar] !== "") {
      loadedVariables.push(envVar);
      mappings[envVar] = configPath;
    }
  }

  // Track MINSKY_ prefixed variables
  for (const envVar of Object.keys(process.env)) {
    if (envVar.startsWith("MINSKY_") && !(envVar in environmentMappings)) {
      // Skip hook-only env vars — see HOOK_ONLY_ENV_VARS docstring (mt#1644).
      // Stays in sync with loadEnvironmentConfiguration so metadata reporting
      // does not diverge from actual load behavior.
      //
      // Exception (mt#2414): MINSKY_PROJECT is hook-only (no dot-path mapping)
      // but IS surfaced in loadedVariables for observability — operators need an
      // audit trail for why a project resolved as it did. It deliberately has NO
      // entry in `mappings` (it is not a config dot-path value).
      if (HOOK_ONLY_ENV_VARS.has(envVar)) {
        if (
          envVar === "MINSKY_PROJECT" &&
          process.env[envVar] !== undefined &&
          process.env[envVar] !== ""
        ) {
          loadedVariables.push(envVar);
        }
        continue;
      }

      const configPath = envVarToConfigPath(envVar);
      if (configPath && process.env[envVar] !== undefined && process.env[envVar] !== "") {
        loadedVariables.push(envVar);
        mappings[envVar] = configPath;
      }
    }
  }

  return {
    config: loadEnvironmentConfiguration(),
    metadata: {
      loadedVariables,
      mappings,
    },
  };
}

/**
 * Configuration source metadata
 */
export const environmentSourceMetadata = {
  name: "environment",
  description: "Environment variables configuration",
  priority: 100, // Highest priority
  required: false,
} as const;
