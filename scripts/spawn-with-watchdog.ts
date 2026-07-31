/**
 * Wall-clock watchdog for spawned test-runner children (mt#3156).
 *
 * ## Why this exists
 *
 * The pre-push runner chain had no upper bound on a child's lifetime. Three
 * recorded occurrences (2026-07-24, 2026-07-30 x2) left `bun test` processes
 * spinning at 100% CPU indefinitely — the worst pair ran 2h20m each and were
 * only stopped by a manual `kill -9`. In the third occurrence four such
 * processes were burning ~400% of a 16-core host simultaneously; killing them
 * dropped the load average from 85 to 7.
 *
 * ## Why not just pass `timeout` to `Bun.spawnSync`
 *
 * Because it does not enforce. Measured directly (two children identical except
 * for a no-op SIGTERM handler, both under `timeout: 2000, killSignal: "SIGTERM"`):
 *
 * ```
 * no SIGTERM handler: elapsed=2005ms  exitCode=null  signal=SIGTERM   success=false
 * ignores SIGTERM:    elapsed=25011ms exitCode=0     signal=undefined success=true
 * ```
 *
 * A child that ignores SIGTERM runs past its timeout to completion and is
 * reported as `exitCode: 0, success: true`. A watchdog built on that option
 * would not merely fail to stop a hang — it would report the hung run as a
 * PASS, which is strictly worse than today's obvious hang. `child_process.exec`
 * has the identical defect (same probe, same result), so this is one bug class
 * across two APIs, not a quirk of one.
 *
 * The escalation cannot be layered on top of `spawnSync` either: `spawnSync`
 * blocks the JS thread for the child's lifetime, so no in-process timer can
 * fire to send the second signal. Hence async `Bun.spawn` plus an explicit
 * two-stage kill, which is what this helper provides.
 *
 * ## Why no process-group kill
 *
 * Killing a process GROUP (`process.kill(-pid, ...)`) requires the child to
 * lead its own group, which requires detaching it at spawn time. Bun's spawn
 * children inherit the parent's process group, so `-pid` would either fail or —
 * far worse — signal the RUNNER'S OWN group. Instead each runner watchdogs its
 * OWN direct child, with inner budgets strictly smaller than outer ones, so a
 * chain (gated -> main -> `bun test`) is reaped leaf-first: the innermost
 * watchdog fires before its parent's, killing the actual `bun test` process
 * rather than orphaning it. That composition is what the observed orphans
 * (PPID 1) needed and is why the budgets below are ordered.
 *
 * `bun test` itself terminates on plain SIGTERM (verified against a spinning
 * test), so stage one is sufficient for the observed hangs; the SIGKILL
 * escalation is defense for the general case.
 *
 * @see mt#3156 — originating task, all three occurrences
 * @see scripts/run-tests-gated.ts, scripts/run-tests-main.ts, scripts/run-tests-mcp-isolated.ts
 */

/** Default grace period between SIGTERM and the SIGKILL escalation. */
const DEFAULT_GRACE_MS = 5_000;

/**
 * Wall-clock budgets, ordered outer > inner so a hung leaf is reaped by its own
 * runner rather than orphaned when an ancestor is killed first.
 *
 * Grounded in observed runtimes (per `decision-defaults` §Thresholds — observed
 * cadence, not round numbers): the main suite runs ~103s (mt#3122 measurement),
 * the domain batch ~62s, `test:components` ~9s. Wall-clock inflates under host
 * load — a full-repo ESLint run measured 50s of CPU stretched across 287s of
 * wall time at load average 85 (~5.7x). The main budget below is ~9x the
 * observed runtime, which covers that inflation with margin while still being
 * finite — the property today's code lacks entirely.
 */
export const WATCHDOG_BUDGETS_MS = {
  /** `run-tests-gated.ts` -> one runner script. Outermost; must exceed MAIN. */
  GATED_STEP: 1_200_000, // 20 min
  /** `run-tests-main.ts` -> `bun test` (~103s observed). */
  MAIN: 900_000, // 15 min
  /** `run-tests-mcp-isolated.ts` -> `bun test` for ONE file. */
  MCP_ISOLATED_PER_FILE: 300_000, // 5 min
} as const;

/**
 * Read a budget override from the environment, falling back to `fallbackMs`.
 * A legitimately slow run (a cold cache, a heavily loaded host) can raise the
 * budget without editing code; a non-numeric or non-positive value is ignored
 * rather than silently disabling the watchdog.
 */
export function resolveWatchdogBudgetMs(
  fallbackMs: number,
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.MINSKY_TEST_WATCHDOG_MS;
  if (raw === undefined) return fallbackMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return parsed;
}

export interface WatchdogSpawnOptions {
  /** Wall-clock budget in ms. On expiry the child is terminated. */
  budgetMs: number;
  /** Delay between SIGTERM and SIGKILL. Defaults to 5s. */
  graceMs?: number;
  /** Extra environment for the child (merged over `process.env`). */
  env?: Record<string, string>;
  /**
   * When true the child writes straight through to this process's stdout and
   * stderr and the returned `stdout`/`stderr` are empty. When false (default)
   * output is captured AND re-emitted, so callers that need to gate on the
   * text still show it to the operator.
   */
  inheritStdio?: boolean;
}

export interface WatchdogSpawnResult {
  /** Child exit code. Non-zero whenever `timedOut` is true. */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the budget expired and the child was terminated. */
  timedOut: boolean;
  /** True when SIGTERM was insufficient and SIGKILL was required. */
  requiredSigkill: boolean;
  /** Wall-clock ms the child actually ran. */
  elapsedMs: number;
}

/**
 * Spawn a child under a wall-clock watchdog, escalating SIGTERM -> SIGKILL.
 *
 * FAIL-CLOSED: a timed-out run always returns a non-zero `exitCode` in addition
 * to `timedOut: true`, so a caller that only inspects the exit code still
 * treats the hang as a failure and can never report it as a pass.
 */
export async function spawnWithWatchdog(
  cmd: string[],
  options: WatchdogSpawnOptions
): Promise<WatchdogSpawnResult> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  // Monotonic clock: `Date.now()` can jump backwards or forwards (NTP step, DST
  // on some platforms, a manual clock change), which would misreport elapsed
  // time in the very diagnostic an operator reads to decide whether a run was
  // genuinely slow or genuinely hung. `performance.now()` cannot jump.
  const startedAt = performance.now();

  const proc = Bun.spawn(cmd, {
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdout: options.inheritStdio ? "inherit" : "pipe",
    stderr: options.inheritStdio ? "inherit" : "pipe",
    stdin: "ignore",
  });

  // Start draining BEFORE awaiting exit: a child that fills the pipe buffer
  // would otherwise block on write and never exit, turning output capture into
  // its own hang.
  const stdoutPromise = options.inheritStdio
    ? Promise.resolve("")
    : new Response(proc.stdout as ReadableStream).text();
  const stderrPromise = options.inheritStdio
    ? Promise.resolve("")
    : new Response(proc.stderr as ReadableStream).text();

  let timedOut = false;
  let requiredSigkill = false;

  const watchdog = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    // If the child is still alive after the grace period it either ignores
    // SIGTERM or is too wedged to service it. SIGKILL cannot be caught.
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        requiredSigkill = true;
        proc.kill("SIGKILL");
      }
    }, graceMs).unref?.();
  }, options.budgetMs);
  watchdog.unref?.();

  try {
    await proc.exited;
  } finally {
    clearTimeout(watchdog);
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (!options.inheritStdio) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }

  const rawExit = proc.exitCode;
  return {
    // Fail closed: a killed child reports exitCode null (it died by signal), and
    // a SIGTERM-ignoring child could even report 0 — neither may read as a pass.
    exitCode: timedOut ? (rawExit && rawExit !== 0 ? rawExit : 1) : (rawExit ?? 1),
    stdout,
    stderr,
    timedOut,
    requiredSigkill,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

/**
 * Human-readable diagnostic for a timed-out run. Names the budget and the
 * override so the operator can act without reading this file.
 */
export function formatWatchdogTimeout(
  label: string,
  budgetMs: number,
  result: WatchdogSpawnResult
): string {
  return (
    `${label} exceeded its ${Math.round(budgetMs / 1000)}s wall-clock watchdog ` +
    `(ran ${Math.round(result.elapsedMs / 1000)}s) and was terminated` +
    `${result.requiredSigkill ? " with SIGKILL after ignoring SIGTERM" : ""}. ` +
    `This is a HANG, not a test failure — see mt#3156. ` +
    `Raise the budget with MINSKY_TEST_WATCHDOG_MS=<ms> if the run is legitimately slow.`
  );
}
