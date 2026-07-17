/**
 * Dispatch-Intent Declaration Writer (mt#2865)
 *
 * The `src/`-side WRITE surface for the dispatch-intent store that
 * `.minsky/hooks/dispatch-intent-write-gate.ts` reads at PreToolUse time.
 * Called from `session.generate_prompt` (`src/adapters/shared/commands/
 * session/prompt-command.ts`) and `tasks.dispatch`
 * (`src/adapters/shared/commands/tasks/dispatch-command.ts`) whenever a
 * dispatch declares `intent: "read-only"`.
 *
 * DUPLICATES (does not cross-import) `.minsky/hooks/dispatch-intent-
 * store.ts`'s record shape + state-dir resolution + append + sanitize +
 * lock logic. This is the established pattern for `src/` <-> `.minsky/
 * hooks/` boundary crossings — see `src/mcp/guard-health-tracker.ts`'s
 * header comment for the documented precedent and rationale: the root
 * `tsconfig.json`'s `include` does not cover `.minsky/`, and `.minsky/
 * hooks/` is deliberately self-contained (its own SPEC.md invariant: hooks
 * keep working even when the main codebase has type errors) — so a direct
 * import in either direction is both impossible (types) and undesirable
 * (couples the self-contained hooks tree to the main build). The on-disk
 * JSON schema (`{ declarations: [...] }`) is the shared contract; keep this
 * module's shape in sync with the hooks-tree copy by convention, not
 * import.
 *
 * PR #2033 R1 NON-BLOCKING #5: this module's fs access is unified behind
 * ONE injected `DispatchIntentWriterFsDeps` shape (read + write + mkdir),
 * matching `.minsky/hooks/dispatch-intent-store.ts`'s own
 * `DispatchIntentStoreFsDeps` pattern — a prior version used
 * `readTextFileSync` (unabstracted) for the read path and raw `node:fs`
 * calls for the write path, two different IO seams in one module.
 *
 * PR #2033 R1 NON-BLOCKING #6: the append read-modify-write is guarded by
 * the SAME exclusive-create sibling-lock-file mechanism as
 * `.minsky/hooks/ask-grant-store.ts`'s `withAskGrantStoreLock` (and this
 * module's own hooks-tree twin, `withDispatchIntentStoreLock`) — mirrored
 * exactly rather than reinvented, per the review's explicit instruction.
 *
 * Only the WRITE path is duplicated here — READ + MATCH logic
 * (`findLiveReadOnlyDeclaration`) lives exclusively in the hooks-tree copy,
 * since the guard is the only reader.
 *
 * @see .minsky/hooks/dispatch-intent-store.ts — the hooks-tree's copy (source of truth for the on-disk schema)
 * @see .minsky/hooks/ask-grant-store.ts — the lock shape this module mirrors
 * @see mt#2865 — tracking task
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readTextFileSync } from "@minsky/shared/fs";

const DISPATCH_INTENT_STORE_FILENAME = "dispatch-intents.json";

/** Mirrors `.minsky/hooks/dispatch-intent-store.ts`'s `DispatchIntent`. */
export type DispatchIntent = "read-only" | "implementation";

/** Mirrors `.minsky/hooks/dispatch-intent-store.ts`'s `DispatchIntentDeclaration`. */
export interface DispatchIntentDeclaration {
  sessionId: string;
  intent: DispatchIntent;
  issuedAt: string;
  ttlMs: number;
  issuedBy?: string;
  reason?: string;
}

/**
 * Default declaration lifetime: 30 minutes. Matches the ADR-028 D5
 * merge-grant default TTL order of magnitude ("the order of a typical
 * bounded subagent dispatch") — a bounded read-only lookup should complete
 * well inside this window; a dispatch that's still running past it has
 * already exceeded what "bounded" means for this mechanism.
 */
export const DEFAULT_DISPATCH_INTENT_TTL_MS = 30 * 60 * 1000;

/**
 * Cap on `reason`'s persisted length — mirrors `.minsky/hooks/dispatch-
 * intent-store.ts`'s `MAX_REASON_LENGTH` exactly (PR #2033 R1 BLOCKING #2).
 */
export const MAX_REASON_LENGTH = 300;

/**
 * Sanitize a `reason` value for storage — mirrors `.minsky/hooks/dispatch-
 * intent-store.ts`'s `sanitizeReason` exactly: collapse CR/LF sequences to
 * a single space, trim, cap to `MAX_REASON_LENGTH`. Returns `undefined`
 * for an absent/empty/whitespace-only input.
 */
export function sanitizeReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const collapsed = reason.replace(/[\r\n]+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > MAX_REASON_LENGTH ? collapsed.slice(0, MAX_REASON_LENGTH) : collapsed;
}

/** Mirrors `.minsky/hooks/dispatch-intent-store.ts`'s `getStateDir()` exactly. */
function getStateDir(): string {
  const override = process.env["MINSKY_STATE_DIR"];
  if (override) return override;
  const xdgStateHome =
    process.env["XDG_STATE_HOME"] || path.join(process.env["HOME"] || os.homedir(), ".local/state");
  return path.join(xdgStateHome, "minsky");
}

/** Absolute path to the shared dispatch-intent store file. */
export function getDispatchIntentStorePath(): string {
  return path.join(getStateDir(), DISPATCH_INTENT_STORE_FILENAME);
}

// ---------------------------------------------------------------------------
// Injectable fs dependency (PR #2033 R1 NON-BLOCKING #5 — ONE shape for
// both read and write, matching dispatch-intent-store.ts's
// DispatchIntentStoreFsDeps)
// ---------------------------------------------------------------------------

export interface DispatchIntentWriterFsDeps {
  readFileSync: (path: string) => string;
  writeFileSync: (path: string, content: string) => void;
  mkdirSync: (path: string) => void;
}

const defaultFsDeps: DispatchIntentWriterFsDeps = {
  readFileSync: (p: string): string => readTextFileSync(p),
  writeFileSync: (p: string, content: string): void => {
    fs.writeFileSync(p, content, "utf8");
  },
  mkdirSync: (p: string): void => {
    fs.mkdirSync(p, { recursive: true });
  },
};

function isWellFormedDeclaration(d: unknown): d is DispatchIntentDeclaration {
  if (!d || typeof d !== "object") return false;
  const rec = d as Record<string, unknown>;
  return (
    typeof rec.sessionId === "string" &&
    rec.sessionId.trim().length > 0 &&
    typeof rec.issuedAt === "string" &&
    !Number.isNaN(Date.parse(rec.issuedAt)) &&
    typeof rec.ttlMs === "number" &&
    Number.isFinite(rec.ttlMs) &&
    rec.ttlMs > 0
  );
}

/**
 * Best-effort read of whatever declarations already exist in the store.
 * Any failure (missing file, malformed JSON, wrong shape) resolves to an
 * empty array — this writer starts fresh rather than blocking issuance on
 * a corrupt read, mirroring `dispatch-intent-store.ts`'s
 * `appendDispatchIntentDeclaration` write-side tolerance (the READ side's
 * own fail-open posture is what protects guard invocations from a corrupt
 * file, not this function).
 */
function readExistingDeclarations(
  storePath: string,
  fsDeps: DispatchIntentWriterFsDeps
): DispatchIntentDeclaration[] {
  let raw: string;
  try {
    raw = fsDeps.readFileSync(storePath);
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { declarations?: unknown };
    if (!Array.isArray(parsed.declarations)) return [];
    return (parsed.declarations as unknown[]).filter(isWellFormedDeclaration);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store lock (PR #2033 R1 NON-BLOCKING #6 — mirrors `.minsky/hooks/
// ask-grant-store.ts`'s `withAskGrantStoreLock` / this module's hooks-tree
// twin `withDispatchIntentStoreLock` EXACTLY)
// ---------------------------------------------------------------------------

const LOCK_SUFFIX = ".lock";
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 40;
const LOCK_RETRY_DELAY_MS = 25;

export interface DispatchIntentWriterLockDeps {
  /** Atomically create the lock file; false when it already exists. */
  tryExclusiveCreate: (path: string, content: string) => boolean;
  unlinkSync: (path: string) => void;
  /** Age of the lock file in ms, or null when missing/unreadable. */
  lockAgeMs: (path: string) => number | null;
  sleepMs: (ms: number) => void;
}

const defaultLockDeps: DispatchIntentWriterLockDeps = {
  tryExclusiveCreate: (p: string, content: string): boolean => {
    try {
      const fd = fs.openSync(p, "wx");
      fs.writeSync(fd, content);
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw err;
    }
  },
  unlinkSync: (p: string): void => {
    try {
      fs.unlinkSync(p);
    } catch {
      // Already gone — fine.
    }
  },
  lockAgeMs: (p: string): number | null => {
    try {
      return Date.now() - fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
  },
  sleepMs: (ms: number): void => {
    Bun.sleepSync(ms);
  },
};

/**
 * Run `fn` holding the store's sibling lock file. Throws when the lock
 * cannot be acquired within the retry budget (~1s).
 */
export function withDispatchIntentWriterLock<T>(
  storePath: string,
  fn: () => T,
  lockDeps: DispatchIntentWriterLockDeps = defaultLockDeps
): T {
  const lockPath = `${storePath}${LOCK_SUFFIX}`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    if (lockDeps.tryExclusiveCreate(lockPath, `${process.pid} ${new Date().toISOString()}`)) {
      try {
        return fn();
      } finally {
        lockDeps.unlinkSync(lockPath);
      }
    }
    const age = lockDeps.lockAgeMs(lockPath);
    if (age !== null && age > LOCK_STALE_MS) {
      lockDeps.unlinkSync(lockPath);
      continue;
    }
    lockDeps.sleepMs(LOCK_RETRY_DELAY_MS);
  }
  throw new Error(`could not acquire dispatch-intent store lock at ${lockPath}`);
}

/**
 * Append a dispatch-intent declaration, pruning already-expired
 * declarations along the way. Throws when the lock cannot be acquired
 * (surfaced to `declareReadOnlyIntent`'s try/catch, below, which is the
 * production caller's actual never-throws contract) — a state-dir write
 * failure must not block prompt generation, but a LOST concurrent write is
 * worse than a loud failure here. `declaration.reason` is sanitized
 * (newlines stripped, length capped) before being persisted, regardless of
 * what the caller passed in.
 *
 * @param nowMs — injectable clock for the expiry prune (tests only);
 *   defaults to `Date.now()`.
 * @param fsDeps — injectable fs functions (tests only); defaults to real IO.
 * @param lockDeps — injectable lock functions (tests only); defaults to real IO.
 */
export function appendDispatchIntentDeclaration(
  declaration: DispatchIntentDeclaration,
  nowMs: number = Date.now(),
  fsDeps: DispatchIntentWriterFsDeps = defaultFsDeps,
  lockDeps: DispatchIntentWriterLockDeps = defaultLockDeps
): void {
  const storePath = getDispatchIntentStorePath();
  fsDeps.mkdirSync(path.dirname(storePath));

  const sanitized: DispatchIntentDeclaration = {
    ...declaration,
    reason: sanitizeReason(declaration.reason),
  };

  withDispatchIntentWriterLock(
    storePath,
    () => {
      const existing = readExistingDeclarations(storePath, fsDeps);
      const unexpired = existing.filter((d) => {
        const issuedMs = Date.parse(d.issuedAt);
        return !Number.isNaN(issuedMs) && nowMs < issuedMs + d.ttlMs;
      });

      unexpired.push(sanitized);
      fsDeps.writeFileSync(storePath, `${JSON.stringify({ declarations: unexpired }, null, 2)}\n`);
    },
    lockDeps
  );
}

/**
 * Convenience wrapper: build + append a `"read-only"` declaration for
 * `sessionId`. Swallows any error (fs failure, lock-acquisition failure)
 * and returns whether the write succeeded, so callers can log-and-continue
 * rather than let a declaration-store hiccup block prompt generation.
 */
export function declareReadOnlyIntent(
  sessionId: string,
  options?: {
    ttlMs?: number;
    issuedBy?: string;
    reason?: string;
    nowMs?: number;
    fsDeps?: DispatchIntentWriterFsDeps;
    lockDeps?: DispatchIntentWriterLockDeps;
  }
): boolean {
  try {
    const nowMs = options?.nowMs ?? Date.now();
    appendDispatchIntentDeclaration(
      {
        sessionId,
        intent: "read-only",
        issuedAt: new Date(nowMs).toISOString(),
        ttlMs: options?.ttlMs ?? DEFAULT_DISPATCH_INTENT_TTL_MS,
        issuedBy: options?.issuedBy,
        reason: options?.reason,
      },
      nowMs,
      options?.fsDeps,
      options?.lockDeps
    );
    return true;
  } catch {
    return false;
  }
}
