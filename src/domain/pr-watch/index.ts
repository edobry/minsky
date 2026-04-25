/**
 * pr-watch domain module barrel export.
 *
 * Exports the public API of the PR-state watcher schema + persistence layer.
 * Consumers depend on these exports; the concrete Drizzle implementation is
 * wired at composition time via tsyringe.
 */

export type { PrWatch, PrWatchEvent } from "./types";
export type { CreatePrWatchInput, PrWatchRepository } from "./repository";
export { DrizzlePrWatchRepository, FakePrWatchRepository } from "./repository";
