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
 * ## Why no process-group kill, and what replaces it
 *
 * Killing a process GROUP (`process.kill(-pid, ...)`) requires the child to
 * lead its own group, which requires detaching it at spawn time. Bun's spawn
 * children inherit the parent's process group, so `-pid` would either fail or —
 * far worse — signal the RUNNER'S OWN group. `Bun.spawn` exposes no `detached`
 * option to change that (verified against the installed `bun-types`), so the
 * group route would mean abandoning `Bun.spawn` for Node's `child_process`.
 *
 * So each runner watchdogs its OWN direct child, with inner budgets strictly
 * smaller than outer ones, so a chain (gated -> main -> `bun test`) is reaped
 * leaf-first: the innermost watchdog fires before its parent's, killing the
 * actual `bun test` process rather than orphaning it.
 *
 * **That ordering is necessary but NOT sufficient, and mt#4098 is where it broke.**
 * It assumes `bun test` is a LEAF. It is not: a spawning test — e.g.
 * `src/commands/mcp/start-command.test.ts`, whose `spawnHttpMcp()` helper starts
 * a real `mcp start --http` server — puts a live process one level BELOW the
 * runner. Killing the runner does not kill what the runner started, and the
 * test's own `finally` teardown never runs, so those grandchildren reparent to
 * PID 1 with no supervisor at all. Two such orphans were found on 2026-08-13 at
 * 48.2 GB and 32 GB, both at ~99% CPU.
 *
 * The fix keeps `Bun.spawn` and signals EXPLICIT pids rather than a group: at
 * kill time we walk the descendant tree via `pgrep -P` and signal each pid
 * individually. A positive pid can never be mistaken for a group, so the hazard
 * in the first paragraph is designed out rather than guarded against.
 *
 * **Ordering is load-bearing:** the descendants are enumerated BEFORE the direct
 * child is signalled. Once the child dies its children reparent to PID 1, and
 * `pgrep -P <child>` returns nothing — snapshot first, then signal.
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
  /**
   * `run-related-tests.ts` -> `bun test` for ONE partition of the pre-commit
   * related set (mt#3765). Deliberately the tightest budget here, and sized on
   * a different principle than its siblings: they bound a run that MUST
   * complete, so they carry ~9x headroom over observed runtime. This one bounds
   * a run that is allowed NOT to complete — a pre-commit smoke whose authority
   * is `.husky/pre-push` + CI — so the budget is a latency ceiling for the
   * commit, not a completion guarantee.
   *
   * 60s against a measured 2.5s depth-3 set is ~24x headroom for the ordinary
   * case. The pathological case it will NOT cover is deliberate:
   * `src/commands/mcp/start-command.test.ts` alone measured 84.5s and 83.6s
   * (2026-08-08) because it spawns a real HTTP MCP server per test. No
   * pre-commit budget should wait that long; overrunning it is reported as a
   * timeout and deferred, not failed.
   */
  RELATED_TESTS_PARTITION: 60_000, // 60s
  /**
   * TOTAL wall-clock for the whole pre-commit related-test gate, across every
   * partition (mt#3765, PR #2733 R1).
   *
   * A per-partition budget alone does not bound the gate: a set that splits
   * into regular + cockpit-web + N services + M isolated src/mcp files can
   * spend PARTITION_BUDGET on each, so the total is unbounded in the number of
   * partitions. `related-tests-check.ts` wraps the whole gate at
   * RELATED_TESTS_WRAPPER and treats a kill as a hard FAILURE — so an
   * unbounded total would let two timed-out partitions (120s) blow the wrapper
   * and reintroduce exactly the unpassable state this task removed, on the one
   * path where the timeout is NOT reported as a deferral.
   *
   * The gate self-reports within this bound instead, leaving the wrapper as a
   * backstop that only fires on a genuine anomaly.
   */
  RELATED_TESTS_TOTAL: 90_000, // 90s
  /**
   * The OUTER wrapper in `src/hooks/related-tests-check.ts`. Must exceed
   * RELATED_TESTS_TOTAL with margin so the inner gate always gets to report
   * its own disposition; if this ever fires, the gate itself hung and a hard
   * failure is the correct answer.
   */
  RELATED_TESTS_WRAPPER: 150_000, // 150s
} as const;

/**
 * bun's PER-TEST timer (`--timeout`) for FULL-SUITE runs — mt#3704.
 *
 * Sized by the same method as the budgets above, which it had never received:
 * it was a flat `15000` copy-pasted into four runners, with no derivation and
 * no contention margin, while its neighbours here were deliberately set at ~9x
 * observed runtime.
 *
 * **Derivation.** Slowest SINGLE test this repo has measured, run alone: 10.8s
 * (mt#3875's `session-auto-task-creation` "should auto-create task when
 * description is provided"). Against the old 15s that is 1.4x margin. Applying
 * the ~9x convention above gives ~97s; rounded up to 100s, still >=9x the
 * observed maximum and an order of magnitude under `MAIN`, preserving the
 * outer > inner ordering this table depends on.
 *
 * **Why raising it is safe.** This timer is NOT the hang backstop and never
 * was: per `run-tests-main.ts`, it "never fires when a test blocks the event
 * loop synchronously" — the wall-clock watchdogs above own that case, with
 * SIGTERM -> SIGKILL escalation. Its only live function is cutting off tests
 * that are merely SLOW, which under full-suite contention is precisely the
 * false positive mt#3704 records four times over: six-plus distinct tests
 * across three files, each starving in-suite while the whole file passes in
 * ~200ms alone, each green on an unchanged retry.
 *
 * **Why NOT applied to narrow runs.** `package.json`'s `test:components` /
 * `test:hooks` / `test:eslint-rules`, and the single-file invocation documented
 * in `build-and-test.mdc`, deliberately keep 15s. They do not run against 800+
 * competing files, so they have no contention to absorb — and a tight timer is
 * useful feedback when you are iterating on one file. Every recorded starvation
 * was in the gated suite.
 */
export const FULL_SUITE_PER_TEST_TIMEOUT_MS = 100_000;

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
  /**
   * Working directory for the child. Undefined inherits this process's cwd.
   *
   * Added by mt#3765 for the pre-commit related-test gate, whose per-service
   * partitions MUST run from `services/<svc>/` — the root bunfig prunes
   * `services/**` even from explicitly-named paths (mt#3776), so a partition
   * that silently ran from the repo root would execute zero tests and still
   * look like a pass.
   */
  cwd?: string;
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
  /**
   * How many DESCENDANT processes the watchdog signalled — processes the child
   * itself spawned (mt#4098). Zero on a normal run, and zero on a timed-out run
   * whose child spawned nothing. A non-zero value is the diagnostic that says
   * this run would have leaked orphans before mt#4098.
   */
  reapedDescendants: number;
  /**
   * How many descendants ignored SIGTERM and had to be SIGKILLed (PR #2963 R1).
   *
   * Kept separate from `requiredSigkill` rather than folded into it: that flag
   * is documented as, and asserted by existing tests to be, a statement about
   * the DIRECT CHILD. Overloading it would make "the child ignored SIGTERM"
   * unrecoverable from the result. `formatWatchdogTimeout` surfaces both, so
   * the escalation is visible to an operator either way.
   */
  descendantsRequiredSigkill: number;
  /**
   * True when descendants could not be enumerated at all, so this run fell back
   * to the pre-mt#4098 child-only kill and may have orphaned processes.
   *
   * The designed observable for partial enforcement (PR #2963 R1): without it,
   * a machine missing both `ps` and `pgrep` reports exactly what a clean run
   * reports.
   */
  descendantScanFailed: boolean;
}

/**
 * Direct children of `pid`, via `pgrep -P`.
 *
 * Returns `null` when the MECHANISM is unavailable (the binary is missing), as
 * distinct from `[]`, which is the valid answer "this pid has no children".
 * Conflating those two is what would let an enumeration failure read as a clean
 * run — PR #2963 R1.
 */
function listChildPidsViaPgrep(pid: number): number[] | null {
  try {
    const probe = Bun.spawnSync(["pgrep", "-P", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // pgrep exits 1 with empty output when a pid simply has no children, which
    // is a successful ANSWER — so the exit code is deliberately not consulted.
    // Only a throw (binary missing) means the mechanism itself is unavailable.
    return parsePidList(probe.stdout.toString());
  } catch {
    return null;
  }
}

/**
 * One `ps` snapshot of the whole process table, as a ppid -> children map.
 * `null` when the snapshot could not be taken.
 *
 * Preferred over per-node `pgrep` for three reasons: it is ONE subprocess
 * rather than one per tree node; it is an ATOMIC view, where a tree assembled
 * from N separate `pgrep` calls can straddle a process exiting mid-walk; and
 * `ps` is POSIX-mandated where `pgrep` is not, so the primary mechanism is now
 * the more portable one.
 */
function readProcessTree(): Map<number, number[]> | null {
  try {
    const probe = Bun.spawnSync(["ps", "-ax", "-o", "ppid=,pid="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!probe.success) return null;

    const tree = new Map<number, number[]>();
    for (const line of probe.stdout.toString().split("\n")) {
      const fields = line.trim().split(/\s+/);
      const ppid = Number.parseInt(fields[0] ?? "", 10);
      const pid = Number.parseInt(fields[1] ?? "", 10);
      if (!Number.isInteger(ppid) || !Number.isInteger(pid) || pid <= 1) continue;
      const children = tree.get(ppid);
      if (children) children.push(pid);
      else tree.set(ppid, [pid]);
    }

    // An empty parse means the output shape was not what we expected, not that
    // the machine has no processes — which is never true on a running system.
    // Report it as mechanism failure so the fallback gets its turn.
    return tree.size > 0 ? tree : null;
  } catch {
    return null;
  }
}

/** Parse a newline-separated pid list, guarding the eventual signal target. */
function parsePidList(raw: string): number[] {
  return (
    raw
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      // Guard the signal target, not just the parse: a NaN, a 0 (our own process
      // group) or a 1 (init) reaching process.kill would be catastrophic in a way
      // a wrong-but-positive pid is not.
      .filter((candidate) => Number.isInteger(candidate) && candidate > 1)
  );
}

/** Outcome of enumerating a process's descendants. */
export interface DescendantScan {
  /** Descendants found, breadth-first, excluding the root. */
  pids: number[];
  /**
   * True when NO enumeration mechanism was available — so `pids` is empty
   * because we could not LOOK, not because there was nothing to find.
   *
   * That distinction is the point (PR #2963 R1). Without it, a machine with
   * neither `ps` nor `pgrep` silently reverts to the pre-mt#4098 child-only
   * kill while reporting exactly what a clean run reports.
   */
  enumerationFailed: boolean;
}

/**
 * Enumerate `rootPid`'s descendants, preferring the single `ps` snapshot and
 * falling back to per-node `pgrep`. Both mechanisms are injectable so the
 * no-mechanism-available path is testable without uninstalling anything.
 */
export function scanDescendants(
  rootPid: number,
  mechanisms: {
    processTree?: () => Map<number, number[]> | null;
    childrenViaPgrep?: (pid: number) => number[] | null;
  } = {}
): DescendantScan {
  const readTree = mechanisms.processTree ?? readProcessTree;
  const viaPgrep = mechanisms.childrenViaPgrep ?? listChildPidsViaPgrep;

  const tree = readTree();
  if (tree) {
    return {
      pids: collectDescendantPids(rootPid, (pid) => tree.get(pid) ?? []),
      enumerationFailed: false,
    };
  }

  // `ps` unavailable. Probe `pgrep` ONCE on the root to tell "no children" apart
  // from "no mechanism" — a walk would return [] either way, which is precisely
  // the ambiguity being removed here.
  if (viaPgrep(rootPid) === null) {
    return { pids: [], enumerationFailed: true };
  }

  return {
    pids: collectDescendantPids(rootPid, (pid) => viaPgrep(pid) ?? []),
    enumerationFailed: false,
  };
}

/**
 * Every descendant of `rootPid`, breadth-first, excluding `rootPid` itself
 * (the caller signals that one through the `Subprocess` handle).
 *
 * MUST be called BEFORE the root is signalled — see the module header's
 * "Ordering is load-bearing" note.
 */
export function collectDescendantPids(
  rootPid: number,
  childrenOf: (pid: number) => number[] = (pid) => listChildPidsViaPgrep(pid) ?? []
): number[] {
  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];

  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of childrenOf(current)) {
      // `seen` is a cycle guard, not an optimization. Pid reuse between the
      // pgrep calls could otherwise present a cycle and hang this loop inside a
      // watchdog timer — the one place a hang has no outer watchdog.
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }

  return descendants;
}

/**
 * `process.kill` is on the real `NodeJS.Process` type and present at runtime in
 * both Node and Bun, but this repo's legacy ambient `process` shim
 * (`src/types/node.d.ts`) omits it — the same gap `src/mcp/orphan-exit.ts`
 * documents for `process.ppid`, and the same cast it establishes.
 */
function rawKill(pid: number, signal: NodeJS.Signals | 0): void {
  // Intersection cast, not `as unknown as` — the narrower form the repo already
  // uses at `orphan-exit.ts:93` for the same shim gap, and the one
  // `custom/no-excessive-as-unknown` accepts.
  (process as typeof process & { kill(pid: number, signal: NodeJS.Signals | 0): void }).kill(
    pid,
    signal
  );
}

/** Whether `pid` still exists. Signal 0 checks liveness without delivering. */
function isProcessAlive(pid: number): boolean {
  try {
    rawKill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal `pid`, swallowing the race where it already exited. */
function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  try {
    rawKill(pid, signal);
    return true;
  } catch {
    // ESRCH: already gone — the outcome we wanted. EPERM: not ours to kill,
    // which no descendant of our own child should ever be.
    return false;
  }
}

/** How often to re-check whether SIGTERM'd descendants have exited. */
const SURVIVOR_POLL_MS = 100;

/**
 * Wait (bounded by `graceMs`) for already-SIGTERM'd descendants to exit, then
 * SIGKILL whatever is left. Returns how many needed the SIGKILL.
 *
 * Polls rather than sleeping the whole grace, so the common case — descendants
 * that die on SIGTERM immediately — costs one tick instead of the full 5s on
 * every timed-out run.
 */
async function killSurvivors(pids: number[], graceMs: number): Promise<number> {
  const deadline = performance.now() + graceMs;
  let survivors = pids.filter(isProcessAlive);

  while (survivors.length > 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SURVIVOR_POLL_MS));
    survivors = survivors.filter(isProcessAlive);
  }

  let killed = 0;
  for (const pid of survivors) {
    if (signalPid(pid, "SIGKILL")) killed++;
  }
  return killed;
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
    ...(options.cwd ? { cwd: options.cwd } : {}),
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
  let reapedDescendants = 0;
  let descendantsRequiredSigkill = 0;
  let descendantScanFailed = false;
  let descendants: number[] = [];

  const watchdog = setTimeout(() => {
    timedOut = true;
    // Snapshot BEFORE signalling the child: once it dies, its children reparent
    // to PID 1 and are no longer reachable through its parent links (mt#4098).
    const scan = scanDescendants(proc.pid);
    descendants = scan.pids;
    descendantScanFailed = scan.enumerationFailed;
    if (scan.enumerationFailed) {
      // Loud, not silent (PR #2963 R1). This run degrades to the pre-mt#4098
      // child-only kill; saying so on stderr puts it in the CI log next to the
      // timeout that caused it, and `descendantScanFailed` carries it to callers.
      process.stderr.write(
        "[mt#4098] WARNING: could not enumerate descendants — neither `ps` nor `pgrep` " +
          "is available. Killing only the direct child; anything it spawned may be orphaned.\n"
      );
    }
    proc.kill("SIGTERM");
    for (const pid of descendants) {
      if (signalPid(pid, "SIGTERM")) reapedDescendants++;
    }
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

  // Descendant SIGKILL escalation runs HERE, awaited, rather than in an unref'd
  // timer beside the child's. A wedged descendant is the case that matters —
  // exactly the one that ignores SIGTERM — and an unref'd timer is not
  // guaranteed to fire before the runner exits, so the escalation that only
  // matters for a wedged process is the one a fire-and-forget timer would drop.
  if (descendants.length > 0) {
    descendantsRequiredSigkill = await killSurvivors(descendants, graceMs);
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
    reapedDescendants,
    descendantsRequiredSigkill,
    descendantScanFailed,
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
    // A descendant escalation is invisible in `requiredSigkill` by design (that
    // flag is about the direct child), so it is named here instead — otherwise a
    // run where a wedged grandchild needed SIGKILL reads identically to a clean
    // one. PR #2963 R1.
    `${
      result.reapedDescendants > 0
        ? `Also signalled ${result.reapedDescendants} descendant process(es)` +
          `${
            result.descendantsRequiredSigkill > 0
              ? `, ${result.descendantsRequiredSigkill} of which required SIGKILL`
              : ""
          }. `
        : ""
    }` +
    `${
      result.descendantScanFailed
        ? "Descendants could NOT be enumerated (neither `ps` nor `pgrep` available), so " +
          "only the direct child was killed — anything it spawned may still be running. "
        : ""
    }` +
    `This is a HANG, not a test failure — see mt#3156. ` +
    `Raise the budget with MINSKY_TEST_WATCHDOG_MS=<ms> if the run is legitimately slow.`
  );
}
