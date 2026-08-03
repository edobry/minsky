// Locally-tuned guard thresholds (mt#3581, ADR-032 §D1).
//
// Fourth instance of the ADR-028 file-based store pattern — after
// `merge-grant-store.ts` (D5), `guard-grant-store.ts` (D8), and
// `ask-grant-store.ts` (mt#2823). Same state-dir resolution, same
// dependency-free posture, same fail-open reads.
//
// ## Why a state-dir file and not config.yaml
//
// The value has to be readable BY THE GUARD, and guards run in the hook
// process — a short-lived process spawned per lifecycle event, separate from
// the MCP server. Two constraints follow, and together they rule out the
// obvious answer:
//
//   1. `.claude/hooks/SPEC.md` makes this tree dependency-free, so a hook
//      cannot import the domain config loader to read `config.yaml`.
//   2. mt#1427 records that the MCP server caches `config.yaml` at boot, so a
//      value written there does not take effect until a `/mcp` reconnect.
//      A tuned threshold that needs a reconnect to apply is not "the guard's
//      next evaluation reads it."
//
// A plain JSON file in the durable state dir has neither problem: the hook
// reads it with `node:fs` on each invocation, so a write is visible to the
// very next evaluation.
//
// ## Precedence
//
// An explicit `MINSKY_*` env var always wins over a tuned value — see
// `readTunedThreshold` in `types.ts` for the chain and its rationale.
//
// Self-containment (per `.claude/hooks/SPEC.md`): imports ONLY `node:fs`,
// `node:os`, `node:path`.
//
// @see mt#3581 — this module's task
// @see docs/architecture/adr-032-guard-threshold-tuning-loop.md §D1 — the bounds
// @see .minsky/hooks/ask-grant-store.ts — the store pattern this mirrors

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const GUARD_TUNING_STORE_FILENAME = "guard-tuning.json";

/** Resolve the Minsky state dir: MINSKY_STATE_DIR, else XDG_STATE_HOME/minsky, else ~/.local/state/minsky. */
export function getStateDir(): string {
  const override = process.env["MINSKY_STATE_DIR"];
  if (override) return override;
  const xdgStateHome =
    process.env["XDG_STATE_HOME"] || path.join(process.env["HOME"] || os.homedir(), ".local/state");
  return path.join(xdgStateHome, "minsky");
}

/** Absolute path to the guard-tuning store file. */
export function getGuardTuningStorePath(): string {
  return path.join(getStateDir(), GUARD_TUNING_STORE_FILENAME);
}

/** One tuned threshold, keyed in the store by its registered `MINSKY_*` env-var name. */
export interface TunedThreshold {
  /** The value in force. Always a positive integer — see `isUsableEntry`. */
  value: number;
  /** ISO-8601. When this value was applied. */
  appliedAt: string;
  /**
   * The value this replaced, so a reversal restores it rather than guessing.
   * Absent on the first tune of a threshold, which reverts to the shipped
   * default instead.
   */
  previousValue?: number;
  /**
   * Why it moved, in the decider's own terms — sample sizes and which clamp
   * decided the value. Never rendered to a customer (ADR-032 forbids numbers
   * and detector names on that surface); this is the operator's audit trail.
   */
  basis?: Record<string, unknown>;
}

export type GuardTuningStore = Record<string, TunedThreshold>;

/**
 * Injectable filesystem seam, mirroring `ask-grant-store.ts`'s `AskGrantStoreFsDeps`.
 *
 * Exists so tests substitute an in-memory fake rather than touching the real
 * filesystem (`custom/no-real-fs-in-tests`), and so a caller can point the store
 * somewhere else without an env var.
 */
export interface GuardTuningStoreFsDeps {
  readFileSync: (path: string, encoding: "utf-8") => string;
  writeFileSync: (path: string, data: string, encoding: "utf-8") => void;
  mkdirSync: (path: string, options: { recursive: true }) => void;
}

const realFs: GuardTuningStoreFsDeps = {
  readFileSync: (p, e) => fs.readFileSync(p, e),
  writeFileSync: (p, d, e) => fs.writeFileSync(p, d, e),
  mkdirSync: (p, o) => {
    fs.mkdirSync(p, o);
  },
};

/**
 * A store entry is usable only if it carries a positive integer.
 *
 * `readPositiveIntEnv` rejects anything else and silently falls back to the
 * shipped default, so an entry outside that contract is not a smaller tune —
 * it is a no-op wearing a tune's costume. Rejecting it here makes the fallback
 * explicit rather than accidental.
 */
function isUsableEntry(entry: unknown): entry is TunedThreshold {
  if (!entry || typeof entry !== "object") return false;
  const value = (entry as { value?: unknown }).value;
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Read the whole store. Fail-open: a missing, unreadable, or malformed file
 * yields an empty store, never a throw — a broken store must degrade to
 * shipped defaults, not break every guard that consults it.
 */
export function readGuardTuningStore(
  storePath: string = getGuardTuningStorePath(),
  fsDeps: GuardTuningStoreFsDeps = realFs
): GuardTuningStore {
  let raw: string;
  try {
    raw = fsDeps.readFileSync(storePath, "utf-8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const store: GuardTuningStore = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (isUsableEntry(entry)) store[key] = entry;
  }
  return store;
}

/** Read one tuned value, or undefined when none is in force. */
export function readTunedValue(
  thresholdKey: string,
  storePath: string = getGuardTuningStorePath(),
  fsDeps: GuardTuningStoreFsDeps = realFs
): number | undefined {
  return readGuardTuningStore(storePath, fsDeps)[thresholdKey]?.value;
}

/**
 * Write one tuned value, preserving the rest of the store.
 *
 * Returns the entry actually written so a caller can record it without
 * re-reading — including the `previousValue` this fills in from whatever was
 * in force, which is what makes reversal exact rather than a guess.
 *
 * Throws on write failure. Unlike the read path, a failed WRITE must not be
 * swallowed: silently not applying a threshold the operator consented to is
 * the failure mode this whole subsystem exists to avoid.
 */
export function writeTunedValue(
  thresholdKey: string,
  value: number,
  options: {
    appliedAt: string;
    basis?: Record<string, unknown>;
    storePath?: string;
    fsDeps?: GuardTuningStoreFsDeps;
  }
): TunedThreshold {
  const storePath = options.storePath ?? getGuardTuningStorePath();
  const fsDeps = options.fsDeps ?? realFs;
  const store = readGuardTuningStore(storePath, fsDeps);
  const previousValue = store[thresholdKey]?.value;

  const entry: TunedThreshold = {
    value,
    appliedAt: options.appliedAt,
    ...(previousValue === undefined ? {} : { previousValue }),
    ...(options.basis === undefined ? {} : { basis: options.basis }),
  };

  store[thresholdKey] = entry;
  fsDeps.mkdirSync(path.dirname(storePath), { recursive: true });
  fsDeps.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  return entry;
}

/**
 * Undo the last tune of one threshold.
 *
 * Restores `previousValue` when the threshold has been tuned more than once,
 * and otherwise removes the entry entirely so the guard falls back to its
 * SHIPPED default. Returns the value now in force, or undefined when the
 * threshold reverted to its shipped default.
 */
export function revertTunedValue(
  thresholdKey: string,
  options: { appliedAt: string; storePath?: string; fsDeps?: GuardTuningStoreFsDeps }
): number | undefined {
  const storePath = options.storePath ?? getGuardTuningStorePath();
  const fsDeps = options.fsDeps ?? realFs;
  const store = readGuardTuningStore(storePath, fsDeps);
  const existing = store[thresholdKey];
  if (!existing) return undefined;

  if (existing.previousValue === undefined) {
    delete store[thresholdKey];
  } else {
    store[thresholdKey] = { value: existing.previousValue, appliedAt: options.appliedAt };
  }

  fsDeps.mkdirSync(path.dirname(storePath), { recursive: true });
  fsDeps.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  return store[thresholdKey]?.value;
}
