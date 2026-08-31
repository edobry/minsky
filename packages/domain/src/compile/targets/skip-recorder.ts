/**
 * Tee a compile target's skip sink into a collected list, so the REASON survives to the
 * result (mt#3119).
 *
 * ## Why this exists
 *
 * Every skip site in every target already builds a human-readable message and hands it to a
 * `SkipLogFn`, whose default routes to `log.warn`. ADR-016 calls that the "warn-on-skip
 * discipline … never swallow a skipped source silently" (mt#2182), and the targets implement
 * it faithfully. The message is nonetheless invisible on the CLI:
 *
 *   `log.warn` -> `emitDiagnostic` -> returns early when `diagnosticSink === "discard"`
 *   -> `resolveDiagnosticSink` returns `"discard"` for `oneShotCommand`
 *   -> `src/cli.ts` calls `setProcessRole("one-shot-command")`
 *
 * So the discipline is satisfied by the target and defeated by the layer beneath it. Three
 * live occurrences: a rule dropped for a missing `description` (2026-07-23), a 90-byte
 * `CLAUDE.md` from the same cause (2026-08-29), and an unparseable skill source that left the
 * compiled output byte-identical while `compile` exited 0 (2026-08-30, mt#4698).
 *
 * ## Why the result and not the sink
 *
 * Re-pointing the default sink at `log.cli` would fix the CLI and break a stdio-transport MCP
 * process, whose stdout is the protocol channel. Passing a sink in from each caller works but
 * makes visibility depend on every caller remembering — the same failure mode in a new place.
 * Carrying the reasons on `MinskyCompileResult.skipReasons` lets each renderer decide, and a
 * renderer that prints nothing still leaves `definitionsSkipped` populated.
 *
 * This wrapper does NOT redirect anything: the caller's sink fires exactly as before.
 */
import { log } from "../../utils/logger";

export type SkipRecorder = {
  /** Drop-in replacement for the target's `onSkip` — records, then forwards. */
  record: (message: string) => void;
  /** Live array of every message recorded so far. Read it after the skip loop. */
  reasons: string[];
};

/**
 * `onSkip` is OPTIONAL because several targets declare it as an optional factory field and
 * rely on the callee's own `onSkip: SkipLogFn = defaultSkipLog` default. Passing an
 * always-defined wrapper down would suppress that default and lose the warn entirely — so the
 * wrapper reproduces it here rather than forwarding `undefined`. Behaviour is unchanged when
 * a sink IS supplied.
 */
export function createSkipRecorder(onSkip?: (message: string) => void): SkipRecorder {
  const sink = onSkip ?? ((message: string) => log.warn(message));
  const reasons: string[] = [];
  return {
    record: (message: string) => {
      reasons.push(message);
      sink(message);
    },
    reasons,
  };
}
