// Calibration surface: a diff REMOVES a signal a consumer depended on, and the PR
// never names what consumed it (mt#4493).
//
// `work-completion.mdc §Invocation path required for event/poll mechanisms` names three
// ways an event/poll mechanism fails silently. Two describe a mechanism that was ADDED
// and never invoked, and both are findable by asking "who calls this?". The third is the
// inverse: **an existing invoker is deleted**. Nothing new is uninvoked, so there is no
// missing caller to grep for — a process exit, an emitted event, a closed connection is
// rarely only cleanup, and something downstream is usually watching for it.
//
// ## What this checks, and what it deliberately does not
//
// NOT "is the removal correct" — often it is. The check is narrower and answerable:
// **did the PR name what consumed the removed signal?** Absence of the account is the
// finding; the removal itself never is.
//
// ## Why a merge-time surface rather than a prompt-time detector
//
// ADR-042's principle — a backstop fires where its structured trace first exists. The
// removal first exists in a commit; the consumer account first exists in a PR body.
// PR-time is the earliest point at which BOTH halves exist, which is what selects the
// seam rather than a preference. It also means this never competes with a per-invocation
// prompt budget, so mt#4192's open cost question about reading a branch diff at
// `UserPromptSubmit` does not apply here and must not be inherited.
//
// ADR-031 was considered and does not govern: all four of its sub-operations take the
// agent's just-completed TURN as their subject, and this surface's subject is a diff.
// Its sub-operation (4) WOULD bind if this ever injected turn-scoped guidance; it does
// not — a merge gate speaks to the PR.
//
// ## Why both halves escape ADR-024's ladder
//
// ADR-024 scopes its rung ladder to detectors matching paraphrasable natural language in
// the agent's own output, where answering each miss with another regex family is the
// named anti-pattern. Neither half of this check is on that axis:
//
//   - The TRIGGER is a closed set of identifiers in source (`process.exit(`, `.emit(`, …).
//   - The ACCOUNTING is a literal `Consumer account:` marker the author writes
//     deliberately — the same shape as the shipped `Execution evidence:` (mt#1459) and
//     `Deploy verification:` (mt#2353) merge markers.
//
// The alternative — scanning PR prose for a consumer NAME — is exactly the arms race
// ADR-024 exists to end, and was rejected at planning for that reason.
//
// ## Measured before building (mt#4493 planning)
//
// 11 commits in the 90 days to 2026-08-25 actually remove one of these calls from
// `src/` / `packages/` / `cockpit-tray/` — about one per 8 days, clustering in daemon,
// staleness and disconnect code, which is where the originating incident sat. That rate
// is what makes calibration viable: enough to accumulate a window, not enough to be noise.
//
// Log-only per the mt#2263 / ADR-024 calibration ladder. This surface NEVER denies.
//
// @see mt#4493 — this surface; mt#3025 — the originating incident (a DESIGN, which a
//      diff-anchored check cannot reach; the prose bullet covers that case and this
//      does not)
// @see .minsky/hooks/test-first-evidence.ts — the sibling surface this mirrors

import { captureArtifact, CAPTURE_SCHEMA_VERSION } from "./judged-input-capture";
import type { ArtifactCapture } from "./judged-input-capture";
import { computeFenceInternalLines } from "./markdown-sections";
// `safeTruncate`, not `slice`: the captured line is arbitrary SOURCE, which routinely
// carries non-ASCII inside string literals and comments, so a raw cut can split a
// surrogate pair (`custom/no-unsafe-string-truncation`).
import { safeTruncate } from "@minsky/shared/safe-truncate";

/**
 * One removed signal-producing call, as found in a unified-diff patch.
 */
export interface RemovedSignal {
  /** The file the removal was found in. */
  filename: string;
  /** Which pattern matched — the calibration log's discriminator. */
  kind: SignalKind;
  /** The removed source line, trimmed and capped. */
  line: string;
}

export type SignalKind = "process-exit" | "event-emit" | "connection-close" | "state-write";

/** Cap on a captured line, so one minified file cannot bloat the log. */
const LINE_CAP = 200;

/**
 * The closed token set. Each entry is an identifier in SOURCE, not a paraphrasable
 * phrase — which is what keeps this half off ADR-024's ladder.
 *
 * Deliberately NOT included, each for a stated reason:
 *   - a bare `return` / `throw` — control flow, not a signal another party observes.
 *   - `console.*` — read by humans, not by a supervisor with a trigger.
 *   - `clearInterval` / `clearTimeout` — stopping your OWN timer signals nobody else.
 * Widening this set is a deliberate edit and wants its own measured window.
 */
export const SIGNAL_CALL_PATTERNS: ReadonlyArray<{ kind: SignalKind; re: RegExp }> = [
  // A supervised process exiting IS the supervisor's trigger — the originating shape.
  { kind: "process-exit", re: /\bprocess\.exit\s*\(/ },
  // An emitted event has, by construction, a listener somewhere.
  {
    kind: "event-emit",
    re: /\.(?:emit|tryEmit)\s*\(|\brecordDisconnect\s*\(|\bsendLoggingMessage\s*\(/,
  },
  // A closed listener/connection is observable by whoever polls or holds the other end.
  { kind: "connection-close", re: /\.(?:close|unlisten|unwatch|unsubscribe)\s*\(/ },
  // A state file another process reads is a signal with a slower clock.
  { kind: "state-write", re: /local-mcp\.json|[\w-]+-state\.json/ },
];

/**
 * Roots this surface scans, per SC1.
 *
 * `scripts/` is deliberately OUT. A one-shot script exits to set its own status code —
 * nothing supervises it and nothing is watching for the exit, so a removal there carries
 * no consumer to account for. That is the spec's AT2 case, and scoping is what makes it a
 * clean non-fire rather than a false positive to be measured away later.
 */
const IN_SCOPE_ROOT_RE = /^(?:src|packages|cockpit-tray)\//;

/** Paths whose removals carry no supervisory meaning. */
const EXCLUDED_PATH_RE = /(?:^|\/)(?:__tests__|__mocks__|fixtures)\//;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * True when at least one changed file sits in a scanned root.
 *
 * A cheap prefilter over the file list the caller ALREADY has, so the extra patch fetch
 * happens only on a PR that could possibly fire. Most PRs touching only docs, rules or
 * tests skip the network call entirely — which is the bounded-form discipline mt#4192 asks
 * for, applied where the budget is generous rather than where it is tight.
 */
export function hasInScopeFiles(filenames: string[]): boolean {
  return filenames.some(
    (f) => IN_SCOPE_ROOT_RE.test(f) && !TEST_FILE_RE.test(f) && !EXCLUDED_PATH_RE.test(f)
  );
}

/** A PR file plus its unified-diff patch, as GitHub's files endpoint returns it. */
export interface PrFilePatch {
  filename: string;
  /** GitHub omits `patch` for binary and very large files — absence is not emptiness. */
  patch?: string | null;
}

/**
 * Removed signal-producing calls across a PR's patches.
 *
 * Reads only REMOVAL lines (`-` at column 0, excluding the `---` file header), so a call
 * that was merely MOVED still appears — and correctly so: this surface asks whether the
 * PR accounted for the consumer, and a move across files is exactly the case where the
 * account is worth writing down. Deduplicated per (file, kind) so one refactor touching
 * twelve call sites produces one finding rather than twelve.
 */
export function findRemovedSignalCalls(patches: PrFilePatch[]): RemovedSignal[] {
  const found: RemovedSignal[] = [];
  const seen = new Set<string>();

  for (const file of patches) {
    if (typeof file.patch !== "string" || file.patch.length === 0) continue;
    if (!IN_SCOPE_ROOT_RE.test(file.filename)) continue;
    if (TEST_FILE_RE.test(file.filename) || EXCLUDED_PATH_RE.test(file.filename)) continue;

    for (const raw of file.patch.split("\n")) {
      // `---` is the unified-diff file header, not a removed line.
      if (!raw.startsWith("-") || raw.startsWith("---")) continue;
      const line = raw.slice(1);

      for (const { kind, re } of SIGNAL_CALL_PATTERNS) {
        if (!re.test(line)) continue;
        const key = `${file.filename}::${kind}`;
        if (seen.has(key)) break;
        seen.add(key);
        found.push({
          filename: file.filename,
          kind,
          line: safeTruncate(line.trim(), LINE_CAP, "head"),
        });
        break;
      }
    }
  }
  return found;
}

/**
 * Accepted forms of the `Consumer account:` marker.
 *
 * Mirrors the tolerance the sibling markers learned the hard way: a Markdown heading at
 * any level with an optional trailing colon, or the plain label with a REQUIRED colon,
 * optionally bolded and optionally bulleted. mt#3778 records what a narrower matcher
 * cost the negative-control surface — 42 consecutive fires with zero passes, a quarter of
 * them real evidence the matcher could not see.
 */
const CONSUMER_ACCOUNT_MARKER_RE =
  /^\s*(?:[-*+]\s+)?(?:#{1,6}\s*)?(?:\*\*\s*)?consumer account(?:\s*\*\*)?\s*(?::|$)/i;

/**
 * True when the body carries the marker OUTSIDE a fenced block.
 *
 * Fence-awareness is load-bearing, not decoration: a PR body quoting this very surface's
 * documentation would otherwise satisfy the check it is describing.
 */
export function hasConsumerAccount(prBody: string): boolean {
  const lines = prBody.split("\n");
  const fenced = computeFenceInternalLines(lines);
  return lines.some((line, i) => fenced[i] !== true && CONSUMER_ACCOUNT_MARKER_RE.test(line));
}

/** Explicit, tracked deferral — prose does not count, by design. */
const DEFERRAL_RE = /\[consumer-account-deferred:\s*(mt#\d+)\]/i;

export function extractConsumerAccountDeferral(prBody: string): string | null {
  const m = DEFERRAL_RE.exec(prBody);
  return m?.[1] ?? null;
}

/**
 * Calibration log, sibling of the test-first / render-path / SC-coverage logs.
 *
 * **No per-surface `MINSKY_SKIP_*` override, deliberately (SC4).** Each of the four
 * siblings has one, and copying that would mint a 100th `MINSKY_*` name into exactly the
 * population ADR-028 D3 exists to shrink — CLAUDE.md §Hook Files says outright not to.
 * Nothing here needs escaping either: this surface is log-only, so there is no decision
 * to bypass; it appends a record and pushes a WARN string. If a calibration window shows
 * it noisy enough to want silencing, that is a tune with evidence behind it, not a hatch
 * shipped speculatively. `MINSKY_HOOK_OVERRIDE=require-execution-evidence-before-merge`
 * remains available and covers the whole gate.
 */
export const CONSUMER_ACCOUNT_CALIBRATION_LOG =
  ".minsky/execution-evidence-consumer-account-calibration.jsonl";

/**
 * One calibration record. `decision` is always `warn` — this surface never denies.
 *
 * A `type`, not an `interface`, for the reason the sibling records: the append helper
 * takes `Record<string, unknown>`, and only object type ALIASES get an implicit index
 * signature.
 */
export type ConsumerAccountCalibrationRecord = {
  timestamp: string;
  task: string;
  prNumber: number | null;
  decision: "warn";
  removedSignals: RemovedSignal[];
  /** Distinct kinds in this fire — the axis a review pass will slice false positives by. */
  kinds: SignalKind[];
  consumerAccountPresent: boolean;
  deferralMarker: string | null;
  /**
   * True when patches were unavailable for at least one changed file (GitHub omits
   * `patch` for binary and oversized files). Recorded so a reviewing pass can tell a
   * clean window from a partly-unread one — silence here is otherwise ambiguous.
   */
  patchesIncomplete: boolean;
  captureSchema: number;
  prTitle: string;
  /**
   * The PR body this verdict was computed against.
   *
   * Captured for the reason the test-first surface captures its own: the verdict turns
   * on text in a MUTABLE artifact, so re-running the matcher over the CURRENT body
   * answers "what would it say today", never "what was it judging". NOT elided — the
   * marker's validity depends on fence membership, so blanking fenced spans would
   * destroy the structure a re-derivation needs.
   */
  judgedPrBody: ArtifactCapture;
};

export interface ConsumerAccountRunResult {
  /**
   * Always `true` for this surface — kept so the caller reads all five calibration
   * results through one shape. The siblings set it false when their per-surface override
   * fires; this one has no override to fire (see {@link CONSUMER_ACCOUNT_CALIBRATION_LOG}),
   * so there is no path that skips the check.
   */
  ranCheck: boolean;
  /** WARN string for `additionalContext`, or null when nothing to report. */
  warning: string | null;
  /** Record to append, or null when the PR is compliant / not applicable. */
  calibrationRecord: ConsumerAccountCalibrationRecord | null;
}

/**
 * Runs the consumer-account calibration surface for one merge attempt.
 *
 * Never denies; the caller appends `calibrationRecord` and pushes `warning` onto the same
 * aggregated `additionalContext` the sibling surfaces use.
 */
export function runConsumerAccountCalibration(
  task: string,
  prNumber: number | null,
  patches: PrFilePatch[],
  prTitle: string,
  prBody: string,
  now: () => Date = () => new Date()
): ConsumerAccountRunResult {
  const removedSignals = findRemovedSignalCalls(patches);
  if (removedSignals.length === 0) {
    return { ranCheck: true, warning: null, calibrationRecord: null };
  }

  const consumerAccountPresent = hasConsumerAccount(prBody);
  const deferralMarker = extractConsumerAccountDeferral(prBody);
  if (consumerAccountPresent || deferralMarker !== null) {
    return { ranCheck: true, warning: null, calibrationRecord: null };
  }

  const kinds = [...new Set(removedSignals.map((s) => s.kind))];
  // Scoped to the roots this surface actually scans — an unreadable binary asset outside
  // them says nothing about whether this check saw everything it was meant to.
  const patchesIncomplete = patches.some(
    (p) => IN_SCOPE_ROOT_RE.test(p.filename) && typeof p.patch !== "string"
  );
  const sites = removedSignals
    .slice(0, 5)
    .map((s) => `  - ${s.filename} [${s.kind}]: ${s.line}`)
    .join("\n");
  const more = removedSignals.length > 5 ? `\n  … and ${removedSignals.length - 5} more` : "";

  const warning =
    `[consumer-account] CALIBRATION (log-only, mt#4493 — would block if graduated): this ` +
    `PR removes ${removedSignals.length} signal-producing call(s) and its body carries no ` +
    `\`Consumer account:\` section.\n${sites}${more}\n\n` +
    `A process exit, an emitted event, or a closed connection is rarely only cleanup — ` +
    `name what CONSUMED it and what replaces it, or add ` +
    `\`[consumer-account-deferred: mt#NNNN]\`. Removing it may well be right; the finding ` +
    `is that nothing says who was listening.\n\n` +
    `Merge is NOT blocked by this — it is a calibration signal only.`;

  return {
    ranCheck: true,
    warning,
    calibrationRecord: {
      timestamp: now().toISOString(),
      task,
      prNumber,
      decision: "warn",
      removedSignals,
      kinds,
      consumerAccountPresent,
      deferralMarker,
      patchesIncomplete,
      captureSchema: CAPTURE_SCHEMA_VERSION,
      prTitle,
      judgedPrBody: captureArtifact(prBody),
    },
  };
}
