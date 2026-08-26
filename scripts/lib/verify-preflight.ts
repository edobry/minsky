/**
 * Shared preflight for the browser-driving `scripts/verify-*.ts` family (mt#4149).
 *
 * ## The conflation this exists to remove
 *
 * Twelve verify scripts each carried a byte-identical copy of:
 *
 * ```ts
 * async function reachable(url: string): Promise<boolean> {
 *   try {
 *     await fetch(url, { signal: AbortSignal.timeout(3000) });
 *     return true;
 *   } catch {
 *     return false;
 *   }
 * }
 * ```
 *
 * `reachable()` answers one question — "did a response arrive within 3000 ms?" —
 * and every caller treated the answer as if it settled a different one: "is the
 * prerequisite there?". Those come apart the moment the target is present and
 * merely SLOW, and the script then printed the same `SKIP:` line it uses for a
 * bare checkout and exited **0**. A caller reading the exit code could not tell
 * a performed check from a skipped one.
 *
 * Observed 2026-08-13 during mt#4071: a cockpit served from a session worktree
 * answered `/api/health` correctly but took **20.1 s**, its DB check contending
 * with the operator's already-running cockpit on the same pooler; the operator's
 * own cockpit answered in **172 ms**. The render verification could not run, and
 * the script reported that as a skip.
 *
 * ## The four sub-operations, named separately
 *
 * 1. **Is a target listening at all?** — ABSENT. Legitimately a `SKIP:` + exit 0;
 *    a bare checkout has no cockpit, and that is not a defect.
 * 2. **Did it answer within budget?** — SLOW. Reported with the measured latency
 *    and the budget it exceeded, and it exits {@link EXIT_INCOMPLETE}, NOT 0 —
 *    the check was not performed, and nothing downstream may read that as a pass.
 * 3. **Is it the RIGHT service?** — asserted via `assertServiceIdentity`, not a
 *    bare 200 (mt#3148). A wrong service is a hard FAIL (exit 1).
 * 4. **Did the connection break on the way?** — INDETERMINATE (mt#4624). A socket
 *    that was accepted and then reset is evidence about the CONNECTION, not about
 *    whether a listener exists. It routes to the confirm step and ends as SLOW,
 *    so it exits {@link EXIT_INCOMPLETE} — never a silent `SKIP:` + exit 0.
 *
 * The splits are measured, not guessed. `AbortSignal.timeout` rejects with a
 * `DOMException` named `TimeoutError` ({@link isBudgetAbort}); the codes that
 * mean "nothing is there" are enumerated and measured at
 * {@link isDefinitelyAbsent}, which carries the full observed table.
 *
 * Sub-operation 4 is the one this module originally missed, and it is the same
 * conflation as sub-operation 2 entering by a different door. mt#4149 removed
 * "present-but-SLOW read as absent"; a live target whose socket is reset was
 * still read as absent, because the split was `isBudgetAbort` and everything
 * else. Reproduced live 2026-08-25 under concurrent full-suite load: a real
 * `Bun.serve` target, answering throughout, classified `absent` on an
 * `ECONNRESET` — which `verdictForReach` maps to `skip` and exit 0.
 *
 * ## Shape
 *
 * The classification half is a functional core — {@link probeReachability},
 * {@link readHealthBody}, {@link resolveBudgets}, {@link verdictForReach} — with
 * injectable `fetch`/clock and no process exits, so it is unit-testable without
 * a live target. {@link preflightCockpit} is the imperative shell that composes
 * them and exits.
 *
 * @see scripts/interceptor-coordinate-input.ts — same extraction, same reason: two
 *   readers of one fact must not each keep a copy, because copies drift silently
 * @see scripts/precommit-step-names.ts — mt#4071's instance of the same pattern
 */
import {
  assertServiceIdentity,
  describeHealthIdentityResult,
  SERVICE_IDENTITIES,
  type ServiceIdentity,
} from "../../packages/domain/src/deployment/health-identity";

/**
 * Budget for "is anything listening?". Preserved from the twelve copies this
 * replaces, so a target that passed their preflight passes this one.
 */
export const DEFAULT_REACH_BUDGET_MS = 3000;

/**
 * Budget for reading and parsing the health body. Also preserved — every copy
 * followed its `reachable()` call with a `fetch(HEALTH, { timeout: 5000 })`, so
 * raising only the reachability budget would move the failure four lines down.
 */
export const DEFAULT_HEALTH_BUDGET_MS = 5000;

/**
 * How long to keep waiting, once the reachability budget has already been
 * missed, purely to MEASURE how slow the target actually is.
 *
 * This probe cannot change the verdict — the target already missed its budget —
 * so it exists only to turn ">3000ms" into "20134ms", which is the difference
 * between a report an operator can act on and one they cannot. 30 s is an order
 * of magnitude above the reach budget: comfortably past the 20.1 s that produced
 * this task, and still bounded.
 */
export const DEFAULT_SLOW_CONFIRM_BUDGET_MS = 30_000;

export const REACH_BUDGET_ENV = "MINSKY_VERIFY_REACH_TIMEOUT_MS";
export const HEALTH_BUDGET_ENV = "MINSKY_VERIFY_HEALTH_TIMEOUT_MS";
export const SLOW_CONFIRM_BUDGET_ENV = "MINSKY_VERIFY_SLOW_CONFIRM_TIMEOUT_MS";

/**
 * Exit code for "the check was NOT performed".
 *
 * Deliberately distinct from both 0 (the prerequisite is absent — nothing to do)
 * and 1 (an assertion about the system failed). A caller that treats non-zero as
 * failure is already correct; one that wants to distinguish "the target was too
 * slow to measure" from "the invariant is broken" can.
 */
export const EXIT_INCOMPLETE = 2;

// --- Budgets -------------------------------------------------------------

export type Budgets = {
  reachMs: number;
  healthMs: number;
  slowConfirmMs: number;
};

export type BudgetResolution = { ok: true; budgets: Budgets } | { ok: false; message: string };

/**
 * Read the three budgets from the environment.
 *
 * A malformed value is an ERROR, never a silent fall back to the default: an
 * operator who set `MINSKY_VERIFY_REACH_TIMEOUT_MS=30s` and got the 3000 ms
 * default anyway would be looking at exactly the silent-skip this module exists
 * to remove, one level up.
 */
export function resolveBudgets(
  env: Record<string, string | undefined> = process.env
): BudgetResolution {
  const read = (name: string, fallback: number): number | string => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return `${name}="${raw}" is not a positive number of milliseconds`;
    }
    return parsed;
  };

  const reachMs = read(REACH_BUDGET_ENV, DEFAULT_REACH_BUDGET_MS);
  if (typeof reachMs === "string") return { ok: false, message: reachMs };
  const healthMs = read(HEALTH_BUDGET_ENV, DEFAULT_HEALTH_BUDGET_MS);
  if (typeof healthMs === "string") return { ok: false, message: healthMs };
  const slowConfirmMs = read(SLOW_CONFIRM_BUDGET_ENV, DEFAULT_SLOW_CONFIRM_BUDGET_MS);
  if (typeof slowConfirmMs === "string") return { ok: false, message: slowConfirmMs };

  return { ok: true, budgets: { reachMs, healthMs, slowConfirmMs } };
}

// --- Reachability --------------------------------------------------------

export type ReachOutcome =
  /** A response arrived within the budget. */
  | { kind: "reached"; elapsedMs: number }
  /** Nothing is listening — connection refused, DNS failure, host unreachable. */
  | { kind: "absent"; detail: string }
  /**
   * Something is there and did not answer in time. `measuredMs` is the latency
   * observed by the follow-up measurement, or null when even that did not
   * complete (the target is slower than `confirmBudgetMs`, or went away).
   *
   * `detail` names whatever went wrong that a bare latency does not explain:
   * the confirm step's own failure, and/or (mt#4624) a first probe whose socket
   * was interrupted rather than merely slow. It is present on a measured
   * outcome too, which is why `verdictForReach` renders it in both arms.
   *
   * It is ORIGIN-ANNOTATED at construction: a first-probe failure is written as
   * `first attempt: …`, and a composite as `first attempt: …; then …`. The
   * renderer therefore never has to guess where a `detail` came from, and both
   * arms can print it identically (PR #3372 R1).
   */
  | {
      kind: "slow";
      budgetMs: number;
      measuredMs: number | null;
      confirmBudgetMs: number;
      detail?: string;
    };

/** The slice of `fetch` this module uses. Injectable so the core is testable. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<unknown>;

export type ProbeDeps = {
  fetchImpl?: FetchLike;
  now?: () => number;
};

/**
 * Did OUR budget abort this, or did the connection fail?
 *
 * `AbortSignal.timeout` rejects with a `DOMException` named `TimeoutError`;
 * some runtimes surface a user abort as `AbortError`, so both are accepted.
 * Anything else means the fetch failed for a reason of its own. Which of those
 * reasons mean "nothing is there" is a SEPARATE question — see
 * {@link isDefinitelyAbsent}.
 */
export function isBudgetAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Does this error mean the prerequisite is genuinely NOT THERE — as opposed to a
 * connection that reached a listener and then broke?
 *
 * Measured on Bun 1.3.14 (mt#4624), every row produced by a real socket:
 *
 * | Condition                                    | `name`         | `code`              |
 * | -------------------------------------------- | -------------- | ------------------- |
 * | nothing listening (port bound, then released) | `Error`        | `ConnectionRefused` |
 * | DNS failure (`http://no-such-host.invalid/`)  | `Error`        | `ConnectionRefused` |
 * | our own budget abort                          | `TimeoutError` | `23`                |
 * | socket accepted, then reset                   | `Error`        | `ECONNRESET`        |
 *
 * Both genuinely-absent conditions collapse onto ONE code, which is why this is
 * an ALLOWLIST and not a denylist of transient codes. The direction is the whole
 * point: an unrecognized code falls through to the confirm step and ends as
 * `slow` (exit {@link EXIT_INCOMPLETE}), never as a silent `skip` + exit 0. A new
 * Bun release inventing a code we have not seen therefore fails safe.
 *
 * (Bun reporting DNS failure as `ConnectionRefused` is inaccurate as naming and
 * harmless here: both answers mean the prerequisite is not there.)
 */
const DEFINITELY_ABSENT_CODES: ReadonlySet<string> = new Set(["ConnectionRefused"]);

export function isDefinitelyAbsent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && DEFINITELY_ABSENT_CODES.has(code);
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === "string" ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/**
 * Classify a target as reached / absent / slow.
 *
 * On a budget abort the target has already failed its budget, so the follow-up
 * probe is diagnostic only and cannot flip the verdict — whatever it returns,
 * the outcome stays `slow`. That asymmetry is the point: a target that answers
 * on the second try in 20 s is not "reachable", it is slow, and saying so is
 * what stops the caller from exiting 0.
 *
 * The first probe's failure has THREE outcomes, not two (mt#4624):
 *
 * - a budget abort → fall through to the confirm step (as before);
 * - an error whose code {@link isDefinitelyAbsent} recognizes → `absent`, which
 *   `verdictForReach` maps to `skip` + exit 0. This is the bare-checkout case;
 * - anything else → the connection reached a listener and broke, so the target's
 *   presence is UNDETERMINED. Fall through to the confirm step and report the
 *   interruption in `detail`. Never `absent`: "the socket was reset" is not
 *   evidence that nothing is listening, and treating it as such exits 0 on a
 *   check that was never performed.
 */
export async function probeReachability(
  url: string,
  budgets: { budgetMs: number; confirmBudgetMs: number },
  deps: ProbeDeps = {}
): Promise<ReachOutcome> {
  const doFetch: FetchLike = deps.fetchImpl ?? ((u, init) => fetch(u, init));
  const now = deps.now ?? (() => Date.now());

  const started = now();
  /**
   * A first-probe failure that was neither our budget nor a definitive absence —
   * the connection reached a listener and then broke. Carried into the outcome so
   * the report names the interruption instead of implying the target was slow.
   * Already origin-annotated, so `verdictForReach` renders it the same way in
   * both arms.
   */
  let interrupted: string | undefined;
  try {
    await doFetch(url, { signal: AbortSignal.timeout(budgets.budgetMs) });
    return { kind: "reached", elapsedMs: now() - started };
  } catch (err) {
    /**
     * OUR budget must be asked FIRST, and the order is load-bearing (PR #3372
     * R1). `isBudgetAbort` reads `name`; `isDefinitelyAbsent` reads `code`, and
     * nothing stops one error carrying both — a proxy layer or a wrapper that
     * rethrows can stamp `code: "ConnectionRefused"` onto an abort. Asking the
     * allowlist first would classify our own timeout as `absent` and exit 0,
     * which is exactly the guarantee the docblock above makes we never do.
     * Budget abort wins; only then is it absent-or-interrupted.
     */
    if (!isBudgetAbort(err)) {
      if (isDefinitelyAbsent(err)) return { kind: "absent", detail: describeError(err) };
      interrupted = `first attempt: ${describeError(err)}`;
    }
  }

  const confirmStarted = now();
  try {
    await doFetch(url, { signal: AbortSignal.timeout(budgets.confirmBudgetMs) });
    return {
      kind: "slow",
      budgetMs: budgets.budgetMs,
      measuredMs: now() - confirmStarted,
      confirmBudgetMs: budgets.confirmBudgetMs,
      ...(interrupted === undefined ? {} : { detail: interrupted }),
    };
  } catch (err) {
    return {
      kind: "slow",
      budgetMs: budgets.budgetMs,
      measuredMs: null,
      confirmBudgetMs: budgets.confirmBudgetMs,
      detail:
        interrupted === undefined
          ? describeError(err)
          : `${interrupted}; then ${describeError(err)}`,
    };
  }
}

// --- Verdicts ------------------------------------------------------------

export type Verdict =
  | { action: "proceed" }
  | { action: "skip"; message: string }
  | { action: "incomplete"; message: string };

/** Exit code a verdict maps to. `skip` keeps today's 0; `incomplete` does not. */
export function exitCodeForVerdict(verdict: Verdict): number {
  return verdict.action === "incomplete" ? EXIT_INCOMPLETE : 0;
}

/**
 * Turn a {@link ReachOutcome} into what the script should do about it.
 *
 * `absentReason` is passed in rather than derived so each call site keeps the
 * wording its readers already know (`no cockpit reachable at …`, `no CDP
 * endpoint at …`).
 */
export function verdictForReach(
  outcome: ReachOutcome,
  describe: { absentReason: string; slowSubject: string }
): Verdict {
  switch (outcome.kind) {
    case "reached":
      return { action: "proceed" };
    case "absent":
      return { action: "skip", message: describe.absentReason };
    case "slow": {
      const observed =
        outcome.measuredMs === null
          ? `did not answer within ${outcome.budgetMs}ms, and still had not answered ` +
            `${outcome.confirmBudgetMs}ms later${outcome.detail ? ` (${outcome.detail})` : ""}`
          : // mt#4624: an interrupted first probe reaches here WITH a measured
            // latency, and "answered in Nms, past its budget" alone would report
            // it as plain slowness. Naming the interruption is the whole point of
            // routing it here instead of calling it absent.
            //
            // Rendered IDENTICALLY to the unmeasured arm above (PR #3372 R1).
            // `detail` annotates its own origin at construction — the first-probe
            // string is built as `first attempt: …` in `probeReachability` — so
            // neither arm adds wording the other lacks, and a `detail` that ever
            // comes from somewhere else cannot be mislabelled by the renderer.
            `answered in ${outcome.measuredMs}ms, past its ${outcome.budgetMs}ms budget${
              outcome.detail ? ` (${outcome.detail})` : ""
            }`;
      return {
        action: "incomplete",
        message:
          `${describe.slowSubject} ${observed} — the check was NOT performed. ` +
          `Raise ${REACH_BUDGET_ENV} (and ${HEALTH_BUDGET_ENV} for the identity read) ` +
          `if this target is legitimately slow.`,
      };
    }
  }
}

// --- Health body ---------------------------------------------------------

export type HealthReadOutcome =
  | { kind: "body"; body: unknown }
  /** The read itself missed its budget — the second budget, four lines down. */
  | { kind: "slow"; budgetMs: number }
  /** Answered, but not with JSON. A proxy error page, or an HTML 200. */
  | { kind: "unreadable"; detail: string };

export async function readHealthBody(
  url: string,
  budgetMs: number,
  deps: ProbeDeps = {}
): Promise<HealthReadOutcome> {
  const doFetch: FetchLike = deps.fetchImpl ?? ((u, init) => fetch(u, init));
  try {
    const res = (await doFetch(url, { signal: AbortSignal.timeout(budgetMs) })) as {
      json: () => Promise<unknown>;
    };
    return { kind: "body", body: await res.json() };
  } catch (err) {
    if (isBudgetAbort(err)) return { kind: "slow", budgetMs };
    return { kind: "unreadable", detail: describeError(err) };
  }
}

// --- Imperative shell ----------------------------------------------------

/**
 * A prerequisite is absent. Exit 0 — a bare checkout has no cockpit, and that
 * is not a defect. Owned here so the twelve scripts stop each defining it.
 */
export function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

/** The check could not be performed. Never exit 0 for this. */
export function incomplete(reason: string): never {
  console.error(`INCOMPLETE: ${reason}`);
  process.exit(EXIT_INCOMPLETE);
}

function applyVerdict(verdict: Verdict): void {
  if (verdict.action === "proceed") return;
  if (verdict.action === "skip") skip(verdict.message);
  incomplete(verdict.message);
}

export type CockpitPreflightOptions = {
  /** Origin only, e.g. `http://127.0.0.1:3737`. The health path is appended. */
  cockpitUrl: string;
  /** When present, a CDP endpoint is required too (`${cdpUrl}/json/version`). */
  cdpUrl?: string;
  /** Which service must answer. Defaults to the cockpit. */
  identity?: ServiceIdentity;
};

export type CockpitPreflightResult = {
  healthUrl: string;
  /** The parsed health body, for callers that read `commit` or other fields. */
  healthBody: unknown;
  budgets: Budgets;
};

/**
 * Run the full preflight, or exit.
 *
 * `/api/health`, NOT `/health` — the latter falls through to the SPA's
 * `index.html` and answers 200 with HTML, which satisfies a bare reachability
 * check and then fails to parse as JSON. Two of the twelve scripts this replaces
 * probed `/health` and asserted no identity at all, so their preflight could not
 * fail on a wrong service; routing every caller through this function is what
 * closes that.
 */
export async function preflightCockpit(
  opts: CockpitPreflightOptions
): Promise<CockpitPreflightResult> {
  const resolution = resolveBudgets();
  if (!resolution.ok) incomplete(resolution.message);
  const { budgets } = resolution;

  const healthUrl = `${opts.cockpitUrl}/api/health`;
  applyVerdict(
    verdictForReach(
      await probeReachability(healthUrl, {
        budgetMs: budgets.reachMs,
        confirmBudgetMs: budgets.slowConfirmMs,
      }),
      {
        absentReason: `no cockpit reachable at ${opts.cockpitUrl}`,
        slowSubject: `the cockpit at ${opts.cockpitUrl}`,
      }
    )
  );

  /**
   * The CDP endpoint gets the SAME three-way split, deliberately (PR #3013 R1).
   *
   * mt#4149's `## Scope` originally moved the CDP half into this module
   * "unchanged", which would have meant a slow dev chromium still reporting as
   * ABSENT — `SKIP:` and exit 0. That was scoped out to avoid redesigning the
   * CDP check, not to preserve the conflation on it: "present but too slow to
   * answer" is not "not installed" for a browser any more than for a cockpit,
   * and the machine contention that produces one produces the other. Giving one
   * probe in this function a different meaning for SLOW than the other would
   * plant exactly the trap the module exists to remove. Scope expanded and
   * recorded in the spec rather than worked around with a per-probe flag.
   */
  if (opts.cdpUrl !== undefined) {
    applyVerdict(
      verdictForReach(
        await probeReachability(`${opts.cdpUrl}/json/version`, {
          budgetMs: budgets.reachMs,
          confirmBudgetMs: budgets.slowConfirmMs,
        }),
        {
          absentReason: `no CDP endpoint at ${opts.cdpUrl}`,
          slowSubject: `the CDP endpoint at ${opts.cdpUrl}`,
        }
      )
    );
  }

  const read = await readHealthBody(healthUrl, budgets.healthMs);
  if (read.kind === "slow") {
    incomplete(
      `${healthUrl} did not return its body within ${read.budgetMs}ms — the check was NOT ` +
        `performed. Raise ${HEALTH_BUDGET_ENV} if this target is legitimately slow.`
    );
  }
  if (read.kind === "unreadable") {
    console.error(`FAIL: ${healthUrl} did not return JSON: ${read.detail}`);
    process.exit(1);
  }

  /**
   * Assert WHICH service answered, not merely that something did (mt#3148).
   * Every Minsky service is built from the same monorepo, so a misconfigured
   * build can put a different application on this port and it will answer 200
   * identically. A probe that cannot fail carries no information.
   */
  const identity = assertServiceIdentity(read.body, opts.identity ?? SERVICE_IDENTITIES.cockpit);
  if (!identity.ok) {
    console.error(`FAIL: ${describeHealthIdentityResult(identity)}`);
    process.exit(1);
  }
  console.log(describeHealthIdentityResult(identity));

  return { healthUrl, healthBody: read.body, budgets };
}
