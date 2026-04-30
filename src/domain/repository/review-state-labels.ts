/**
 * Review-state PR Labels
 *
 * Utilities for creating and applying review-state labels to GitHub PRs.
 * Labels are idempotently applied after each reviewer-bot review submission,
 * so external consumers (sweepers, cockpit, dashboard widgets) can filter PRs
 * by review state without querying review history.
 *
 * @see mt#1348 — auto-apply review-state labels on PRs
 */

import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

// ── Label name constants ────────────────────────────────────────────────────

/** Applied when reviewer concludes REQUEST_CHANGES. */
export const LABEL_NEEDS_CHANGES = "review:needs-changes";
/** Applied when reviewer concludes APPROVE. */
export const LABEL_BOT_APPROVED = "review:bot-approved";
/** Applied on COMMENT (informational only). */
export const LABEL_BOT_COMMENTED = "review:bot-commented";

/**
 * All review-state label names. Labels in this group are mutually exclusive
 * except for `review:bot-commented` (which is informational and co-exists).
 *
 * Exclusivity logic:
 *   - REQUEST_CHANGES: adds needs-changes, removes bot-approved
 *   - APPROVE: adds bot-approved, removes needs-changes
 *   - COMMENT: adds bot-commented only (no removals)
 */
export const REVIEW_STATE_LABELS = [
  LABEL_NEEDS_CHANGES,
  LABEL_BOT_APPROVED,
  LABEL_BOT_COMMENTED,
] as const;

/** Maps a review event to its corresponding label name. */
export function reviewEventToLabel(event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"): string {
  switch (event) {
    case "REQUEST_CHANGES":
      return LABEL_NEEDS_CHANGES;
    case "APPROVE":
      return LABEL_BOT_APPROVED;
    case "COMMENT":
      return LABEL_BOT_COMMENTED;
  }
}

/**
 * Returns labels that should be removed when applying the label for a given event.
 * COMMENT reviews only add a label and never remove anything.
 */
export function conflictingLabels(event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"): string[] {
  switch (event) {
    case "REQUEST_CHANGES":
      return [LABEL_BOT_APPROVED];
    case "APPROVE":
      return [LABEL_NEEDS_CHANGES];
    case "COMMENT":
      return [];
  }
}

// ── Octokit interface (minimal surface for label ops) ───────────────────────

export interface OctokitReviewLabelClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paginate<T>(method: (params: any) => Promise<{ data: T[] }>, params: object): Promise<T[]>;
  rest: {
    issues: {
      getLabel(params: { owner: string; repo: string; name: string }): Promise<unknown>;
      createLabel(params: {
        owner: string;
        repo: string;
        name: string;
        color: string;
        description: string;
      }): Promise<unknown>;
      addLabels(params: {
        owner: string;
        repo: string;
        issue_number: number;
        labels: string[];
      }): Promise<{ data: Array<{ name: string }> }>;
      removeLabel(params: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }): Promise<unknown>;
      listLabelsOnIssue(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
      }): Promise<{ data: Array<{ name: string }> }>;
    };
  };
}

/** Label configuration: name → { color (hex without #), description }. */
const REVIEW_LABEL_CONFIG: Record<string, { color: string; description: string }> = {
  [LABEL_NEEDS_CHANGES]: {
    color: "b60205", // red
    description: "Reviewer bot has requested changes on this PR",
  },
  [LABEL_BOT_APPROVED]: {
    color: "0e8a16", // green
    description: "Reviewer bot has approved this PR",
  },
  [LABEL_BOT_COMMENTED]: {
    color: "0075ca", // blue
    description: "Reviewer bot has commented on this PR (informational)",
  },
};

/**
 * Idempotently ensure all review-state labels exist in the repo.
 * Creates any labels that are missing; skips existing ones.
 * Logs warnings for any individual failures but does not throw.
 */
export async function ensureReviewStateLabelsExist(
  octokit: OctokitReviewLabelClient,
  owner: string,
  repo: string
): Promise<void> {
  for (const labelName of REVIEW_STATE_LABELS) {
    try {
      // Check whether the label already exists
      try {
        await octokit.rest.issues.getLabel({ owner, repo, name: labelName });
        log.debug(`Review-state label already exists: ${labelName}`);
        continue;
      } catch (error: unknown) {
        const httpError = error as { status?: number };
        if (httpError.status !== 404) {
          throw error;
        }
        // 404 → label does not exist yet, fall through to creation
      }

      const cfg = REVIEW_LABEL_CONFIG[labelName];
      if (!cfg) continue;
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name: labelName,
        color: cfg.color,
        description: cfg.description,
      });
      log.debug(`Created review-state label: ${labelName}`);
    } catch (error) {
      log.warn(`Failed to ensure review-state label "${labelName}": ${getErrorMessage(error)}`);
    }
  }
}

/**
 * Apply the review-state label corresponding to the given review event.
 *
 * - Ensures all review-state labels exist in the repo (bootstrap).
 * - Adds the label for the review event.
 * - Removes any conflicting labels (e.g., applying `review:bot-approved`
 *   removes `review:needs-changes`).
 * - Idempotent: if the label is already present, no spurious GitHub activity.
 *   When listLabelsOnIssue fails (degraded read), removals are attempted
 *   unconditionally (best-effort) to preserve exclusivity.
 *
 * Failures are logged but not thrown — callers should treat this as best-effort.
 */
export async function applyReviewStateLabel(
  octokit: OctokitReviewLabelClient,
  owner: string,
  repo: string,
  prNumber: number,
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"
): Promise<void> {
  // Bootstrap: ensure labels exist before applying
  await ensureReviewStateLabelsExist(octokit, owner, repo);

  const targetLabel = reviewEventToLabel(event);
  const toRemove = conflictingLabels(event);

  // Fetch ALL current labels on the PR (paginated) to enable idempotency checks.
  // Uses paginate to handle PRs with >30 labels (GitHub's default page size).
  let currentLabelNames: Set<string> | null;
  try {
    const allLabels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    currentLabelNames = new Set(allLabels.map((l) => l.name));
  } catch (error) {
    log.warn(
      `Failed to list labels on PR #${prNumber}: ${getErrorMessage(error)}. ` +
        `Proceeding without idempotency check; removals will be attempted unconditionally.`
    );
    currentLabelNames = null;
  }

  // Add the target label.
  // Idempotent when the read succeeded: skip if the label is already present.
  // When the read failed (null), attempt the add (GitHub will no-op if already present).
  if (currentLabelNames === null || !currentLabelNames.has(targetLabel)) {
    try {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: [targetLabel],
      });
      log.debug(`Added review-state label "${targetLabel}" to PR #${prNumber}`);
    } catch (error) {
      log.warn(
        `Failed to add review-state label "${targetLabel}" to PR #${prNumber}: ` +
          `${getErrorMessage(error)}`
      );
    }
  } else {
    log.debug(`Review-state label "${targetLabel}" already on PR #${prNumber}; skipping add`);
  }

  // Remove conflicting labels.
  // When the read succeeded: skip labels that are not present (idempotent).
  // When the read failed (null): attempt ALL removals unconditionally so that
  // conflicting labels are not left co-resident with the newly added label.
  // Each removal is wrapped in its own try/catch so one failure does not abort the rest.
  for (const labelName of toRemove) {
    if (currentLabelNames !== null && !currentLabelNames.has(labelName)) {
      log.debug(`Conflicting label "${labelName}" not on PR #${prNumber}; skipping remove`);
      continue;
    }
    try {
      await octokit.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: prNumber,
        name: labelName,
      });
      log.debug(`Removed conflicting label "${labelName}" from PR #${prNumber}`);
    } catch (error) {
      log.warn(
        `Failed to remove conflicting label "${labelName}" from PR #${prNumber}: ` +
          `${getErrorMessage(error)}`
      );
    }
  }
}
