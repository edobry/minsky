/**
 * pr-watch domain module barrel export.
 *
 * Exports the public API of the PR-state watcher schema, persistence layer,
 * and the reconciler/watcher loop. Consumers depend on these exports; the
 * concrete Drizzle implementation is wired at composition time via tsyringe.
 */

export type { PrWatch, PrWatchEvent } from "./types";
export type { CreatePrWatchInput, PrWatchRepository } from "./repository";
export { DrizzlePrWatchRepository, FakePrWatchRepository } from "./repository";

// Watcher
export type {
  GithubPr,
  GithubPrReview,
  GithubCheckRun,
  GithubPrClient,
  PrWatchOutcome,
  WatcherResult,
} from "./watcher";
export { runWatcher, stubGithubPrClient } from "./watcher";
