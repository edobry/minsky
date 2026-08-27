/**
 * Setup command — developer-local initialization.
 *
 * Reads the existing project config and derives local configuration
 * (MCP registration + local config file). Unlike `init`, this works
 * with an already-initialized project without requiring the full config
 * system to be initialized.
 */

import { z } from "zod";
import { select, confirm, isCancel, cancel } from "@clack/prompts";
import { getErrorMessage } from "@minsky/domain/errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandParameterMap,
} from "../command-registry";
import { performSetup } from "@minsky/domain/setup";
import { applyHarnessSettings } from "@minsky/domain/setup/harness-settings";
import { detectInstalledClients } from "@minsky/domain/runtime/harness-detection";
import { ValidationError } from "@minsky/domain/errors/index";
import { CommonParameters, composeParams } from "../common-parameters";
import { isInteractive } from "../../../utils/interactive";
import { runInteractiveSetupDb } from "./setup-db";
import { readFile } from "node:fs/promises";
import { parse as yamlParse } from "yaml";
import path from "node:path";
import { getConfiguration } from "@minsky/domain/configuration";
import { createTokenProvider } from "@minsky/domain/auth";
import { GitHubAppTokenProvider } from "@minsky/domain/auth/github-app-token-provider";
import { extractOwnerRepo } from "@minsky/domain/project/slug";
import {
  checkAppRoleCoverage,
  formatAppCoverage,
  type AppRoleCoverage,
  type AppRoleDescriptor,
} from "@minsky/domain/setup/app-coverage";
import {
  buildAppGrantRequestAsk,
  hasOpenAppGrantRequest,
  isPolicyResolved,
} from "@minsky/domain/setup/app-grant-request";
import { PENDING_REQUEST_STATES as PENDING_ASK_STATES } from "@minsky/domain/ask/presence-backed-request";
import { buildAskRepository, createAskWithFormLint } from "./asks";
import { log } from "@minsky/shared/logger";

/**
 * Onboarding-time GitHub App installation-coverage check (mt#4680).
 *
 * A repository the App installation does not cover otherwise announces itself
 * as a bare 404 from `pulls.create`, after the branch has already been pushed
 * and long after onboarding. Nothing in `init` or `setup` mentioned the App at
 * all, so this is the first place the gap can surface.
 *
 * Best-effort by construction: every failure path returns a message rather than
 * throwing, because a probe that cannot run must not fail a setup that
 * otherwise succeeded.
 */
async function checkGitHubAppCoverageMessage(repoPath: string): Promise<string | null> {
  try {
    const configPath = path.join(repoPath, ".minsky", "config.yaml");
    const raw = yamlParse(String(await readFile(configPath, "utf-8"))) as
      | { repository?: { url?: string } }
      | undefined;
    const url = raw?.repository?.url;
    if (!url) return null;

    // Derive owner/repo from the canonical URL rather than the denormalized
    // `repository.github.{owner,repo}` fields: those were written by whatever
    // parser ran at `init` time, and before mt#4671 that parser truncated any
    // repo name containing a dot.
    const ownerRepo = extractOwnerRepo(url);
    if (!ownerRepo) return null;

    const cfg = getConfiguration();
    const provider = createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? "");
    const appProvider = provider instanceof GitHubAppTokenProvider ? provider : null;

    // Every CONFIGURED role, not just the implementer (mt#4693 D6). A
    // configured-but-uncovered reviewer App breaks the review loop with no
    // onboarding signal at all, and the single-role check could not see it.
    const roles = describeConfiguredAppRoles(cfg);
    const coverage = await checkAppRoleCoverage(ownerRepo, roles, { provider: appProvider });

    const uncovered = coverage.filter((entry) => entry.status.state === "not-covered");
    const unknown = coverage.filter((entry) => entry.status.state === "unknown");

    // Turn the detection into a durable, pollable request rather than leaving it
    // as a line in the setup output (mt#4693). `unknown` deliberately files
    // NOTHING: a probe that could not run is not a missing grant, and telling an
    // operator to grant access they already have wastes the trip.
    const filed = uncovered.length > 0 ? await fileAppGrantRequests(uncovered) : [];

    const lines: string[] = [];
    for (const entry of [...uncovered, ...unknown]) {
      lines.push(formatAppCoverage(entry.status, entry.slug));
    }
    if (filed.length > 0) {
      lines.push(
        `  Tracked as ${filed.length === 1 ? "an open request" : `${filed.length} open requests`} — Minsky will notice the grant on its own; nothing to confirm here.`
      );
    }

    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    // intentional-swallow: coverage is advisory; setup must not fail on it.
    return null;
  }
}

/**
 * The App roles this installation actually has configured, with the display
 * slug and installation id each operator-facing surface needs.
 *
 * The installation id comes from CONFIG rather than from the token provider,
 * which holds it on a private field — the same source mt#4695 uses for the
 * deep link in the CLI message.
 */
function describeConfiguredAppRoles(cfg: {
  github?: {
    serviceAccount?: { installationId?: number };
    reviewer?: { serviceAccount?: { installationId?: number } };
  };
}): AppRoleDescriptor[] {
  const roles: AppRoleDescriptor[] = [];
  const implementerId = cfg.github?.serviceAccount?.installationId;
  roles.push({
    role: "implementer",
    slug: "minsky-ai",
    ...(implementerId === undefined ? {} : { installationId: implementerId }),
  });

  const reviewerId = cfg.github?.reviewer?.serviceAccount?.installationId;
  if (cfg.github?.reviewer?.serviceAccount) {
    roles.push({
      role: "reviewer",
      slug: "minsky-reviewer",
      ...(reviewerId === undefined ? {} : { installationId: reviewerId }),
    });
  }
  return roles;
}

/**
 * File one durable grant request per uncovered role, skipping any that already
 * has one open.
 *
 * **Best-effort by construction.** Persistence may legitimately be unavailable
 * at this point — `setup` is the command that CONFIGURES the database, and an
 * operator can decline that step — so a missing ask repository degrades to the
 * printed message rather than failing a setup that otherwise succeeded.
 *
 * Returns the ids actually filed, so the caller reports what happened rather
 * than asserting it.
 */
async function fileAppGrantRequests(uncovered: AppRoleCoverage[]): Promise<string[]> {
  const repo = await buildAskRepository(undefined);
  if (!repo) return [];

  const existing = (
    await Promise.all(PENDING_ASK_STATES.map((state) => repo.listByState(state)))
  ).flat();

  const filed: string[] = [];
  for (const entry of uncovered) {
    if (entry.status.state !== "not-covered") continue;

    // Idempotency: re-running `minsky setup` on an uncovered repo must not file
    // a second ask (mt#4693; RFC 390937f0 names escalation spam as a threat).
    if (hasOpenAppGrantRequest(existing, { repo: entry.status.repo, role: entry.role })) continue;

    const draft = buildAppGrantRequestAsk({
      repo: entry.status.repo,
      role: entry.role,
      slug: entry.slug,
      ...(entry.settingsUrl ? { settingsUrl: entry.settingsUrl } : {}),
    });

    const { ask } = await createAskWithFormLint(repo, {
      kind: draft.kind,
      title: draft.title,
      question: draft.question,
      requestor: "minsky:setup",
      metadata: draft.metadata,
    } as Parameters<typeof createAskWithFormLint>[1]);

    // The router can auto-resolve `authorization.approve` in-policy and close it
    // without a human ever seeing it (mt#3233). Because this resolves by COVERAGE
    // PRESENCE, that produces a request which never resolves while reading as
    // settled — so surface it rather than reporting a grant request nobody was
    // asked for.
    if (isPolicyResolved(ask)) {
      log.warn("setup: app-grant request was resolved in-policy, not routed to the operator", {
        askId: ask.id,
        repo: entry.status.repo,
        role: entry.role,
      });
      continue;
    }

    filed.push(ask.id);
  }
  return filed;
}

const setupParams = composeParams(
  {
    repo: {
      schema: z.string().optional(),
      description: "Repository path to set up",
      required: false,
    },
    workspacePath: CommonParameters.workspace,
    overwrite: CommonParameters.overwrite,
  },
  {
    client: {
      schema: z.string().optional(),
      description: "MCP client to register with (e.g. cursor)",
      required: false,
    },
    skipAgentSettings: {
      schema: z.boolean().optional(),
      description: "Skip applying recommended agent performance settings",
      required: false,
    },
    connectionString: {
      schema: z.string().optional(),
      description:
        "Postgres connection string, used only if no connection can be inherited from " + // gitleaks:allow — placeholder, not a real credential
        "existing config (otherwise captured via the setup db wizard)",
      required: false,
    },
    yes: {
      schema: z.boolean().optional(),
      description: "Skip the DB-setup confirmation prompt if the interactive wizard runs",
      required: false,
    },
  }
) satisfies CommandParameterMap;

/**
 * Test seam: dependency overrides for `setup`. Production callers leave this undefined;
 * tests inject mocks to avoid touching the filesystem, config loader, or a live DB.
 */
export interface SetupCommandDeps {
  performSetup?: typeof performSetup;
  runInteractiveSetupDb?: typeof runInteractiveSetupDb;
}

export function registerSetupCommands(deps: SetupCommandDeps = {}) {
  const performSetupFn = deps.performSetup ?? performSetup;
  const runInteractiveSetupDbFn = deps.runInteractiveSetupDb ?? runInteractiveSetupDb;

  // When called with explicit deps (i.e., from tests), allow overwrite so each test
  // re-registers cleanly. Production calls pass no deps and register exactly once.
  const allowOverwrite =
    deps.performSetup !== undefined || deps.runInteractiveSetupDb !== undefined;

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "setup",
      category: CommandCategory.INIT,
      name: "setup",
      description:
        "Set up developer-local configuration for Minsky (MCP registration + local config + " +
        "DB connection inheritance)",
      parameters: setupParams,
      requiresSetup: false,
      execute: async (params, _ctx) => {
        try {
          const repoPath = params.repo || params.workspacePath || process.cwd();
          const overwrite = params.overwrite ?? false;

          // Determine which client to register with
          let client = params.client;
          if (!client) {
            const installedClients = detectInstalledClients();

            if (installedClients.length === 0) {
              // No known clients detected — default to cursor
              client = "cursor";
            } else if (installedClients.length === 1) {
              // Only one client detected — use it automatically
              client = installedClients[0];
            } else {
              // Multiple clients detected — prompt if interactive
              if (!isInteractive()) {
                // eslint-disable-next-line custom/no-validation-error-in-execute
                throw new ValidationError(
                  `Multiple MCP clients detected (${installedClients.join(", ")}). Use --client to specify one.`
                );
              }

              const selectedClient = await select({
                message: "Select an MCP client to register Minsky with:",
                options: installedClients.map((c) => ({ value: c, label: c })),
                initialValue: installedClients[0],
              });

              if (isCancel(selectedClient)) {
                cancel("Setup cancelled.");
                return { success: false, message: "Setup cancelled by user." };
              }

              client = selectedClient as string;
            }
          }

          const result = await performSetupFn({ repoPath, client, overwrite });

          // Apply recommended agent performance settings unless skipped
          const agentSettingsMessages: string[] = [];
          if (!params.skipAgentSettings) {
            // Dry-run first to see what would change
            const preview = await applyHarnessSettings({ dryRun: true });
            const toApply = preview.filter((r) => r.status === "applied");

            if (toApply.length > 0 && isInteractive()) {
              // Show what will be changed and prompt
              const changeLines = toApply.flatMap((r) =>
                r.changes.map(
                  (c) =>
                    `  ${r.harness}: ${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`
                )
              );
              const shouldApply = await confirm({
                message: `Apply recommended agent performance settings?\n${changeLines.join("\n")}`,
                initialValue: true,
              });

              if (!isCancel(shouldApply) && shouldApply) {
                const applied = await applyHarnessSettings({ dryRun: false });
                for (const r of applied) {
                  if (r.status === "applied") {
                    agentSettingsMessages.push(
                      `Agent settings applied for ${r.harness} (${r.settingsPath})`
                    );
                  }
                }
              } else {
                agentSettingsMessages.push("Agent settings skipped.");
              }
            } else {
              // Non-interactive or nothing to apply
              for (const r of preview) {
                if (r.status === "already-configured") {
                  agentSettingsMessages.push(`Agent settings already configured for ${r.harness}.`);
                } else if (r.status === "not-detected") {
                  // Silently skip undetected harnesses
                }
              }
            }
          }

          const agentSettingsSuffix =
            agentSettingsMessages.length > 0 ? `\n${agentSettingsMessages.join("\n")}` : "";

          // DB-connection inheritance/confirmation (mt#2502): reuse an already-configured
          // Postgres connection when the config loader resolves one (typically left in user
          // config by a prior project); otherwise fall into the interactive `setup db` wizard
          // inline so a new project on the unified instance needs zero database thought.
          // `setup db` remains available standalone for explicit/non-interactive use.
          const dbMessages: string[] = [];
          const { dbConnection } = result;
          if (dbConnection.found && dbConnection.connectivity?.ok) {
            dbMessages.push(
              `Using existing Postgres connection from ${dbConnection.source} (connectivity verified).`
            );
          } else {
            if (dbConnection.found && dbConnection.connectivity && !dbConnection.connectivity.ok) {
              dbMessages.push(
                `Found a Postgres connection in ${dbConnection.source}, but it did not pass a ` +
                  `connectivity check (${dbConnection.connectivity.error ?? "unknown error"}) — ` +
                  `falling back to interactive database setup.`
              );
            }
            const dbResult = await runInteractiveSetupDbFn({
              connectionString: params.connectionString,
              yes: params.yes,
            });
            dbMessages.push(dbResult.message);
          }
          const dbSuffix = dbMessages.length > 0 ? `\n${dbMessages.join("\n")}` : "";

          // mt#4680: surface a missing App grant here rather than letting it
          // appear as a 404 at PR-create time.
          const coverageMessage = await checkGitHubAppCoverageMessage(repoPath);
          const coverageSuffix = coverageMessage ? `\n${coverageMessage}` : "";

          return {
            success: result.success,
            message: result.message + agentSettingsSuffix + dbSuffix + coverageSuffix,
            localConfigPath: result.localConfigPath,
            harnessConfigPath: result.harnessConfigPath,
            client: result.client,
            dbConnection: result.dbConnection,
          };
        } catch (error: unknown) {
          throw error instanceof ValidationError
            ? error
            : new ValidationError(getErrorMessage(error));
        }
      },
    }),
    { allowOverwrite }
  );
}
