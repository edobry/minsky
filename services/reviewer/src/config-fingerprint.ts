/**
 * Per-review configuration fingerprint (mt#4556).
 *
 * `review_timing` records `provider` and `model` and nothing else about HOW the
 * reviewer was configured — but a review's cost and behaviour also turn on a
 * tier gate and six behavioural feature flags, none of which appeared in any
 * row. Flipping one left a corpus in which before and after were
 * indistinguishable except by timestamp.
 *
 * This module derives one value that names the whole arm, stamped on every
 * `review_timing` write and on the Braintrust cost event built from the same
 * input.
 *
 * ## Format
 *
 * A version tag followed by sorted `key=value` pairs, `;`-separated:
 *
 *     v1;composition_convergence=off;diff_scope_bounded=off;effort=low;...
 *
 * Deliberately NOT a hash. The point is a cohort key an operator can read and
 * `GROUP BY` directly — a hash gives stability at the cost of every dimension
 * needing a lookup table to recover. Keys are sorted so the same configuration
 * produces a byte-identical value regardless of construction order, which is
 * what makes cohorts survive a restart.
 *
 * ## What is a CONFIGURATION dimension here, and what is not
 *
 * `effort` is the odd one out and is labelled as derived rather than
 * configured, because that is what it is: there is no reasoning-effort setting.
 * `providers.ts` computes it per model CALL from `(model, toolsActive)` plus an
 * optional per-call override, so what is recorded is the value actually sent on
 * the PRIMARY call — `none` when no call was made (the two pre-model skip
 * paths) or when the model takes no effort parameter. It is carried so the
 * dimension is already present the day it becomes configurable; do not read it
 * as evidence that something was configured.
 */

import type { ReviewerConfig } from "./config";
import {
  resolveReasoningEffort,
  parseToolloopRetryEnabled,
  type ReasoningEffort,
} from "./providers";

/** Bumped when the pair set or the encoding changes; old rows keep their own tag. */
export const CONFIG_FINGERPRINT_VERSION = "v1";

/**
 * The behavioural feature flags, as `[fingerprint key, env var]`.
 *
 * All six are default-OFF and share one parse (`parseRecoveryFlag`). Adding a
 * flag to the reviewer without adding it here is a silent regression — the
 * fingerprint would report two genuinely different arms as the same one.
 *
 * This list is the single place the flag set is written down, and as of mt#4578
 * that is enforced rather than asserted. Before mt#4578 it was half true:
 * mt#4556 routed all six gates through one PARSE, but each gate still spelled
 * its own `process.env.REVIEWER_*` literal, so a rename could update one site
 * and leave the other compiling.
 *
 * The two drift directions are closed by two different mechanisms, because only
 * one of them is expressible as a type:
 *
 *  - **A gate naming a flag this list does not have** cannot compile. The gates
 *    call `readRecoveryFlag(key)` below and never name an env var, and
 *    `RecoveryFlagKey` is derived from this array — so there is no second
 *    spelling of the name anywhere, and a typo'd key is a type error.
 *  - **An entry here that no gate reads** is invisible to the compiler: nothing
 *    can require a call site to EXIST. That direction is covered by
 *    `recovery-flag-wiring.test.ts`, which checks each key is consumed.
 *
 * NOTE: the type annotation is deliberately omitted. Annotating this
 * `ReadonlyArray<readonly [string, string]>` widens the literals back to
 * `string`, `RecoveryFlagKey` silently becomes `string`, and the compile-time
 * half above is lost with no visible symptom — a gate could then pass any
 * string. Keep `as const` and keep the annotation off.
 */
export const RECOVERY_FLAG_ENV_VARS = [
  ["composition_convergence", "REVIEWER_COMPOSITION_CONVERGENCE_ENABLED"],
  ["diff_scope_bounded", "REVIEWER_DIFF_SCOPE_BOUNDED_ENABLED"],
  ["incremental_diff", "REVIEWER_INCREMENTAL_DIFF_ENABLED"],
  ["monotonicity_recovery", "REVIEWER_MONOTONICITY_RECOVERY_ENABLED"],
  ["refutation_recovery", "REVIEWER_REFUTATION_RECOVERY_ENABLED"],
  ["structural_claim_verification", "REVIEWER_STRUCTURAL_CLAIM_VERIFICATION_ENABLED"],
] as const;

/**
 * A fingerprint key naming one behavioural flag.
 *
 * Derived from `RECOVERY_FLAG_ENV_VARS`, never hand-written — that derivation is
 * what makes a gate unable to name a flag the list does not carry.
 */
export type RecoveryFlagKey = (typeof RECOVERY_FLAG_ENV_VARS)[number][0];

/**
 * Key → env var. Total by construction: both sides come from the same array, so
 * the cast asserts only what `RecoveryFlagKey`'s own derivation already
 * guarantees (`Object.fromEntries` cannot express that on its own).
 */
const RECOVERY_FLAG_ENV_VAR_BY_KEY = Object.fromEntries(RECOVERY_FLAG_ENV_VARS) as Record<
  RecoveryFlagKey,
  string
>;

/**
 * Parse a default-OFF behavioural flag.
 *
 * This is the single definition of that parse. Prefer `readRecoveryFlag` at a
 * gate — this stays exported because `buildConfigFingerprint` below applies it
 * across the whole list at once, where there is no single key to read. Accepts
 * `true` / `1` / `yes` / `on`, case-insensitively, after trimming.
 */
export function parseRecoveryFlag(raw: string | undefined): boolean {
  return /^(true|1|yes|on)$/i.test((raw ?? "").trim());
}

/**
 * Read one behavioural flag by its fingerprint key (mt#4578).
 *
 * The form the six gates in `review-worker.ts` call. They pass a key and never
 * an env var, so the name exists in exactly one place — `RECOVERY_FLAG_ENV_VARS`
 * — and the fingerprint cannot report a flag under a name the gate does not
 * actually read.
 *
 * A reader at a gate can still recover the env var without opening this file:
 * every key maps to `REVIEWER_${KEY.toUpperCase()}_ENABLED`. That is a
 * convention the current six happen to follow, NOT a derivation — the pairs
 * above stay explicit so a future flag may take a non-conforming name, and so
 * that renaming a key can never silently rename an operator-facing env var.
 */
export function readRecoveryFlag(
  key: RecoveryFlagKey,
  env: Record<string, string | undefined> = process.env
): boolean {
  return parseRecoveryFlag(env[RECOVERY_FLAG_ENV_VAR_BY_KEY[key]]);
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

/**
 * Keep a value from breaking the `k=v;k=v` encoding.
 *
 * No model or provider id in use contains `;` or `=`, so this never fires
 * today — it exists so that a future one cannot silently produce a fingerprint
 * that parses into different pairs than it was built from.
 */
function sanitize(value: string): string {
  return value.replace(/[;=]/g, "_");
}

export interface ConfigFingerprintInput {
  provider: string;
  model: string;
  tier2Enabled: boolean;
  /**
   * The effort actually sent on the primary model call; `null` when no call was
   * made, or when the model takes no `reasoning_effort` parameter.
   */
  reasoningEffort: ReasoningEffort | null;
  /** Env source. Injected in tests; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Build the fingerprint from fully-resolved inputs. */
export function buildConfigFingerprint(input: ConfigFingerprintInput): string {
  const env = input.env ?? process.env;

  const pairs: Array<[string, string]> = [
    ["effort", input.reasoningEffort ?? "none"],
    ["model", sanitize(input.model)],
    ["provider", sanitize(input.provider)],
    ["tier2", onOff(input.tier2Enabled)],
    ["toolloop_retry", onOff(parseToolloopRetryEnabled(env["REVIEWER_TOOLLOOP_RETRY_ON_TIMEOUT"]))],
    ...RECOVERY_FLAG_ENV_VARS.map(([key, envVar]): [string, string] => [
      key,
      onOff(parseRecoveryFlag(env[envVar])),
    ]),
  ];

  // Plain codepoint order, not localeCompare — the latter is locale-dependent
  // and would let the same configuration fingerprint differently by host.
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return [CONFIG_FINGERPRINT_VERSION, ...pairs.map(([k, v]) => `${k}=${v}`)].join(";");
}

/**
 * The form every `review_timing` write site calls.
 *
 * `modelCalled` is what separates the two pre-model skip paths (no call, so no
 * effort was sent) from the paths that reached the model — including the
 * unrecovered-failure path, where a call WAS attempted with an effort resolved
 * exactly as the successful path would have resolved it.
 */
export function fingerprintForReview(
  config: Pick<ReviewerConfig, "provider" | "providerModel" | "tier2Enabled">,
  opts: {
    toolUseActive: boolean;
    modelCalled: boolean;
    env?: Record<string, string | undefined>;
  }
): string {
  return buildConfigFingerprint({
    provider: config.provider,
    model: config.providerModel,
    tier2Enabled: config.tier2Enabled,
    reasoningEffort: opts.modelCalled
      ? resolveReasoningEffort(config.provider, config.providerModel, opts.toolUseActive)
      : null,
    env: opts.env,
  });
}
