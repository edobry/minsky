/**
 * `minsky setup github-app` shared command.
 *
 * Creates and installs a GitHub App via the manifest flow (default) or a
 * guided wizard (for environments where the manifest flow does not apply).
 * Writes credentials to `<outputDir>/<name>.{pem,json}` and returns the
 * App ID + installation ID for follow-up configuration.
 *
 * @see mt#1087
 */

import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { confirm, isCancel, note } from "@clack/prompts";
import { getErrorMessage, ValidationError } from "@minsky/domain/errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandParameterMap,
} from "../command-registry";
import { composeParams } from "../common-parameters";
import { isInteractive } from "../../../utils/interactive";
import {
  BrowserCancelledError,
  GuidedWizardProvisioner,
  LocalConfigCredentialStore,
  ManifestFlowProvisioner,
  provisionGithubApp as defaultProvisionGithubApp,
  updateGithubApp as defaultUpdateGithubApp,
  type AppManifestSpec,
  type AppProvisioner,
  type CredentialStore,
} from "@minsky/domain/setup/github-app";

/**
 * Test seam: dependency overrides for `setup.github-app`.
 *
 * Production callers leave this undefined; tests inject mocks to avoid
 * touching the real filesystem, browser, or GitHub API.
 */
export interface SetupGithubAppDeps {
  provisionGithubApp?: typeof defaultProvisionGithubApp;
  updateGithubApp?: typeof defaultUpdateGithubApp;
  makeStore?: (outputDir: string) => CredentialStore;
  makeProvisioner?: (
    via: "manifest" | "wizard",
    port: number | undefined,
    hosts: { apiBaseUrl?: string; webBaseUrl?: string }
  ) => AppProvisioner;
}

const setupGithubAppParams = composeParams(
  {
    name: {
      schema: z.string(),
      description: "App name (e.g. minsky-reviewer); also the file prefix under outputDir",
      required: true,
    },
    repo: {
      schema: z.string().optional(),
      description: "Target repo in owner/repo form (required for create, not for --update)",
      required: false,
    },
    via: {
      schema: z.string().optional(),
      description: "Provisioner: manifest (default) or wizard (for non-manifest environments)",
      required: false,
    },
    outputDir: {
      schema: z.string().optional(),
      description: "Where to write credentials (default: ~/.config/minsky)",
      required: false,
    },
    force: {
      schema: z.boolean().optional(),
      description: "Re-provision even if credentials already exist for this name",
      required: false,
    },
    update: {
      schema: z.boolean().optional(),
      description: "Update an existing App's events/permissions via PATCH /app",
      required: false,
    },
    execute: {
      schema: z.boolean().optional(),
      description: "Apply changes (without this flag, --update shows a dry-run preview)",
      required: false,
    },
  },
  {
    permissions: {
      schema: z.string().optional(),
      description:
        "Comma-separated k:v permissions (default: pull_requests:write,contents:read,metadata:read)",
      required: false,
    },
    events: {
      schema: z.string().optional(),
      description: "Comma-separated GitHub event names (default: none)",
      required: false,
    },
    webhookUrl: {
      schema: z.string().optional(),
      description: "Webhook URL to prefill in hook_attributes",
      required: false,
    },
    inactive: {
      schema: z.boolean().optional(),
      description: "Create with hook_attributes.active=false (no webhook deliveries)",
      required: false,
    },
    port: {
      schema: z.number().optional(),
      description: "Local callback port for the manifest flow (1-65535; default: 9847)",
      required: false,
    },
    apiBaseUrl: {
      schema: z.string().optional(),
      description:
        "GitHub API base URL for the wizard (default: https://api.github.com; set for GHE)",
      required: false,
    },
    webBaseUrl: {
      schema: z.string().optional(),
      description: "GitHub web base URL for the wizard (default: https://github.com; set for GHE)",
      required: false,
    },
  }
) satisfies CommandParameterMap;

const DEFAULT_PERMISSIONS = "pull_requests:write,contents:read,metadata:read";

function parsePermissions(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [k, v] = trimmed.split(":");
    if (!k || !v) {
      throw new ValidationError(
        `Malformed --permissions entry: "${trimmed}". Expected k:v form (e.g., pull_requests:write).`
      );
    }
    out[k.trim()] = v.trim();
  }
  return out;
}

function parseEvents(raw: string): string[] {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function registerSetupGithubAppCommand(deps: SetupGithubAppDeps = {}): void {
  const provisionGithubApp = deps.provisionGithubApp ?? defaultProvisionGithubApp;
  const updateGithubApp = deps.updateGithubApp ?? defaultUpdateGithubApp;
  const makeStore =
    deps.makeStore ?? ((outputDir: string) => new LocalConfigCredentialStore(outputDir));
  const makeProvisioner =
    deps.makeProvisioner ??
    ((
      via: "manifest" | "wizard",
      port: number | undefined,
      hosts: { apiBaseUrl?: string; webBaseUrl?: string }
    ) =>
      via === "manifest"
        ? new ManifestFlowProvisioner({ port })
        : new GuidedWizardProvisioner({
            apiBaseUrl: hosts.apiBaseUrl,
            webBaseUrl: hosts.webBaseUrl,
          }));

  // When called with explicit deps (i.e., from tests), allow overwrite so
  // each test re-registers cleanly. Production calls pass no deps and
  // register exactly once.
  const allowOverwrite =
    deps.provisionGithubApp !== undefined ||
    deps.updateGithubApp !== undefined ||
    deps.makeStore !== undefined ||
    deps.makeProvisioner !== undefined;

  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "setup.github-app",
      category: CommandCategory.INIT,
      name: "setup github-app",
      description:
        "Create and install a GitHub App via the manifest flow (or guided wizard fallback)",
      parameters: setupGithubAppParams,
      requiresSetup: false,
      execute: async (params, _ctx) => {
        try {
          const outputDir = params.outputDir
            ? expandHome(params.outputDir)
            : join(homedir(), ".config", "minsky");

          // --update mode: update existing App's events/permissions
          if (params.update) {
            const store = makeStore(outputDir);
            const events = params.events ? parseEvents(params.events) : undefined;
            const permissions = params.permissions
              ? parsePermissions(params.permissions)
              : undefined;

            const result = await updateGithubApp({
              name: params.name,
              store,
              events,
              permissions,
              execute: params.execute ?? false,
              apiBaseUrl: params.apiBaseUrl,
            });

            return result;
          }

          // Create mode (existing behavior)
          if (!params.repo) {
            // eslint-disable-next-line custom/no-validation-error-in-execute
            throw new ValidationError(
              "--repo is required for App creation. Pass --update to update an existing App."
            );
          }

          const permissions = parsePermissions(params.permissions ?? DEFAULT_PERMISSIONS);
          const events = parseEvents(params.events ?? "");

          const repoParts = params.repo.split("/");
          if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
            // eslint-disable-next-line custom/no-validation-error-in-execute
            throw new ValidationError(`--repo must be <owner>/<name>, got "${params.repo}"`);
          }
          const owner = repoParts[0];

          const via = params.via ?? "manifest";
          if (via !== "manifest" && via !== "wizard") {
            // eslint-disable-next-line custom/no-validation-error-in-execute
            throw new ValidationError(`--via must be "manifest" or "wizard", got "${via}"`);
          }

          // Validate port: the manifest flow embeds it in the redirect_url
          // before the server binds, so 0 / out-of-range values produce
          // broken localhost URLs. Mirrors the constraint in
          // ManifestFlowProvisioner's constructor (and the legacy script's
          // arg validation).
          if (params.port !== undefined) {
            if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65535) {
              // eslint-disable-next-line custom/no-validation-error-in-execute
              throw new ValidationError(
                `--port must be a TCP port (1-65535), got ${params.port}. ` +
                  `Port 0 / OS-assigned ports are not supported.`
              );
            }
          }

          const spec: AppManifestSpec = {
            name: params.name,
            repo: params.repo,
            owner,
            permissions,
            events,
            webhookUrl: params.webhookUrl,
            inactive: params.inactive ?? false,
          };

          // Manifest preview (Operational Safety: Dry-Run First)
          if (isInteractive() && via === "manifest") {
            const eventsLine =
              events.length > 0 ? `Events:      ${events.join(", ")}` : "Events:      (none)";
            const previewLines = [
              `Name:        ${spec.name}`,
              `Repo:        ${spec.repo}`,
              `Permissions: ${Object.entries(permissions)
                .map(([k, v]) => `${k}:${v}`)
                .join(", ")}`,
              eventsLine,
              `Webhook:     ${spec.webhookUrl ?? "(placeholder)"}${spec.inactive ? " (inactive)" : ""}`,
            ];
            note(previewLines.join("\n"), "GitHub App manifest preview");
            const proceed = await confirm({
              message: "Submit this manifest to GitHub?",
              initialValue: true,
            });
            if (isCancel(proceed) || proceed === false) {
              return { success: false, message: "Cancelled by user." };
            }
          }

          const store = makeStore(outputDir);
          const provisioner = makeProvisioner(via, params.port, {
            apiBaseUrl: params.apiBaseUrl,
            webBaseUrl: params.webBaseUrl,
          });

          const result = await provisionGithubApp({
            name: params.name,
            spec,
            store,
            provisioner,
            force: params.force ?? false,
          });

          const credentialSubset = {
            appId: result.credentials.appId,
            slug: result.credentials.slug,
            installationId: result.credentials.installationId,
            privateKeyFile: join(outputDir, `${params.name}.pem`),
          };

          if (result.status === "already-exists") {
            return {
              success: true,
              message: `App "${params.name}" already exists. Pass --force to re-create.`,
              credentials: credentialSubset,
            };
          }

          return {
            success: true,
            message: `App "${params.name}" created.`,
            credentials: credentialSubset,
          };
        } catch (err) {
          if (err instanceof BrowserCancelledError) {
            return { success: false, message: err.message };
          }
          // Preserve original error class for ValidationError + Error
          // subclasses; only wrap unknown / non-Error throws as Error so
          // operational failures (network, fs) keep their semantics and
          // are not conflated with user-input validation errors.
          if (err instanceof Error) throw err;
          throw new Error(getErrorMessage(err));
        }
      },
    }),
    { allowOverwrite }
  );
}
