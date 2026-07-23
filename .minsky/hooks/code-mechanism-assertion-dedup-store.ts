// Per-session cooldown store for the code-mechanism-assertion-detector's
// per-claim-set dedup gate (mt#3113, leg 4).
//
// **Why this exists.** The 2026-07-23 orchestration session's calibration
// data showed the identical 4-symbol claim set re-firing (re-injecting) on
// nearly every turn for ~10 hours: the detector's turn-scoped scan
// (`extractLastAssistantTurn`) always looks at "the just-completed turn" in
// isolation, so an assistant that keeps re-stating the SAME unread-symbol
// assertion turn after turn (a stuck loop, a repeated summary, a recurring
// habit of phrasing) produces the identical (symbol, predicate) claim set
// every single time — genuinely a fresh match each turn by the pure
// detector's own contract, but NOT a fresh signal worth re-surfacing to the
// operator every time.
//
// This mirrors `guard-health-escalation-notify-store.ts`'s cooldown pattern
// (mt#3072) exactly: a per-session, per-signature "last surfaced" timestamp,
// re-surfaced only when the signature CHANGES (a genuinely different claim
// set) or the cooldown elapses (a periodic reminder — never silently
// forgotten forever). Layout mirrors `turn-end-scan-store.ts`'s
// per-session-file pattern (sidesteps the read-modify-write race a shared
// file would have between concurrent sessions).
//
// Fail-open posture: any store read/write error must never SILENTLY
// suppress a genuine first-time claim — an unreadable/unwritable store
// degrades to "always inject" (never dedup), the opposite failure mode from
// silently hiding a real signal.
//
// @see .minsky/hooks/guard-health-escalation-notify-store.ts — structural precedent (mt#3072)
// @see .minsky/hooks/turn-end-scan-store.ts — the per-session-file layout precedent
// @see .minsky/hooks/code-mechanism-assertion-detector.ts — the consumer
// @see mt#3113 — this task

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimum time between two injected (non-suppressed) surfacings of the SAME
 * claim-set signature, within one session. Mirrors
 * `guard-health-escalation-notify-store.ts`'s `ESCALATION_NOTIFY_COOLDOWN_MS`
 * — a proven, already-vetted cadence in this same hook family — bounding even
 * a fast-moving conversation (many turns in an hour) to at most one repeat
 * injection per hour for an UNCHANGED claim set, while still surfacing again
 * well before a genuinely stuck loop could run unnoticed for the observed
 * ~10-hour incident window.
 */
export const CLAIM_DEDUP_COOLDOWN_MS = 60 * 60 * 1000;

const DEFAULT_STORE_DIR = join(
  homedir(),
  ".local",
  "state",
  "minsky",
  "code-mechanism-assertion-dedup"
);

interface DedupState {
  signature: string;
  lastSurfacedAt: string;
}

export interface ClaimDedupFsDeps {
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  readFileSync: (p: string, encoding: "utf-8") => string;
  writeFileSync: (p: string, data: string) => void;
}

const REAL_FS: ClaimDedupFsDeps = { existsSync, mkdirSync, readFileSync, writeFileSync };

/**
 * Stable signature for a claim set: every (symbol, predicate) pair, sorted so
 * ordering differences between two extractions of the same underlying prose
 * (e.g. Set-iteration order) never produce a different signature, joined and
 * hashed. Truncated to 16 hex chars (64 bits) — mirrors
 * `wall-of-text-detector.ts`'s `hashText` precedent; the collision space is
 * tiny relative to a 64-bit digest given comparisons are always scoped to one
 * session's own recent history.
 */
export function claimSetSignature(
  claims: ReadonlyArray<{ symbol: string; predicate: string }>
): string {
  const canonical = claims
    .map((c) => `${c.symbol}::${c.predicate}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Build a collision-resistant filename for `sessionId`'s cooldown-state file.
 * Mirrors `guard-health-escalation-notify-store.ts`'s `storeFileName` exactly
 * (a naive char-replace sanitization can map two distinct session ids onto
 * the same sanitized string; appending a hash of the full original id keeps
 * the combined filename unique regardless of what the readable prefix
 * collapsed to).
 */
function storeFileName(sessionId: string): string {
  const raw = sessionId || "unknown-session";
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}

export interface ClaimDedupOptions {
  fs?: ClaimDedupFsDeps;
  now?: () => Date;
  cooldownMs?: number;
  /** Test seam — override the resolved store directory directly. */
  dir?: string;
}

/**
 * Decide whether `signature` (this turn's claim-set signature) should
 * surface an injection to `sessionId` right now, and persist that decision
 * for next time. Pure decision, real (best-effort) I/O — mirrors
 * `shouldNotifyEscalation`'s exact contract:
 *
 * - No prior record for this session -> inject (first time this
 *   conversation has seen ANY claim set).
 * - Prior record with a DIFFERENT signature -> inject (a genuinely
 *   different claim set — new symbols, new predicates, or both).
 * - Prior record with the SAME signature, cooldown elapsed -> inject (the
 *   periodic reminder that keeps a genuinely-persistent unread claim from
 *   being silently forgotten forever).
 * - Prior record with the SAME signature, still within cooldown -> suppress
 *   (dedup).
 *
 * Fail-open on any store read/write error: an unreadable or unwritable store
 * must never SILENTLY suppress a genuinely first-time claim.
 */
export function shouldInjectClaimSet(
  sessionId: string | undefined,
  signature: string,
  options?: ClaimDedupOptions
): boolean {
  const fs = options?.fs ?? REAL_FS;
  const now = (options?.now ?? (() => new Date()))();
  const cooldownMs = options?.cooldownMs ?? CLAIM_DEDUP_COOLDOWN_MS;
  const dir = options?.dir ?? DEFAULT_STORE_DIR;
  const path = join(dir, `${storeFileName(sessionId ?? "unknown-session")}.json`);

  let prior: DedupState | null = null;
  try {
    if (fs.existsSync(path)) {
      const parsed = JSON.parse(fs.readFileSync(path, "utf-8")) as Partial<DedupState>;
      if (typeof parsed.signature === "string" && typeof parsed.lastSurfacedAt === "string") {
        prior = { signature: parsed.signature, lastSurfacedAt: parsed.lastSurfacedAt };
      }
    }
  } catch {
    prior = null; // fail-open: unreadable store reads as "never surfaced"
  }

  const withinCooldown =
    prior !== null &&
    prior.signature === signature &&
    now.getTime() - new Date(prior.lastSurfacedAt).getTime() < cooldownMs;

  if (withinCooldown) return false;

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const next: DedupState = { signature, lastSurfacedAt: now.toISOString() };
    fs.writeFileSync(path, JSON.stringify(next));
  } catch {
    // Best-effort — a failed write just means the NEXT call also injects;
    // never suppress the (already-decided) injection this call.
  }
  return true;
}
