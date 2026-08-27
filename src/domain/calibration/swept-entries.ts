/**
 * Swept-entries resolution (mt#3716 — ADR-028 §D4), extracted from the
 * `observability.calibration-review` command adapter (mt#4009) so the cockpit
 * interceptor-aggregates refresh sweeps the SAME derived entry set instead of
 * minting a second one — reintroducing the static-registry-only gap mt#3716
 * closed (16 logs reported while 25 existed) on a new surface.
 *
 * Build the entries to sweep, DERIVED from the three declaration surfaces
 * (`GUARD_REGISTRY.calibrationLog`, `STANDALONE_GUARD_CANARIES.calibrationLog`,
 * the enumerated non-guard producers) when reachable, falling back to the
 * static `CALIBRATION_LOG_REGISTRY` alone otherwise.
 *
 * This module lives in `src/` (bundled into the deployed MCP server), which by
 * established convention does not statically import `.minsky/hooks/registry.ts`
 * — see `calibration-sweep.ts`'s `CALIBRATION_NAME_TO_GUARD_NAME` doc comment
 * and `src/mcp/guard-health-tracker.ts`'s header comment, both of which
 * duplicate-over-cross-import for the same reason (the hooks tree is a
 * dependency-free tree with no established precedent for `src/` reaching into
 * it). But every caller of this function runs inside a git checkout of this
 * repo in practice (both consumers already read/write repo-relative `.minsky/`
 * paths), so the declaration-surface source files are present on disk wherever
 * it runs.
 *
 * Resolved via a RUNTIME dynamic import with a non-literal specifier (built
 * from path segments rather than one string literal) so it is not eagerly
 * inlined into the `dist/minsky.js` bundle graph, wrapped in try/catch so a
 * context where the source tree is unavailable (or the import otherwise
 * fails) degrades gracefully to the pre-mt#3716 behavior — the static
 * registry alone — rather than breaking the caller.
 */
import { log } from "@minsky/shared/logger";
import {
  CALIBRATION_LOG_REGISTRY,
  deriveCalibrationLogEntries,
  type CalibrationLogEntry,
} from "./calibration-sweep";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

export async function buildSweptEntries(): Promise<CalibrationLogEntry[]> {
  try {
    const specifier = ["..", "..", "..", "scripts", "lib", "calibration-log-declarations"].join(
      "/"
    );
    const mod = (await import(specifier)) as {
      getDeclaredCalibrationLogNames: () => string[];
    };
    return deriveCalibrationLogEntries(
      mod.getDeclaredCalibrationLogNames(),
      CALIBRATION_LOG_REGISTRY
    );
  } catch (err) {
    // mt#3716 PR #2822 review: a silent catch here would hide a genuine
    // regression (e.g. the declaration module moved) behind the SAME output
    // shape as the legitimate degraded-context case (a deployed bundle with
    // no source tree on disk) — logging makes the fallback observable
    // without changing the fail-open behavior itself, since calibration
    // review must never hard-fail on this.
    log.warn(
      "[calibration] falling back to static CALIBRATION_LOG_REGISTRY — could not load the " +
        "shared declaration accessor (scripts/lib/calibration-log-declarations)",
      { error: getLoggableErrorSummary(err) }
    );
    return CALIBRATION_LOG_REGISTRY;
  }
}
