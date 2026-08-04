/**
 * Config resolution for the Rung-3 confirm stage (mt#3652).
 *
 * Kept separate from `llm-confirm.ts` for the same reason
 * `embedding-nomination-factory.ts` is separate from its primitive: the
 * scoring/confirm logic stays importable — and unit-testable — without the
 * configuration and provider-factory machinery. Consumers that need a live
 * service call `resolveConfirmDeps`; tests inject `ConfirmDeps` directly.
 */

// The completion-service factory and the configuration system are
// tsyringe-decorated, so importing this module drags in a reflect polyfill
// requirement. Importing it HERE keeps the requirement with the module that
// creates it — the same lesson `embedding-nomination-factory.ts` records from
// when the scanner first took this dependency and broke the replay harness at
// import time.
import "reflect-metadata";

import { createCompletionService } from "../ai/service-factory";
import { getConfiguration } from "../configuration";
import type { ConfirmDeps } from "./llm-confirm";

/**
 * Resolve the completion service from config.
 *
 * Returns `null` when no usable provider is configured — the caller treats
 * that exactly like any other degraded path (fall back to the pre-confirm
 * behavior, still inject Rung-1 findings, log the marker). Never throws: a
 * provider that cannot be constructed is a degradation, not a hook crash.
 */
export async function resolveConfirmDeps(): Promise<ConfirmDeps | null> {
  try {
    const config = await getConfiguration();
    return { completionService: createCompletionService(config) };
  } catch (error) {
    // intentional-swallow: an unconfigured or unconstructable provider is a
    // degraded confirm path, not a hook failure. The caller converts `null`
    // into a `provider-unconfigured` degraded result and keeps its Rung-1
    // behavior, per ADR-024's fail-to-Rung-1 invariant.
    void error;
    return null;
  }
}
