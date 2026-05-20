/**
 * Shared forge commands (forge-agnostic CI, check-runs, branch-protection, labels).
 *
 * Exposes nine MCP tools that route through the configured ForgeBackend:
 *   forge.ci_run_list          — list CI workflow runs (filter: workflow, branch, status)
 *   forge.ci_run_view_log      — download and decode logs for a run ID
 *   forge.check_runs_list      — list check-runs for an arbitrary commit SHA
 *   forge.branch_protection_get — get branch protection settings
 *   forge.branch_protection_set — replace branch protection settings
 *   forge.label_create         — create a repo label
 *   forge.label_list           — list all repo labels
 *   forge.label_update         — rename / recolor / re-describe a label
 *   forge.label_delete         — remove a label
 *
 * Architectural anchor: ADR-005 (ForgeBackend subinterfaces). All operations route
 * through the ForgeBackend returned by createRepositoryBackend — same path as
 * session.pr.checks, session.pr.merge, etc.
 *
 * Tracking task: mt#1957.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import { MinskyError } from "../../../errors/index";
import { log } from "../../../utils/logger";

// ── Internal helper: resolve a ForgeBackend from config ───────────────────

/**
 * Build a ForgeBackend by reading the project configuration.
 *
 * Lazy-imported so the domain layer is not loaded at command-registration time.
 * Uses the same code path as createChangesetAwareRepositoryBackend and the
 * github-adapter's `isAvailable` method.
 */
async function resolveForgeBackend() {
  const { getRepositoryBackendFromConfig } = await import(
    "../../../domain/session/repository-backend-detection"
  );
  const { createRepositoryBackend, RepositoryBackendType } = await import(
    "../../../domain/repository/index"
  );
  const { createSessionProvider } = await import("../../../domain/session/session-db-adapter");

  const { repoUrl, backendType, github } = await getRepositoryBackendFromConfig();

  if (backendType !== RepositoryBackendType.GITHUB) {
    throw new MinskyError(
      `forge commands: unsupported backend type "${String(backendType)}". Only "github" is currently implemented.`
    );
  }

  const config = {
    type: RepositoryBackendType.GITHUB,
    repoUrl,
    github: github ?? undefined,
  };

  const sessionDB = await createSessionProvider();
  const backend = await createRepositoryBackend(config, sessionDB);

  log.debug("forge: resolved ForgeBackend", { backendType, repoUrl });
  return backend;
}

// ── forge.ci_run_list ─────────────────────────────────────────────────────

sharedCommandRegistry.registerCommand({
  id: "forge.ci_run_list",
  category: CommandCategory.FORGE,
  name: "ci_run_list",
  description:
    "List CI workflow runs for the configured repository. " +
    "Optionally filter by workflow file name (e.g. 'ci.yml'), branch name, " +
    "or lifecycle status (queued, in_progress, completed, success, failure, etc.).",
  parameters: {
    workflow: {
      schema: z.string().optional(),
      description: "Workflow file name (e.g. 'ci.yml') or numeric workflow ID to filter by.",
      required: false,
    },
    branch: {
      schema: z.string().optional(),
      description: "Branch name to filter runs by.",
      required: false,
    },
    status: {
      schema: z.string().optional(),
      description:
        "Lifecycle status filter: queued | in_progress | completed | success | failure | " +
        "neutral | cancelled | skipped | timed_out | action_required | stale | waiting | " +
        "requested | pending.",
      required: false,
    },
    perPage: {
      schema: z.number().int().min(1).max(100).optional(),
      description: "Maximum results to return (1–100, default 30).",
      required: false,
      defaultValue: 30,
    },
  },
  requiresSetup: true,
  execute: async (params) => {
    const backend = await resolveForgeBackend();
    const runs = await backend.workflowRuns.list({
      workflow: params.workflow as string | undefined,
      branch: params.branch as string | undefined,
      status: params.status as string | undefined,
      perPage: params.perPage as number | undefined,
    });
    return { success: true, runs, count: runs.length };
  },
});

// ── forge.ci_run_view_log ─────────────────────────────────────────────────

sharedCommandRegistry.registerCommand({
  id: "forge.ci_run_view_log",
  category: CommandCategory.FORGE,
  name: "ci_run_view_log",
  description:
    "Download and decode the logs for a specific CI workflow run. " +
    "Returns the log content as text (ZIP entries are extracted inline). " +
    "Falls back to base64 if DEFLATE-compressed entries cannot be inflated without a native ZIP library.",
  parameters: {
    runId: {
      schema: z.number().int().positive(),
      description: "Numeric workflow run ID (from forge.ci_run_list).",
      required: true,
    },
  },
  requiresSetup: true,
  execute: async (params) => {
    const runId = params.runId as number;
    const backend = await resolveForgeBackend();
    const logs = await backend.workflowRuns.viewLogs(runId);
    return { success: true, logs, runId };
  },
});

// ── forge.check_runs_list ─────────────────────────────────────────────────

sharedCommandRegistry.registerCommand({
  id: "forge.check_runs_list",
  category: CommandCategory.FORGE,
  name: "check_runs_list",
  description:
    "List check-runs for an arbitrary commit SHA. " +
    "Exposes the existing ci.getChecksForRef capability at the MCP surface, " +
    "complementing session.pr.checks (which requires a PR context).",
  parameters: {
    sha: {
      schema: z.string().min(1),
      description: "The full or abbreviated commit SHA to query check-runs for.",
      required: true,
    },
  },
  requiresSetup: true,
  execute: async (params) => {
    const sha = params.sha as string;
    const backend = await resolveForgeBackend();
    const result = await backend.ci.getChecksForRef(sha);
    return { success: true, ...result };
  },
});

// ── forge.branch_protection_get ───────────────────────────────────────────

sharedCommandRegistry.registerCommand({
  id: "forge.branch_protection_get",
  category: CommandCategory.FORGE,
  name: "branch_protection_get",
  description: "Get branch protection settings for a branch (e.g. 'main').",
  parameters: {
    branch: {
      schema: z.string().min(1),
      description: "Branch name (e.g. 'main', 'develop').",
      required: true,
    },
  },
  requiresSetup: true,
  execute: async (params) => {
    const branch = params.branch as string;
    const backend = await resolveForgeBackend();
    const protection = await backend.branchProtection.get(branch);
    return { success: true, branch, protection };
  },
});

// ── forge.branch_protection_set ───────────────────────────────────────────

sharedCommandRegistry.registerCommand({
  id: "forge.branch_protection_set",
  category: CommandCategory.FORGE,
  name: "branch_protection_set",
  description:
    "Replace branch protection settings for a branch. " +
    "This is a full-replace operation — fields not provided are treated as disabled. " +
    "Requires admin access to the repository. " +
    "The config parameter should be a JSON object matching the BranchProtection shape " +
    "(required_status_checks, enforce_admins, required_pull_request_reviews, restrictions, etc.).",
  parameters: {
    branch: {
      schema: z.string().min(1),
      description: "Branch name to protect (e.g. 'main').",
      required: true,
    },
    config: {
      schema: z.record(z.string(), z.unknown()),
      description:
        "Branch protection configuration as a JSON object. " +
        "See BranchProtection interface for all fields. " +
        "Example: {required_status_checks: {strict: true, contexts: ['build']}, enforce_admins: true}",
      required: true,
    },
  },
  requiresSetup: true,
  execute: async (params) => {
    const branch = params.branch as string;
    const config = params.config as Record<string, unknown>;
    const backend = await resolveForgeBackend();

    // Pass config as BranchProtection — the impl validates at the API level
    const updated = await backend.branchProtection.set(
      branch,
      config as import("../../../domain/repository/github-branch-protection").BranchProtection
    );
    return { success: true, branch, protection: updated };
  },
});

// ── forge.label_create ────────────────────────────────────────────────────

sharedCommandRegistry.registerCommand({
  id: "forge.label_create",
  category: CommandCategory.FORGE,
  name: "label_create",
  description:
    "Create a new label on the repository. " +
    "Color must be a 6-digit lowercase hex string without the leading '#' (e.g. 'd73a4a').",
  parameters: {
    name: {
      schema: z.string().min(1),
      description: "Label name (must be unique within the repo).",
      required: true,
    },
    color: {
      schema: z.string().regex(/^[0-9a-fA-F]{6}$/),
      description:
        "Hex color without leading '#'. GitHub accepts 6-digit lowercase hex (e.g. 'd73a4a').",
      required: true,
    },
    description: {
      schema: z.string().max(100).optional(),
      description: "Optional label description (up to 100 characters).",
      required: false,
    },
  },
  requiresSetup: true,
  execute: async (params) => {
    const backend = await resolveForgeBackend();
    const label = await backend.labels.create({
      name: params.name as string,
      color: params.color as string,
      description: params.description as string | undefined,
    });
    return { success: true, label };
  },
});

// ── forge.label_list ──────────────────────────────────────────────────────

sharedCommandRegistry.registerCommand({
  id: "forge.label_list",
  category: CommandCategory.FORGE,
  name: "label_list",
  description: "List all labels on the repository. Collects all pages automatically.",
  parameters: {
    perPage: {
      schema: z.number().int().min(1).max(100).optional(),
      description: "Labels per page during pagination (default 100).",
      required: false,
      defaultValue: 100,
    },
  },
  requiresSetup: true,
  execute: async (params) => {
    const backend = await resolveForgeBackend();
    const labels = await backend.labels.list({
      perPage: params.perPage as number | undefined,
    });
    return { success: true, labels, count: labels.length };
  },
});

// ── forge.label_update ────────────────────────────────────────────────────

sharedCommandRegistry.registerCommand({
  id: "forge.label_update",
  category: CommandCategory.FORGE,
  name: "label_update",
  description:
    "Update an existing label: rename, recolor, and/or change its description. " +
    "Only provided fields are updated.",
  parameters: {
    currentName: {
      schema: z.string().min(1),
      description: "Current name of the label to update.",
      required: true,
    },
    name: {
      schema: z.string().min(1).optional(),
      description: "New name for the label (renames it).",
      required: false,
    },
    color: {
      schema: z
        .string()
        .regex(/^[0-9a-fA-F]{6}$/)
        .optional(),
      description: "New color (6-digit hex without '#').",
      required: false,
    },
    description: {
      schema: z.string().max(100).optional(),
      description: "New description (up to 100 characters).",
      required: false,
    },
  },
  requiresSetup: true,
  execute: async (params) => {
    const currentName = params.currentName as string;
    const backend = await resolveForgeBackend();
    const label = await backend.labels.update(currentName, {
      name: params.name as string | undefined,
      color: params.color as string | undefined,
      description: params.description as string | undefined,
    });
    return { success: true, label };
  },
});

// ── forge.label_delete ────────────────────────────────────────────────────

sharedCommandRegistry.registerCommand({
  id: "forge.label_delete",
  category: CommandCategory.FORGE,
  name: "label_delete",
  description: "Delete a label from the repository by name.",
  parameters: {
    name: {
      schema: z.string().min(1),
      description: "Label name to delete.",
      required: true,
    },
  },
  requiresSetup: true,
  execute: async (params) => {
    const name = params.name as string;
    const backend = await resolveForgeBackend();
    await backend.labels.delete(name);
    return { success: true, deleted: name };
  },
});

// ── Registration function ─────────────────────────────────────────────────

/**
 * Register forge commands in the shared command registry.
 *
 * Commands are registered as side-effects of this module's top-level
 * `sharedCommandRegistry.registerCommand(...)` calls, which means simply
 * importing this module suffices. This function exists for explicitness and
 * to match the convention in `src/adapters/shared/commands/index.ts`.
 */
export function registerForgeCommands(): void {
  // All commands are already registered at module load time above.
  // This function is intentionally a no-op — it exists purely to provide a
  // named export that index.ts can call in the same style as every other
  // command-group registration function.
}
