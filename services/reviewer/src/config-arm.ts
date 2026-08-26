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
 * With `EXPERIMENT_MODEL_ENV_VAR` unset — the state this ships in — every PR
 * resolves to the incumbent and the reviewer behaves exactly as it did before
 * this module existed. Starting an experiment is setting one env var; ending
 * one is unsetting it. Neither is a code change.
 *
 * ## A candidate from the wrong vendor is refused, not honoured
 *
 * `REVIEWER_PROVIDER` selects which client is constructed; `REVIEWER_MODEL`
 * names a model that client can call. Before this module there was one model
 * per provider and no way to misalign them. An experiment var makes it easy —
 * setting a `gpt-` model while the provider is `google` would send half of all
 * reviews to the Google client with an OpenAI model string, failing every one
 * of them. So a candidate that plainly belongs to another vendor is refused
 * and the incumbent is kept, with the refusal surfaced as an `error`-level log
 * by the caller.
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

/**
 * Model-name prefixes that identify a vendor, used ONLY to detect a candidate
 * belonging to a provider other than the configured one.
 *
 * This is a denylist of foreign families, not an allowlist of valid models,
 * and the asymmetry is deliberate. An allowlist would reject a new model
 * family the day it ships — blocking a legitimate experiment on a name nobody
 * has added here yet — while a foreign-family check rejects only the
 * misconfiguration that is actually reachable: pointing the arm at a model the
 * configured client cannot call at all. Unrecognized names pass through,
 * because a name this file does not know is far more likely to be a new model
 * than a cross-vendor mistake.
 */
const PROVIDER_MODEL_PREFIXES: Record<ReviewerConfig["provider"], readonly string[]> = {
  openai: ["gpt-", "o1", "o3", "o4"],
  google: ["gemini-"],
  anthropic: ["claude-"],
};

/**
 * The provider a model name plainly belongs to, when that is NOT the
 * configured one. `null` means "no conflict detected" — either it matches the
 * configured provider's family, or it matches nothing known.
 */
export function foreignProviderFor(
  model: string,
  provider: ReviewerConfig["provider"]
): ReviewerConfig["provider"] | null {
  const normalized = model.trim().toLowerCase();
  for (const [candidate, prefixes] of Object.entries(PROVIDER_MODEL_PREFIXES) as Array<
    [ReviewerConfig["provider"], readonly string[]]
  >) {
    if (candidate === provider) continue;
    if (prefixes.some((prefix) => normalized.startsWith(prefix))) return candidate;
  }
  return null;
}

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
  /**
   * Set when a candidate was configured but refused because it belongs to a
   * different vendor than the configured provider. The assignment falls back
   * to the incumbent; this field is what stops that from being silent.
   *
   * Returned rather than logged here so `assignArm` stays a pure function of
   * its arguments — `runReview` owns the logging, as it does for every other
   * decision on this path.
   */
  rejectedCandidate?: {
    model: string;
    foreignProvider: ReviewerConfig["provider"];
  };
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
  config: Pick<ReviewerConfig, "provider" | "providerModel">,
  env: Record<string, string | undefined> = process.env
): ArmAssignment {
  const candidateModel = (env[EXPERIMENT_MODEL_ENV_VAR] ?? "").trim();

  if (candidateModel === "") {
    return { arm: "incumbent", model: config.providerModel, experimentActive: false };
  }

  // A candidate from a different vendor cannot be called by the configured
  // client at all, so honouring it would fail every even-numbered PR's review.
  // Refuse the swap and keep the incumbent: this runs on the review path, and
  // an experiment that quietly does not start is a far better outcome than
  // half of production review traffic erroring.
  //
  // Deliberately NOT a boot-time throw (the reviewer's alternative suggestion):
  // this env var is read per call, not at `loadConfig`, so boot validation
  // would miss a value changed on a running service — while a bad value would
  // take the whole reviewer down rather than degrading one arm. The caller
  // logs `rejectedCandidate`, so this is refused loudly rather than silently.
  const foreignProvider = foreignProviderFor(candidateModel, config.provider);
  if (foreignProvider !== null) {
    return {
      arm: "incumbent",
      model: config.providerModel,
      experimentActive: true,
      rejectedCandidate: { model: candidateModel, foreignProvider },
    };
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
