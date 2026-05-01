/**
 * Error fingerprinting for the 2-strikes mechanical tracker (mt#1484).
 *
 * The 2-strikes rule (CLAUDE.md §Error Investigation) says agents must stop
 * after the *2nd identical tool error from the same tool*. A fingerprint is
 * the operational definition of "identical": two errors share a fingerprint
 * iff the tracker should treat them as a repeat.
 *
 * v1 heuristic (per mt#1484 spec, subject to calibration in observation-only
 * mode before mt#1476 wires emission):
 *
 *   `tool-name + error-type + normalized-message`
 *
 * where `normalized-message` is the error text lowercased, whitespace-collapsed,
 * and trimmed. The full hash is the SHA-1 of `${toolName}::${errorType}::${normalized}`.
 *
 * Why this shape: the simplest thing that distinguishes "same root cause" from
 * "different root cause" without overfitting to noise tokens (timestamps, paths,
 * UUIDs, request IDs). We knowingly under-fire on errors whose only signal
 * lives in those tokens — calibration data from observation-only mode will
 * tell us whether a noise-token strip pass is worth adding.
 */

import { createHash } from "crypto";

/** Result of fingerprinting an error. */
export interface ErrorFingerprint {
  /** Stable hash string used as the dedup key. */
  hash: string;
  /** The tool that produced the error (e.g. "Bash", "Edit", "mcp__minsky__session_pr_merge"). */
  toolName: string;
  /** Discriminator for the error class (Error.name, "string", "object", etc.). */
  errorType: string;
  /** Normalized error message — what the hash actually fingerprints. */
  normalizedMessage: string;
}

/**
 * Extract a printable error message from an unknown thrown value, then
 * normalize it to a stable form: lowercase, single-space-collapsed, trimmed.
 *
 * Stable across leading/trailing whitespace differences and across casing
 * differences (some tools emit "Permission denied" vs "permission denied").
 */
export function normalizeErrorMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message;
  } else if (typeof err === "string") {
    raw = err;
  } else if (err === null) {
    raw = "null";
  } else if (err === undefined) {
    raw = "undefined";
  } else {
    try {
      raw = JSON.stringify(err);
    } catch {
      raw = String(err);
    }
  }

  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Discriminator for the error class. We keep this separate from the message
 * because two errors with different runtime types but the same message text
 * (rare but possible) should not collide.
 */
export function errorTypeOf(err: unknown): string {
  if (err instanceof Error) {
    return err.name || "Error";
  }
  if (err === null) return "null";
  if (err === undefined) return "undefined";
  return typeof err;
}

/**
 * Fingerprint an error.
 *
 * The hash is deterministic across runs for the same input (uses SHA-1 of a
 * stable concatenation, not Node's `Symbol`-based hashing). Different tools
 * never collide because `toolName` is the first hash field. Different error
 * types never collide because `errorType` is the second hash field.
 *
 * @param toolName  The tool that produced the error.
 * @param error     The thrown value (Error, string, or anything).
 */
export function fingerprintError(toolName: string, error: unknown): ErrorFingerprint {
  const errorType = errorTypeOf(error);
  const normalizedMessage = normalizeErrorMessage(error);

  const hash = createHash("sha1")
    .update(`${toolName}::${errorType}::${normalizedMessage}`)
    .digest("hex");

  return { hash, toolName, errorType, normalizedMessage };
}
