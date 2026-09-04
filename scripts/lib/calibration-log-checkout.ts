/**
 * Which checkout a calibration-log path belongs to — mt#4971, PR #3624 R1.
 *
 * ## The coupling this preserves, and the one it cannot
 *
 * Before mt#4748 a calibration log lived at `<checkout>/.minsky/<name>-calibration.jsonl`, so the
 * path ENCODED its checkout. Two replay harnesses relied on that: passing `--calibration-log
 * <other-checkout>/.minsky/…` (or `--log`) steered TRANSCRIPT selection to that same checkout,
 * because Claude Code's per-project transcript directory is derived from the checkout path.
 *
 * A state-dir path cannot carry that. `projects/<key>/` is `sha256(repoRoot).slice(0,16)` — a
 * ONE-WAY hash, so the checkout is not recoverable from it by any means, not merely inconvenient
 * to recover. `dirname(dirname(…))` on a state-dir path yields `<state dir>`, which is not a
 * checkout at all.
 *
 * So this module does the only two honest things available:
 *
 *  - **Legacy shape → preserve the coupling.** A path whose parent directory is literally
 *    `.minsky` still yields its checkout, so anyone passing a pre-migration path (an archive, a
 *    peer's working tree) keeps the old behaviour exactly.
 *  - **State-dir shape → return null, and let the caller SAY so.** The caller falls back to its
 *    own checkout and warns. PR #3624 R1's finding was the word "silent": falling back is
 *    defensible, doing it without telling the operator their `--log` did not steer transcripts is
 *    not.
 *
 * Deriving nothing and staying quiet was the shipped-then-flagged behaviour. Deriving from the
 * state-dir path would be worse — it produces a confident wrong answer (`<state dir>`) rather
 * than an admission.
 */

import { basename, dirname } from "node:path";

/** The directory name the pre-mt#4748 layout put a calibration log in. */
export const LEGACY_LOG_DIRNAME = ".minsky";

/**
 * The checkout `logPath` belongs to, or `null` when the path cannot name one.
 *
 * Returns non-null ONLY for the legacy `<checkout>/.minsky/<file>` shape. Every other shape —
 * a state-dir path, a bare filename, a path in an unrelated directory — returns `null`, which
 * the caller is expected to render as a fallback plus a notice rather than as an answer.
 */
export function checkoutForLegacyLogPath(logPath: string): string | null {
  const parent = dirname(logPath);
  if (basename(parent) !== LEGACY_LOG_DIRNAME) return null;
  const checkout = dirname(parent);
  // `dirname` of a root-level `.minsky` degenerates to "/" or "."; neither is a checkout.
  if (checkout === "" || checkout === "/" || checkout === ".") return null;
  return checkout;
}

/**
 * The one-line notice a caller emits when an explicit log path could not name a checkout.
 *
 * Shared so both harnesses say the same thing — the finding was that the behaviour change was
 * invisible, and two differently-worded notices would be a weaker fix than one.
 */
export function transcriptRootFallbackNotice(logPath: string, fallbackRoot: string): string {
  return (
    `NOTE: transcript selection is using ${fallbackRoot}, not a checkout derived from ` +
    `${logPath}.\n` +
    `      Since mt#4748 a calibration log lives under the state dir keyed by a one-way hash of ` +
    `its checkout,\n` +
    `      so the checkout cannot be recovered from the path. Pass the transcript-dir flag to ` +
    `select another checkout's transcripts.`
  );
}
