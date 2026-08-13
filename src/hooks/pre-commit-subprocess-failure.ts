/**
 * Distinguishing "the subprocess failed" from "we stopped waiting for it" (mt#3406).
 *
 * Every `execAsync` step in ./pre-commit.ts reports both events with the same
 * sentence, because Node reports them with the same `message`. On a timeout the
 * rejection looks like this — observed, not assumed:
 *
 *     execAsync("sleep 5", { timeout: 300 })
 *       message : "Command failed: sleep 5"
 *       killed  : true    signal: "SIGTERM"    code: null
 *
 * The command name is the only content; the word "timeout" never appears. So an
 * author whose commit was denied by a budget sees a sentence that reads as a
 * verdict on their diff. That misdirection has cost real time twice: five
 * blocked commits on 2026-07-30 (mt#3406's originating incident) and roughly
 * half an hour of diagnosis in a separate incident the same day
 * (mt#3412 `## Context`, whose ESLint runs died "with a bare 'Command failed'
 * and no output, because the killed process never got to write its JSON").
 *
 * This module reads the fields Node actually sets rather than pattern-matching
 * the message text, so it stays correct if the wording changes, and separates
 * two non-failures from a real one:
 *
 *   - TIMEOUT — `killed: true` (Node did the killing) or an `ETIMEDOUT` errno.
 *   - DIED BY SIGNAL — `killed: false` with a `signal` and NO output on either
 *     stream. The kernel's OOM killer is the case that actually happens; see
 *     `diedBySignal`, which was added after this task's own commit was blocked
 *     by one.
 *
 * Anything else is a genuine failure and passes through untouched — a child
 * that printed diagnostics before dying still has something worth showing.
 *
 * Why no override env var (mt#3406 criterion 4): the sibling pre-commit gates
 * carry `MINSKY_SKIP_*` escapes because they enforce a POLICY an author may
 * have a considered reason to bypass. A timeout is not a policy — it is the
 * step not finishing, and the remedy is to re-run or raise the budget, not to
 * skip the check. Adding a skip here would let a real lint failure through on a
 * slow host. Deliberately absent, not overlooked.
 *
 * That decision has now been reached twice independently, so it is recorded
 * here rather than only in the two task specs (mt#3410 R1). mt#3410 asked for
 * the same override on the ESLint step in particular, on the grounds that a
 * verified-clean workspace had no path to commit while the machine was loaded —
 * true when it was written against a 169s FULL-REPO run under a 120s budget,
 * and weakened by mt#3404 scoping the step to the staged set under 60s. It was
 * withdrawn rather than built, for the reason above.
 *
 * The residual risk is real and bounded, not dismissed: if a STAGED-file run is
 * observed timing out 2+ times in 24h or 3+ times in 5 days, the premise has
 * re-formed and the override should be reopened as its own task and decided
 * there. Do not add one here without that — the argument against it is load
 * bearing, and a skip added quietly is exactly how a real lint failure ships.
 *
 * @see ./pre-commit.ts — the three call sites (formatter, ESLint, typecheck)
 * @see mt#3404, mt#3412 — the sibling work that fixed the COST; this fixes the DIAGNOSIS
 * @see mt#3410 — the second request for this override, and its withdrawal
 */

/**
 * The three budgets this module reports on.
 *
 * They live here rather than inline at the `execAsync` options because the
 * message has to name the same number the step actually enforces — two literals
 * would drift the first time someone tunes one and not the other, and a message
 * that names the wrong budget is worse than the one this task is fixing. The
 * reasoning for each VALUE stays as a comment at its call site in
 * ./pre-commit.ts, which is also why they are not re-explained here.
 */
export const ESLINT_TIMEOUT_MS = 60_000;
export const FORMATTER_TIMEOUT_MS = 240_000;
export const TYPECHECK_TIMEOUT_MS = 60_000;

/** The subset of a Node subprocess rejection this module reads. */
interface SubprocessRejection {
  message?: string;
  killed?: boolean;
  code?: string | number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

export interface SubprocessFailureContext {
  /** Operator-facing step name, e.g. "Code formatting". */
  step: string;
  /** The budget the step passed to `execAsync`, in milliseconds. */
  timeoutMs: number;
}

/**
 * True when Node terminated the child because the budget elapsed.
 *
 * `killed` is the field Node sets when IT does the killing, which for these
 * steps means the timeout fired. `ETIMEDOUT` is checked too because some
 * rejection paths surface the timeout as an errno instead.
 */
function wasKilledByTimeout(err: SubprocessRejection): boolean {
  return err.killed === true || err.code === "ETIMEDOUT";
}

/**
 * True when the child died by signal without Node asking — the kernel's OOM
 * killer being the case that actually happens here.
 *
 * Observed while implementing mt#3406: the typecheck step's `tsgo` child was
 * SIGKILLed mid-run on a loaded host, and the step reported "TypeScript type
 * errors found! Commit blocked." `validate_typecheck` on the same tree had
 * reported 0 errors across 5 projects two minutes earlier. The tell in the
 * rejection is `status: null, signal: "SIGKILL"` with both streams empty — a
 * process that produced no diagnostics because it never finished, which is the
 * opposite of what the message claimed.
 *
 * Distinct from {@link wasKilledByTimeout}: `killed` is FALSE here, because
 * Node did not do the killing. Empty output is required as well — a child that
 * printed real diagnostics and then died still has something worth showing.
 */
function diedBySignal(err: SubprocessRejection): boolean {
  if (err.killed === true || !err.signal) return false;
  const producedOutput = Boolean(err.stdout?.trim() || err.stderr?.trim());
  return !producedOutput;
}

/**
 * Render a subprocess rejection as a sentence that names the actual event.
 *
 * A timeout says so and names the budget, so the reader knows to re-run rather
 * than to go looking for a defect in their diff. Anything else passes the
 * underlying tool output through unchanged — the timeout branch must never
 * swallow a real failure.
 */
export function describeSubprocessFailure(
  error: unknown,
  { step, timeoutMs }: SubprocessFailureContext
): string {
  const err = (error ?? {}) as SubprocessRejection;
  const underlying = err.message ?? String(error);

  if (wasKilledByTimeout(err)) {
    const seconds = Math.round(timeoutMs / 1000);
    return (
      `${step} timed out after ${seconds}s — the subprocess was killed, not a failure in ` +
      `your changes. Re-run the commit; if it recurs, the budget is set in ` +
      `src/hooks/pre-commit-subprocess-failure.ts. (underlying: ${underlying})`
    );
  }

  if (diedBySignal(err)) {
    return (
      `${step} was killed by ${err.signal} before it produced any output — most likely the ` +
      `machine ran out of memory, not a failure in your changes. Re-run the commit; if it ` +
      `recurs, close other work or run the check on its own. (underlying: ${underlying})`
    );
  }

  return `${step} failed: ${underlying}`;
}
