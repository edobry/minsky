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
import { getErrorMessage, ValidationError } from "../../../errors/index";
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
  type AppManifestSpec,
  type AppProvisioner,
  type CredentialStore,
} from "../../../domain/setup/github-app";

/**
 * Test seam: dependency overrides for `setup.github-app`.
 *
 * Production callers leave this undefined; tests inject mocks to avoid
 * touching the real filesystem, browser, or GitHub API.
 */
export interface SetupGithubAppDeps {
  provisionGithubApp?: typeof defaultProvisionGithubApp;
  makeStore?: (outputDir: string) => CredentialStore;
  makeProvisioner?: (via: "manifest" | "wizard", port: number | undefined) => AppProvisioner;
}

const setupGithubAppParams = composeParams(
  {
    name: {
      schema: z.string(),
      description: "App name (e.g. minsky-reviewer); also the file prefix under outputDir",
      required: true,
    },
    repo: {
      schema: z.string(),
      description: "Target repo in owner/repo form",
      required: true,
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
      description: "Local callback port for the manifest flow (default: 9847)",
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
  const makeStore =
    deps.makeStore ?? ((outputDir: string) => new LocalConfigCredentialStore(outputDir));
  const makeProvisioner =
    deps.makeProvisioner ??
    ((via: "manifest" | "wizard", port: number | undefined) =>
      via === "manifest" ? new ManifestFlowProvisioner({ port }) : new GuidedWizardProvisioner());

  // When called with explicit deps (i.e., from tests), allow overwrite so
  // each test re-registers cleanly. Production calls pass no deps and
  // register exactly once.
  const allowOverwrite =
    deps.provisionGithubApp !== undefined ||
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

          const outputDir = expandHome(params.outputDir ?? "~/.config/minsky");

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
          const provisioner = makeProvisioner(via, params.port);

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
          throw err instanceof ValidationError ? err : new ValidationError(getErrorMessage(err));
        }
      },
    }),
    { allowOverwrite }
  );
}
