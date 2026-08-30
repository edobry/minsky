/**
 * Wall-clock offset for the whole test suite (mt#4726).
 *
 * A test pinned to an absolute instant is a claim that the world will not change, and the code
 * under test is free to start disagreeing with it later. Three such fixtures have detonated —
 * mt#2491 (a 1-day fuse), mt#3818 (14 days), mt#4721 (7 days) — each discovered only when it
 * reddened CI. This module is the DETECTION half of the remedy: run the suite in the future, so a
 * fixture that would expire in the next month expires tonight instead, with lead time to fix it.
 *
 * The PREVENTION half — inject the clock rather than reading it at the point of use — is the
 * convention in `testing-standards.mdc §Testable Design`, shipped by mt#4740. Nothing lints that
 * convention, which is why it needs a backstop; this is the backstop, not a replacement for it.
 *
 * ## Inert by default
 *
 * With `MINSKY_TEST_CLOCK_SHIFT_DAYS` unset, {@link installClockShift} returns without touching
 * `globalThis`. Every ordinary local and CI run is byte-identically unaffected. That property is
 * what lets this live in the preload every suite already loads, instead of behind a bespoke runner
 * flag that would reach only the suites someone remembered to wire.
 *
 * ## Why a Proxy, and not `class ShiftedDate extends Date`
 *
 * A subclass assigned to `globalThis.Date` breaks `instanceof` for any Date built inside native
 * code: `fs.stat()` hands back a REAL `Date`, which is not an instance of the subclass, so
 * `expect(stat.mtime).toBeInstanceOf(Date)` fails on IDENTITY rather than on time. That accounted
 * for two of the three failures in this task's AT1 measurement — noise with no relation to time
 * coupling, and it would have fired on any Date crossing a native boundary.
 *
 * A Proxy over the real constructor forwards `prototype` to `Date.prototype` — the SAME object —
 * so `OrdinaryHasInstance` still returns true for natively-constructed Dates. Only the two forms
 * that actually read the clock are intercepted: `Date.now()` and argless `new Date()`.
 *
 * ## What this deliberately does NOT shift
 *
 * Each of these is a real coverage bound, not an oversight. A reader deciding whether a shifted-run
 * failure is a bomb needs them:
 *
 * - **Filesystem timestamps.** A test that writes a file and measures its age sees a file that is
 *   suddenly `offset` old. Real elapsed time advances the clock and the mtime TOGETHER; this
 *   advances only the clock, so such a test cannot rot on its own. These are `probe-artifact`
 *   entries in `clock-shift-exemptions.ts` — debts against this shim, not bombs in the corpus.
 * - **Subprocesses.** A test that spawns the real CLI gets an unshifted child: the env var is
 *   inherited, but the child never preloads this module. In-process coverage only.
 * - **Monotonic clocks.** `performance.now()` and `process.hrtime()` measure elapsed time rather
 *   than wall-clock instants, so no fixture can rot against them.
 * - **`Date.parse`.** It parses a string and never reads the clock; there is nothing to move.
 */

/** The env var that arms the shift. Registered `test-fixture` in `environment.ts` (mt#3882). */
export const CLOCK_SHIFT_ENV_VAR = "MINSKY_TEST_CLOCK_SHIFT_DAYS";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Marks a constructor this module already wrapped.
 *
 * `Symbol.for` rather than a module-local symbol on purpose: bun can evaluate a preload more than
 * once across realms, and two module instances must still recognise each other's work. Without it a
 * second install would wrap the proxy in another proxy and silently DOUBLE the horizon — a
 * mis-measurement that no test would fail on.
 */
const SHIFTED = Symbol.for("minsky.test.clock-shift.installed");

/**
 * How far forward the clock should move, or `null` for "do nothing".
 *
 * Throws on a value that is present but unparseable. A typo must not degrade to inert: an inert
 * nightly is indistinguishable from a clean one, which is exactly the failure SC6 exists to catch.
 */
export function parseShiftMs(env: Record<string, string | undefined>): number | null {
  const raw = env[CLOCK_SHIFT_ENV_VAR];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }
  const days = Number(raw);
  if (!Number.isFinite(days)) {
    throw new Error(
      `${CLOCK_SHIFT_ENV_VAR} is set to ${JSON.stringify(raw)}, which is not a finite number of ` +
        "days. Unset it to run normally, or give it a number."
    );
  }
  return Math.trunc(days * MS_PER_DAY);
}

/** Human-readable horizon, for the preflight check and the CI log. */
export function describeOffset(offsetMs: number): string {
  const days = offsetMs / MS_PER_DAY;
  return `clock shifted ${days >= 0 ? "+" : ""}${days}d`;
}

/**
 * Derive a `Date` that reads the clock `offsetMs` in the future.
 *
 * Takes the real constructor as a parameter and mutates nothing, so a test can exercise the whole
 * mechanism without touching `globalThis` — the functional core ADR-036 §3 asks for.
 */
export function createShiftedDateConstructor(
  RealDate: DateConstructor,
  offsetMs: number
): DateConstructor {
  const shiftedNow = (): number => RealDate.now() + offsetMs;

  return new Proxy(RealDate, {
    construct(target, args, newTarget) {
      // Argless `new Date()` is the only constructor form that reads the clock. Every other form
      // is passed through untouched, so `new Date(0)` still means the epoch.
      return Reflect.construct(target, args.length === 0 ? [shiftedNow()] : args, newTarget);
    },
    apply() {
      // `Date(...)` called as a FUNCTION ignores its arguments entirely and returns the current
      // time as a string, per spec — so there is no passthrough case to preserve here.
      return new RealDate(shiftedNow()).toString();
    },
    get(target, prop, receiver) {
      if (prop === "now") {
        return shiftedNow;
      }
      if (prop === SHIFTED) {
        return true;
      }
      // Everything else forwards — crucially `prototype`, which is what keeps a natively
      // constructed Date an `instanceof` this constructor.
      return Reflect.get(target, prop, receiver);
    },
  });
}

export interface ClockShiftStatus {
  /** True when the clock was actually moved. */
  readonly active: boolean;
  /** Milliseconds the clock was moved forward. Zero when inert. */
  readonly offsetMs: number;
  /** One-line description, for the preflight self-check and CI logs. */
  readonly summary: string;
}

/** The object whose `Date` binding gets replaced. `globalThis` in production, a stub in tests. */
export interface ClockShiftTarget {
  Date: DateConstructor;
}

/**
 * Install the shift on `target` (default `globalThis`).
 *
 * Idempotent: a constructor this module already wrapped is left alone. Returns what it did, so the
 * caller can report the horizon rather than assume it.
 */
export function installClockShift(
  env: Record<string, string | undefined> = process.env,
  // `globalThis` satisfies ClockShiftTarget structurally — `Date` is declared as a mutable
  // `DateConstructor` — so no assertion is needed to name the one property this touches.
  target: ClockShiftTarget = globalThis
): ClockShiftStatus {
  const offsetMs = parseShiftMs(env);
  if (offsetMs === null) {
    return { active: false, offsetMs: 0, summary: `inert (${CLOCK_SHIFT_ENV_VAR} unset)` };
  }

  const current = target.Date as DateConstructor & { [SHIFTED]?: boolean };
  if (current[SHIFTED] === true) {
    return {
      active: true,
      offsetMs,
      summary: `${describeOffset(offsetMs)} (already installed)`,
    };
  }

  target.Date = createShiftedDateConstructor(current, offsetMs);
  return { active: true, offsetMs, summary: describeOffset(offsetMs) };
}
