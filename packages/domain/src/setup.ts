/**
 * Setup domain function.
 *
 * Performs developer-local initialization: reads the existing project config
 * and derives local configuration (MCP registration + local config file).
 * Unlike `init`, this works with an already-initialized project and does
 * not require full config system initialization.
 */

import * as path from "path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { FsLike } from "./interfaces/fs-like";
import { createRealFs } from "./interfaces/real-fs";
import { createFileIfNotExists } from "./init/file-system";
import { registerWithClient, getRegistrar } from "./mcp/registration";
import {
  resolveExistingPostgresConnection,
  type ResolveExistingConnectionDeps,
  type ResolveExistingConnectionResult,
} from "./setup-db";
import { provisionProjectRow, type ProvisionProjectRowDeps } from "./project/provision";
import { log } from "@minsky/shared/logger";

export interface SetupOptions {
  repoPath: string;
  client?: string;
  overwrite?: boolean;
  /**
   * MCP transport settings for this machine (mt#4699).
   *
   * `init` passes these directly instead of writing them into the committed
   * `.minsky/config.yaml` for this function to read back out. When present they
   * win over anything found in the project config; when absent the project
   * config is still consulted, so a project initialized before mt#4699 — whose
   * `config.yaml` still carries an `mcp` section — behaves exactly as it did.
   */
  mcp?: MinimalMcpConfig;
}

/**
 * What the daemon-ensuring step did (mt#4707).
 *
 * A RESULT rather than a thrown error, deliberately. `ensureDaemonRunning`
 * throws on `foreign`/`not-ready`, and each of its messages ends "Nothing has
 * been written." — true for `setup local-http`, which calls it before its only
 * write, and FALSE here, because `setup`/`init` go on to write the client
 * config regardless. Letting that throw cross this seam would emit a
 * factually wrong sentence to the operator, which is the defect mt#4337 fixed
 * one caller over. The adapter translates it instead; see
 * `src/mcp/setup/ensure-local-daemon-for-setup.ts`.
 */
export type LocalDaemonEnsureOutcome =
  /**
   * `url` is supplied by the adapter rather than rebuilt here (PR #3658 R3).
   * `packages/domain` cannot import `localDaemonMcpUrl`, so the alternative was
   * a fifth hand-maintained copy of `http://127.0.0.1:48765` — in a task whose
   * own spec flags that literal's four existing copies as a divergence risk.
   * Carrying it on the outcome means the layer that already knows the endpoint
   * is the one that names it.
   */
  | { kind: "already-running"; url: string }
  | { kind: "started"; url: string }
  | { kind: "unavailable"; reason: string };

/**
 * Collaborators `performSetup` cannot construct itself (mt#4707).
 *
 * `ensureLocalDaemon` lives in `src/mcp/setup/`, which `packages/domain` may
 * not import — the same constraint that made `compileForHarness` an injected
 * seam in `./init.ts` and forced `DEFAULT_LOCAL_DAEMON_MCP_URL` to be
 * duplicated in `./mcp/registration.ts`. Injected rather than duplicated
 * because a second spawn implementation is exactly what ADR-014's
 * one-owner-per-port rule makes dangerous.
 */
export interface PerformSetupDeps {
  ensureLocalDaemon?: (repoPath: string) => Promise<LocalDaemonEnsureOutcome>;
}

export interface SetupResult {
  success: boolean;
  localConfigPath: string;
  harnessConfigPath: string;
  client: string;
  message: string;
  /**
   * Outcome of the daemon-ensuring step (mt#4707), or `undefined` when the
   * step did not apply — a non-`claude-code` client, or a caller that injected
   * no implementation.
   */
  localDaemon?: LocalDaemonEnsureOutcome;
  /**
   * Postgres connection-inheritance status, resolved via the config loader
   * (mt#2502): whether an already-configured connection was found (project/user
   * config or env), where it came from, and whether it is currently reachable.
   * CLI callers use this to decide whether to fall back to the interactive
   * `setup db` wizard.
   */
  dbConnection: ResolveExistingConnectionResult;
}

interface MinimalMcpConfig {
  transport?: string;
  port?: number;
  host?: string;
}

interface MinimalProjectConfig {
  mcp?: MinimalMcpConfig;
}

/**
 * Perform developer-local setup for a Minsky project.
 *
 * Steps:
 * 1. Check .minsky/config.yaml exists — error if not
 * 2. Read and parse it (use yaml.parse)
 * 3. Extract mcp section (default to { transport: "stdio" } if missing)
 * 4. Call registerWithClient() to write the harness config file
 * 5. Write .minsky/config.local.yaml with workspace.mainPath and workspace.harness
 * 6. Resolve an already-configured Postgres connection via the config loader
 *    (mt#2502) — reports source + connectivity so a second project on the
 *    unified instance can inherit it instead of re-prompting. This step is a
 *    pure resolve-and-verify — it never writes config or prompts; the CLI
 *    caller decides whether to fall back to the interactive `setup db` wizard
 *    when nothing resolves or the resolved connection isn't reachable.
 * 6b. If that connection is found AND verified live, ensure this project's
 *    `projects` row exists (mt#2934) — one of the two confirmed-connection
 *    provisioning points decided in the mt#2934 spec (the other is the
 *    `setup db` wizard's fresh-connection success path, `setup-db.ts`). A
 *    failed or skipped provisioning attempt does not fail `setup` overall.
 * 7. Return result describing what was written
 */
export async function performSetup(
  options: SetupOptions,
  fileSystem: FsLike = createRealFs(),
  dbDeps: ResolveExistingConnectionDeps = {},
  provisionDeps: ProvisionProjectRowDeps = {},
  setupDeps: PerformSetupDeps = {}
): Promise<SetupResult> {
  const { repoPath, client = "cursor", overwrite = true } = options;

  // 1. Check .minsky/config.yaml exists — error if not
  const configPath = path.join(repoPath, ".minsky", "config.yaml");
  const configExists = await fileSystem.exists(configPath);
  if (!configExists) {
    throw new Error(
      `No .minsky/config.yaml found at ${configPath}. Run 'minsky init' first to initialize this project.`
    );
  }

  // 2. Read and parse config.yaml
  const configContent = await fileSystem.readFile(configPath, "utf-8");
  const projectConfig = yamlParse(configContent) as MinimalProjectConfig;

  // 3. Resolve the mcp section. Precedence (mt#4699): explicitly-passed options
  // (how `init` supplies them now) > the project config's own `mcp` section
  // (back-compat for projects initialized before mt#4699, which still carry it)
  // > the stdio default. ADR-038 is why the default is stdio and not http: the
  // shared local daemon is reached over HTTP by the SHIM, while the client
  // itself stays an ordinary `type: "stdio"` entry, because the HTTP transport
  // carries no conversation identity.
  const mcpConfig: MinimalMcpConfig = options.mcp ?? projectConfig?.mcp ?? { transport: "stdio" };
  const transport = mcpConfig.transport ?? "stdio";

  // 3b. Ensure the shared local daemon is running (mt#4707).
  //
  // ORDER IS LOAD-BEARING: this runs BEFORE `registerWithClient` writes
  // anything. `ensureDaemonRunning`'s refusals all end "Nothing has been
  // written." — a sentence that is only true while nothing has been. Running
  // it after the write would make every one of them false, which is the exact
  // defect mt#4337 fixed on the `setup local-http` path.
  //
  // SCOPED TO `claude-code` (SC3): it is the only registrar that emits the
  // shim form (`mcp shim --url <daemon>`), so it is the only one whose written
  // config is inert without a daemon. The other seven spawn their own stdio
  // server and must not gain a daemon dependency as a side effect.
  //
  // The written config is CORRECT either way — this makes it live. So a daemon
  // that cannot be ensured is reported, not fatal; see the `unavailable`
  // branch below.
  // The ACTION happens here; the REPORTING happens after the writes below.
  // Splitting them is the point (PR #3658 R2): both messages describe the
  // config as written, and emitting them here — before `registerWithClient` —
  // stated that in the past tense while it was still false, and would have been
  // flatly wrong had the write then thrown. Same class as the claim this
  // module already strips at the seam, arriving through tense rather than
  // through a forwarded string.
  let localDaemon: LocalDaemonEnsureOutcome | undefined;
  if (client === "claude-code" && setupDeps.ensureLocalDaemon !== undefined) {
    localDaemon = await setupDeps.ensureLocalDaemon(repoPath);
  }

  // 4. Register with the MCP client — writes the harness config file (e.g. .cursor/mcp.json)
  await registerWithClient(
    repoPath,
    { transport, port: mcpConfig.port, host: mcpConfig.host },
    client,
    fileSystem,
    overwrite
  );

  // Determine the harness config path for the result (for reporting)
  const registrar = getRegistrar(client);
  const harnessConfigPath = registrar.configPath(repoPath);

  // 5. Write .minsky/config.local.yaml with workspace.mainPath and workspace.harness
  // Both fields belong under the `workspace` key — placing `harness` at the root
  // would be rejected by the strict config-schema validator (mt#1939).
  // mt#4699: the `mcp` section lives here rather than in the committed
  // config.yaml. It is machine scope — `mcp start` never reads it, and its only
  // consumers are this registration path and `mcp register` — so committing it
  // forced two developers on one repo to share one answer. `config.local.yaml`
  // is the gitignored overlay that layers on top of config.yaml
  // (`configuration/sources/project.ts`), so a reader going through the config
  // loader sees the same resolved value it always did.
  const localConfigPath = path.join(repoPath, ".minsky", "config.local.yaml");
  const localMcpSection: Record<string, unknown> = { transport };
  if (mcpConfig.port !== undefined) {
    localMcpSection.port = mcpConfig.port;
  }
  if (mcpConfig.host !== undefined) {
    localMcpSection.host = mcpConfig.host;
  }
  const localConfigContent = yamlStringify({
    workspace: { mainPath: repoPath, harness: client },
    mcp: localMcpSection,
  });
  await createFileIfNotExists(localConfigPath, localConfigContent, overwrite, fileSystem);

  // 6. Resolve an already-configured Postgres connection (pure resolve + verify; no writes).
  const dbConnection = await resolveExistingPostgresConnection(dbDeps);

  // 6b. Confirmed-connection provisioning point (mt#2934): if a connection was
  // found AND verified live, ensure this project's `projects` row exists.
  // `resolveProjectScope`'s fail-open ALL_PROJECTS default otherwise never
  // gets a row to resolve for a brand-new project's slug. Defense-in-depth:
  // provisionProjectRow already swallows its own failures, but a failed
  // attempt must not fail `setup` overall even if a dep override throws.
  if (dbConnection.found && dbConnection.connectivity?.ok && dbConnection.connectionString) {
    try {
      await provisionProjectRow(dbConnection.connectionString, { repoPath }, provisionDeps);
    } catch (err) {
      log.warn("[setup] project-row provisioning failed; setup still succeeded", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6c. Report the daemon outcome (mt#4707), AFTER every write above.
  //
  // Position is the fix from PR #3658 R2: both messages describe the config as
  // already written, so they are only true here. The daemon ACTION still runs
  // before the first write — see step 3b — because `ensureDaemonRunning`'s
  // refusals are written for a caller that has not yet written anything. Action
  // early, claim late; they are separate requirements pulling in opposite
  // directions, and each is satisfied where it belongs.
  if (localDaemon?.kind === "started") {
    // Said out loud: this started a long-lived background process the operator
    // did not name. Silent process creation is what someone later finds in `ps`
    // and cannot account for.
    log.cli(
      `Started the shared Minsky MCP daemon — your ${client} config talks to it at ` +
        `${localDaemon.url}. Check it any time with \`minsky mcp status\`.`
    );
  }
  if (localDaemon?.kind === "unavailable") {
    // Surfaced, never swallowed — same posture as `initializeProject`'s
    // observability-hook block: a project that is otherwise correctly set up
    // must not fail because one machine-local process could not be started, but
    // an operator whose every tool call will stall for ~15s has to hear about it.
    //
    // No command name in the prefix: `performSetup` is reached from BOTH
    // `minsky setup` and `minsky init` Phase 2, so naming either is wrong half
    // the time.
    log.cliWarn(
      `The shared MCP daemon is not running and could not be started — ` +
        `${localDaemon.reason}\nYour ${client} config has been written and is correct, but ` +
        `every MCP tool call will retry for ~15s and fail until a daemon is serving. ` +
        `Start one with \`minsky mcp start --http --local-daemon\`, or run ` +
        `\`minsky mcp status\` to see what is holding the port.`
    );
  }

  // 7. Return result
  return {
    success: true,
    localConfigPath,
    harnessConfigPath,
    client,
    message: `Setup complete. Local config written to ${localConfigPath}. Harness config written to ${harnessConfigPath}.`,
    dbConnection,
    localDaemon,
  };
}
