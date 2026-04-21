/**
 * Authorship PR Labels
 *
 * Utilities for creating and applying authorship tier labels to GitHub PRs.
 * Labels are idempotently created on-demand, then applied to PRs as part of
 * the `session_pr_create` flow.
 *
 * @see mt#924 — Phase 2: authorship labels on PRs
 */

import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { AuthorshipTier } from "./types";

// ── Merge trailer types ─────────────────────────────────────────────────────

/**
 * Identity information used to build git merge trailers.
 */
export interface MergeIdentity {
  login: string;
  email: string;
}

/**
 * Build git trailer strings to append to a merge commit message, based on authorship tier.
 *
 * - Tier 1 (HUMAN_AUTHORED): `Assisted-by: {bot}` — bot assisted, human drove
 * - Tier 2 (CO_AUTHORED):    `Co-Authored-By: {bot}` — equal contribution
 * - Tier 3 (AGENT_AUTHORED): `Co-Authored-By: {human}\nApproved-by: {human}` — agent drove, human approved
 *
 * @returns A string starting with `\n\n` ready to append to a commit message, or `""` if inputs
 *          are insufficient to produce any trailers.
 */
export function buildMergeTrailers(
  tier: AuthorshipTier,
  botIdentity: MergeIdentity | null,
  humanIdentity: MergeIdentity | null
): string {
  switch (tier) {
    case AuthorshipTier.HUMAN_AUTHORED: {
      if (!botIdentity) return "";
      return `\n\nAssisted-by: ${botIdentity.login} <${botIdentity.email}>`;
    }
    case AuthorshipTier.CO_AUTHORED: {
      if (!botIdentity) return "";
      return `\n\nCo-Authored-By: ${botIdentity.login} <${botIdentity.email}>`;
    }
    case AuthorshipTier.AGENT_AUTHORED: {
      if (!humanIdentity) return "";
      return (
        `\n\nCo-Authored-By: ${humanIdentity.login} <${humanIdentity.email}>` +
        `\nApproved-by: ${humanIdentity.login} <${humanIdentity.email}>`
      );
    }
  }
}

// ── Label name constants ────────────────────────────────────────────────────

export const LABEL_HUMAN_AUTHORED = "authorship/human-authored";
export const LABEL_CO_AUTHORED = "authorship/co-authored";
export const LABEL_AGENT_AUTHORED = "authorship/agent-authored";

/** All three authorship label names. */
export const AUTHORSHIP_LABELS = [
  LABEL_HUMAN_AUTHORED,
  LABEL_CO_AUTHORED,
  LABEL_AGENT_AUTHORED,
] as const;

/** Maps an AuthorshipTier value to the corresponding GitHub label name. */
export function tierToLabel(tier: AuthorshipTier): string {
  switch (tier) {
    case AuthorshipTier.HUMAN_AUTHORED:
      return LABEL_HUMAN_AUTHORED;
    case AuthorshipTier.CO_AUTHORED:
      return LABEL_CO_AUTHORED;
    case AuthorshipTier.AGENT_AUTHORED:
      return LABEL_AGENT_AUTHORED;
  }
}

// ── Octokit interface (minimal surface for label ops) ───────────────────────

interface OctokitLabelClient {
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
      }): Promise<unknown>;
    };
  };
}

/** Label configuration: name → { color, description }. */
const LABEL_CONFIG: Record<string, { color: string; description: string }> = {
  [LABEL_HUMAN_AUTHORED]: {
    color: "0e8a16", // green
    description: "Authored primarily by a human",
  },
  [LABEL_CO_AUTHORED]: {
    color: "0052cc", // blue
    description: "Co-authored by human and AI agent",
  },
  [LABEL_AGENT_AUTHORED]: {
    color: "5319e7", // purple
    description: "Authored primarily by an AI agent",
  },
};

/**
 * Idempotently ensure all three authorship labels exist in the repo.
 * Creates any labels that are missing; skips existing ones.
 */
export async function ensureAuthorshipLabelsExist(
  octokit: OctokitLabelClient,
  owner: string,
  repo: string
): Promise<void> {
  for (const labelName of AUTHORSHIP_LABELS) {
    try {
      // Check whether the label already exists
      try {
        await octokit.rest.issues.getLabel({ owner, repo, name: labelName });
        log.debug(`Authorship label already exists: ${labelName}`);
        continue;
      } catch (error: unknown) {
        const httpError = error as { status?: number };
        if (httpError.status !== 404) {
          throw error;
        }
        // 404 → label does not exist yet, fall through to creation
      }

      const cfg = LABEL_CONFIG[labelName];
      if (!cfg) continue;
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name: labelName,
        color: cfg.color,
        description: cfg.description,
      });
      log.debug(`Created authorship label: ${labelName}`);
    } catch (error) {
      log.warn(`Failed to ensure authorship label "${labelName}": ${getErrorMessage(error)}`);
    }
  }
}

/**
 * Add the authorship tier label to a GitHub PR (issue).
 * Assumes `ensureAuthorshipLabelsExist` has already been called.
 */
export async function addAuthorshipLabel(
  octokit: OctokitLabelClient,
  owner: string,
  repo: string,
  prNumber: number,
  tier: AuthorshipTier
): Promise<void> {
  const labelName = tierToLabel(tier);
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: prNumber,
    labels: [labelName],
  });
  log.debug(`Added authorship label "${labelName}" to PR #${prNumber}`);
}
