/**
 * GitHub label management operations.
 *
 * Provides:
 *   - createLabel  — create a new label on a repository
 *   - listLabels   — list all labels (paginated, collects all pages)
 *   - updateLabel  — rename, recolor, or re-describe a label
 *   - deleteLabel  — remove a label from a repository
 *
 * Auth goes through `gh.getToken()` (TokenProvider-aware), consistent with
 * the rest of the GitHub subinterface family.
 *
 * GitHub API reference:
 *   https://docs.github.com/en/rest/issues/labels
 */

import { MinskyError } from "../../errors/index";
import { handleOctokitError } from "./github-error-handler";
import { type GitHubContext, createOctokit } from "./github-pr-operations";

// ── Public types ──────────────────────────────────────────────────────────

/** A single GitHub label. */
export interface Label {
  /** GitHub's numeric label ID. */
  id: number;
  /** Label name. */
  name: string;
  /**
   * Hex color string without the leading `#` (e.g. "d73a4a").
   * GitHub normalises this to lowercase 6-character hex.
   */
  color: string;
  /** Optional description. */
  description: string | null;
  /** Whether this is a GitHub-default label. */
  default: boolean;
}

/** Parameters for creating a label. */
export interface CreateLabelParams {
  /** Label name (must be unique within the repo). */
  name: string;
  /**
   * Hex color without leading `#`. GitHub accepts 6-digit lowercase hex.
   * Example: "d73a4a" (red), "0075ca" (blue), "cfd3d7" (light grey).
   */
  color: string;
  /** Optional description (up to 100 characters). */
  description?: string;
}

/** Parameters for updating a label. */
export interface UpdateLabelParams {
  /** New name for the label (renames it). */
  name?: string;
  /** New color (hex without `#`). */
  color?: string;
  /** New description. */
  description?: string;
}

/** Options for listing labels. */
export interface ListLabelsOptions {
  /** Number of labels per page (default: 100). */
  perPage?: number;
}

// ── Implementation ────────────────────────────────────────────────────────

/**
 * Create a new label on the repository.
 *
 * @param gh     — GitHub context (owner, repo, token resolver)
 * @param params — label creation parameters
 * @param octokitOverride — optional DI-injected Octokit for testing
 */
export async function createLabel(
  gh: GitHubContext,
  params: CreateLabelParams,
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<Label> {
  if (!params.name || params.name.trim().length === 0) {
    throw new MinskyError("createLabel: label name is required");
  }
  if (!params.color || params.color.trim().length === 0) {
    throw new MinskyError("createLabel: label color is required");
  }

  try {
    const octokit = octokitOverride ?? createOctokit(await gh.getToken());

    const resp = await octokit.rest.issues.createLabel({
      owner: gh.owner,
      repo: gh.repo,
      name: params.name,
      color: params.color,
      ...(params.description !== undefined ? { description: params.description } : {}),
    });

    return mapLabel(resp.data);
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "create label",
      owner: gh.owner,
      repo: gh.repo,
    });
    throw error;
  }
}

/**
 * List all labels on the repository, collecting all pages.
 *
 * @param gh      — GitHub context (owner, repo, token resolver)
 * @param options — optional list configuration
 * @param octokitOverride — optional DI-injected Octokit for testing
 */
export async function listLabels(
  gh: GitHubContext,
  options: ListLabelsOptions = {},
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<Label[]> {
  try {
    const octokit = octokitOverride ?? createOctokit(await gh.getToken());
    const perPage = options.perPage ?? 100;

    const allLabels: Label[] = [];
    let page = 1;

    while (true) {
      const resp = await octokit.rest.issues.listLabelsForRepo({
        owner: gh.owner,
        repo: gh.repo,
        per_page: perPage,
        page,
      });

      const items = resp.data;
      allLabels.push(...items.map(mapLabel));

      if (items.length < perPage) {
        // Last page
        break;
      }
      page++;
    }

    return allLabels;
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "list labels",
      owner: gh.owner,
      repo: gh.repo,
    });
    throw error;
  }
}

/**
 * Update an existing label (rename, recolor, or change description).
 *
 * @param gh          — GitHub context (owner, repo, token resolver)
 * @param currentName — current label name (used to identify the label)
 * @param params      — fields to update
 * @param octokitOverride — optional DI-injected Octokit for testing
 */
export async function updateLabel(
  gh: GitHubContext,
  currentName: string,
  params: UpdateLabelParams,
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<Label> {
  if (!currentName || currentName.trim().length === 0) {
    throw new MinskyError("updateLabel: currentName is required");
  }

  try {
    const octokit = octokitOverride ?? createOctokit(await gh.getToken());

    const resp = await octokit.rest.issues.updateLabel({
      owner: gh.owner,
      repo: gh.repo,
      name: currentName,
      ...(params.name !== undefined ? { new_name: params.name } : {}),
      ...(params.color !== undefined ? { color: params.color } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
    });

    return mapLabel(resp.data);
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "update label",
      owner: gh.owner,
      repo: gh.repo,
    });
    throw error;
  }
}

/**
 * Delete a label from the repository.
 *
 * @param gh   — GitHub context (owner, repo, token resolver)
 * @param name — label name to delete
 * @param octokitOverride — optional DI-injected Octokit for testing
 */
export async function deleteLabel(
  gh: GitHubContext,
  name: string,
  octokitOverride?: ReturnType<typeof createOctokit>
): Promise<void> {
  if (!name || name.trim().length === 0) {
    throw new MinskyError("deleteLabel: label name is required");
  }

  try {
    const octokit = octokitOverride ?? createOctokit(await gh.getToken());

    await octokit.rest.issues.deleteLabel({
      owner: gh.owner,
      repo: gh.repo,
      name,
    });
  } catch (error) {
    if (error instanceof MinskyError) throw error;
    handleOctokitError(error, {
      operation: "delete label",
      owner: gh.owner,
      repo: gh.repo,
    });
    throw error;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

/** Map a raw GitHub API label object to our Label interface. */
function mapLabel(raw: Record<string, unknown>): Label {
  return {
    id: raw["id"] as number,
    name: raw["name"] as string,
    color: raw["color"] as string,
    description: (raw["description"] as string | null | undefined) ?? null,
    default: Boolean(raw["default"]),
  };
}
