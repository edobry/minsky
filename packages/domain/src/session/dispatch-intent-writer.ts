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
 * store.ts`'s record shape + state-dir resolution + append logic. This is
 * the established pattern for `src/` <-> `.minsky/hooks/` boundary
 * crossings — see `src/mcp/guard-health-tracker.ts`'s header comment for
 * the documented precedent and rationale: the root `tsconfig.json`'s
 * `include` does not cover `.minsky/`, and `.minsky/hooks/` is
 * deliberately self-contained (its own SPEC.md invariant: hooks keep
 * working even when the main codebase has type errors) — so a direct
 * import in either direction is both impossible (types) and undesirable
 * (couples the self-contained hooks tree to the main build). The on-disk
 * JSON schema (`{ declarations: [...] }`) is the shared contract; keep this
 * module's shape in sync with the hooks-tree copy by convention, not
 * import.
 *
 * Only the WRITE path is duplicated here — READ + MATCH logic
 * (`findLiveReadOnlyDeclaration`) lives exclusively in the hooks-tree copy,
 * since the guard is the only reader.
 *
 * @see .minsky/hooks/dispatch-intent-store.ts — the hooks-tree's copy (source of truth for the on-disk schema)
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
function readExistingDeclarations(storePath: string): DispatchIntentDeclaration[] {
  let raw: string;
  try {
    raw = readTextFileSync(storePath);
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

/**
 * Append a dispatch-intent declaration, pruning already-expired
 * declarations along the way. Never throws — a state-dir write failure
 * must not block prompt generation; callers catch and log a warning
 * instead (the declaration is a defense-in-depth write-gate, not a
 * correctness-critical step for the prompt itself).
 *
 * @param nowMs — injectable clock for the expiry prune (tests only);
 *   defaults to `Date.now()`.
 */
export function appendDispatchIntentDeclaration(
  declaration: DispatchIntentDeclaration,
  nowMs: number = Date.now()
): void {
  const storePath = getDispatchIntentStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  const existing = readExistingDeclarations(storePath);
  const unexpired = existing.filter((d) => {
    const issuedMs = Date.parse(d.issuedAt);
    return !Number.isNaN(issuedMs) && nowMs < issuedMs + d.ttlMs;
  });

  unexpired.push(declaration);
  fs.writeFileSync(storePath, `${JSON.stringify({ declarations: unexpired }, null, 2)}\n`);
}

/**
 * Convenience wrapper: build + append a `"read-only"` declaration for
 * `sessionId`. Swallows any error (fs failure) and returns whether the
 * write succeeded, so callers can log-and-continue rather than let a
 * declaration-store hiccup block prompt generation.
 */
export function declareReadOnlyIntent(
  sessionId: string,
  options?: { ttlMs?: number; issuedBy?: string; reason?: string; nowMs?: number }
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
      nowMs
    );
    return true;
  } catch {
    return false;
  }
}
