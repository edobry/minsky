/**
 * Per-PR configuration-arm assignment (mt#4569).
 *
 * mt#4556 stamps a `config_fingerprint` on every `review_timing` row, which
 * names WHICH configuration a review ran under. It does not make two
 * fingerprints comparable. Under a global flip — the only way to change the
 * reviewer's model today, since `REVIEWER_MODEL` is read once in `loadConfig`
 * — every review before the deploy carries fingerprint A and every review
 * after carries fingerprint B. The fingerprint cohort is then exactly the time
 * cohort, so splitting on it retains the whole confound while looking like a
 * controlled comparison.
 *
 * This module supplies the missing half: an assignment rule that puts both
 * arms in the same window, so a cohort query needs no time predicate at all.
 *
 * ## The unit is the PR, not the review
 *
 * mt#4553 scores every lever on **$/converged-PR and rounds-to-convergence**.
 * A PR is reviewed once per push — a measured mean of 1.94 rounds, up to 13 —
 * so assigning per REVIEW would put round 1 of a PR in one arm and round 2 in
 * the other. At that mean it is the median PR, not an edge case, and it
 * destroys the denominator the comparison exists to produce. Assignment is
 * therefore keyed on the PR number, which every round of a PR shares.
 *
 * ## Why parity rather than a coin flip
 *
 * Each review round is a separate process invocation: a webhook arrives, a
 * worker runs, the process moves on. A random draw would have to be persisted
 * and re-read to keep a PR's later rounds in the arm its first round drew, and
 * that store would then be one more thing that can disagree with the row it is
 * supposed to explain. Parity needs no storage — it is recomputed identically
 * on every round, in every process, forever, from a number the review already
 * carries.
 *
 * The cost is that assignment is deterministic rather than random, so a
 * systematic difference between even- and odd-numbered PRs would bias the
 * comparison. PR numbers are allocated by GitHub in arrival order across every
 * author and every kind of work, so parity is uncorrelated with anything about
 * a PR's content — which is the property randomization is wanted for.
 *
 * ## Inert until configured
 *
 * With `REVIEWER_EXPERIMENT_MODEL` unset — the state this ships in — every PR
 * resolves to the incumbent and the reviewer behaves exactly as it did before
 * this module existed. Starting an experiment is setting one env var; ending
 * one is unsetting it. Neither is a code change.
 *
 * ## Where the arm gets recorded
 *
 * Nowhere in this module. `runReview` substitutes the returned config at its
 * entry point, so the model call, `review_timing.model`, and
 * `fingerprintForReview` all read the arm's config through the channel they
 * already read. The arm is recoverable from a row that was written by code
 * that never knew an experiment was running.
 */

import { REVIEWER_CALLTIME_ENV_VAR_NAMES, type ReviewerConfig } from "./config";

/** The candidate model under test, or the incumbent that has always run. */
export type ArmName = "incumbent" | "candidate";

/**
 * The env var naming the candidate model. Unset means no experiment is
 * running and every PR is served by the incumbent.
 *
 * Re-exported from `config.ts` rather than restated: that file's
 * `REVIEWER_CALLTIME_ENV_VAR_NAMES` is where its docblock promises an operator
 * will find every reviewer env var not bound through `ReviewerConfig`, so a
 * second spelling here could drift out of the one place people look.
 */
export const EXPERIMENT_MODEL_ENV_VAR = REVIEWER_CALLTIME_ENV_VAR_NAMES.EXPERIMENT_MODEL;

export interface ArmAssignment {
  arm: ArmName;
  /** The model this PR's reviews should use. */
  model: string;
  /**
   * Whether an experiment is configured at all. False means `arm` is
   * `incumbent` for every PR — not that this particular PR drew the incumbent.
   * The two are worth telling apart in a log line.
   */
  experimentActive: boolean;
}

/**
 * Decide which arm a PR belongs to.
 *
 * Even PR numbers take the candidate, odd take the incumbent. Which side of
 * the parity gets which arm is arbitrary and fixed here rather than
 * configurable: a knob for it would let two deploys disagree about what an
 * already-written row meant.
 *
 * A non-integer or negative `prNumber` cannot be a real PR number. It resolves
 * to the incumbent rather than throwing, because this sits on the review path
 * and a review that runs on the incumbent is strictly better than a review
 * that does not run.
 */
export function assignArm(
  prNumber: number,
  config: Pick<ReviewerConfig, "providerModel">,
  env: Record<string, string | undefined> = process.env
): ArmAssignment {
  const candidateModel = (env[EXPERIMENT_MODEL_ENV_VAR] ?? "").trim();

  if (candidateModel === "") {
    return { arm: "incumbent", model: config.providerModel, experimentActive: false };
  }

  if (!Number.isInteger(prNumber) || prNumber < 0) {
    return { arm: "incumbent", model: config.providerModel, experimentActive: true };
  }

  return prNumber % 2 === 0
    ? { arm: "candidate", model: candidateModel, experimentActive: true }
    : { arm: "incumbent", model: config.providerModel, experimentActive: true };
}

/**
 * The config a given PR's reviews should run under.
 *
 * Returns the SAME object reference when no substitution applies, so the
 * no-experiment path allocates nothing and a caller can tell by identity that
 * this module did not intervene.
 */
export function applyArmToConfig(
  config: ReviewerConfig,
  prNumber: number,
  env: Record<string, string | undefined> = process.env
): ReviewerConfig {
  const assignment = assignArm(prNumber, config, env);

  if (assignment.model === config.providerModel) {
    return config;
  }

  return { ...config, providerModel: assignment.model };
}
