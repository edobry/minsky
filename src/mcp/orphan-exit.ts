/**
 * Self-termination watchers for MCP server and proxy processes.
 *
 * Two families live here, and they are armed from different places
 * because they answer different questions:
 *
 *  - mt#3764's orphan/idle watchers (1 and 2 below) are HTTP-mode only,
 *    wired via `wireOrphanExitWatchers` from `start-command.ts`. Both are
 *    about an abandoned HTTP listener; neither has a stdio meaning
 *    (`hasEverConnected` is an HTTP-session concept, and stdio parent
 *    death already arrives as `process.stdin` close).
 *  - mt#3886's resident-memory ceiling (3 below) is TRANSPORT-INDEPENDENT
 *    and wired via `wireMemoryCeilingWatcher` from both `start-command.ts`
 *    and the `mcp proxy` CLI. Today's per-conversation fleet runs the
 *    inner server over STDIO, so gating it on HTTP the way (1) and (2)
 *    are gated would leave the entire real-world fleet unguarded.
 *
 * mt#3764 context:
 *
 * On 2026-08-05 an orphaned `mcp start --http` process (PPID 1, listener
 * gone, 16h38m old) was found at 4083MB RSS / 65% CPU — it ignored SIGTERM
 * and required SIGKILL. This module gives HTTP-mode `mcp start` two
 * independent, testable self-termination mechanisms so an abandoned
 * process cannot run indefinitely:
 *
 *  1. Parent-death detection — poll `process.ppid` for a change from its
 *     startup value (macOS has no `PR_SET_PDEATHSIG`; polling is the
 *     portable pattern). This fires on a TRANSITION only, never on the
 *     ppid observed at startup — see `looksLikeHostedEntrypoint` below for
 *     why that distinction is load-bearing.
 *  2. Never-connected idle exit — if no HTTP MCP session has EVER been
 *     established within a bounded startup window, self-terminate.
 *     Complements the existing `SESSION_IDLE_TIMEOUT_MS` reaper in
 *     `server.ts`, which only reaps sessions that were created — this
 *     covers the case where a process was spawned and no client ever
 *     connected at all.
 *
 * Both watchers are pure functional cores (injected clock/state, no
 * `process` or timer globals reached for directly) wired to `process`
 * only from `start-command.ts` — see `testing-standards.mdc §Testable
 * Design`.
 *
 * Hosted-deployment safety (Railway): the root `Dockerfile`'s CMD uses
 * shell form (`CMD bun run ... mcp start --http ...`), which Docker runs
 * as `/bin/sh -c "..."` — making the `bun` process a *child of that shell*,
 * which is the container's PID-1 process. So the hosted server's ppid is
 * 1 from the very first tick, and stays 1 for the life of the container
 * (the shell never exits until the container is torn down). That means:
 *   - The parent-death watcher never fires for the hosted deployment: a
 *     transition never happens because there is nothing else to transition
 *     TO — ppid is 1 at t=0 and stays 1 forever. No special-casing needed.
 *   - The never-connected watcher WOULD be a hazard for the hosted
 *     deployment if armed unconditionally: a freshly-deployed Railway
 *     server can legitimately sit for longer than any reasonable idle
 *     window before the first client connects. `looksLikeHostedEntrypoint`
 *     reuses the same ppid-at-startup signal to skip arming it there.
 */

import { log } from "@minsky/shared/logger";
import { readProcessMemory } from "@minsky/shared/process-memory";

/** Default poll interval (ms) for the parent-death watcher. */
export const DEFAULT_PARENT_DEATH_POLL_INTERVAL_MS = 5_000;

/**
 * Default bounded window (ms) to wait for a first-ever HTTP MCP session
 * before self-terminating. Deliberately much larger than any CI/smoke
 * boot-probe window (bundle-boot-smoke and smoke-no-postgres-boot each
 * poll /health for up to 30s and then tear the process down themselves) —
 * a GET /health probe does not establish an MCP session, so those smoke
 * runs would otherwise race this watcher.
 */
export const DEFAULT_NEVER_CONNECTED_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface StoppableWatcher {
  stop: () => void;
}

/** Parse a positive-integer env var, returning `undefined` for absent/invalid values. */
export function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Read the current process's ppid. `process.ppid` is on the real
 * NodeJS.Process type (and present at runtime in both Node and Bun), but
 * this repo's legacy ambient `process` shim (`src/types/node.d.ts`) omits
 * it — mirrors the identical cast already established in
 * `server.ts`'s `resolveAgentId` call site.
 */
export function getCurrentProcessPpid(): number {
  return (process as typeof process & { ppid: number }).ppid;
}

export interface ParentDeathWatcherOptions {
  /** ppid recorded once, at process startup. */
  initialPpid: number;
  /** Returns the CURRENT ppid. Injected so tests don't depend on the real `process`. */
  getCurrentPpid: () => number;
  pollIntervalMs?: number;
  /** Injectable so tests can assert without real timers. Defaults to `setInterval`/`clearInterval`. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onParentDeath: (detected: { initialPpid: number; currentPpid: number }) => void;
}

/**
 * Poll `process.ppid` for a change from its startup value. Fires
 * `onParentDeath` at most once per watcher (call `.stop()` from inside the
 * callback, or let the caller do it, to avoid repeat firing while the
 * process is exiting).
 */
export function startParentDeathWatcher(options: ParentDeathWatcherOptions): StoppableWatcher {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PARENT_DEATH_POLL_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  let stopped = false;
  const timer = setIntervalFn(() => {
    if (stopped) return;
    const currentPpid = options.getCurrentPpid();
    if (currentPpid !== options.initialPpid) {
      stopped = true;
      clearIntervalFn(timer);
      options.onParentDeath({ initialPpid: options.initialPpid, currentPpid });
    }
  }, pollIntervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

export interface NeverConnectedWatcherOptions {
  timeoutMs?: number;
  /** Returns true once any HTTP MCP session has EVER been established. */
  hasEverConnected: () => boolean;
  /** Injectable so tests can assert without real timers. Defaults to `setTimeout`/`clearTimeout`. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  onTimeout: () => void;
}

/**
 * Arm a one-shot timer that fires `onTimeout` if `hasEverConnected()` is
 * still false once `timeoutMs` elapses. If a session has connected by
 * then, the timer is a no-op (and the caller may `.stop()` it early once
 * the first session connects, though this is optional — an already-true
 * `hasEverConnected()` check at fire time is sufficient).
 */
export function startNeverConnectedWatcher(
  options: NeverConnectedWatcherOptions
): StoppableWatcher {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NEVER_CONNECTED_TIMEOUT_MS;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

  const timer = setTimeoutFn(() => {
    if (!options.hasEverConnected()) {
      options.onTimeout();
    }
  }, timeoutMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop: () => clearTimeoutFn(timer),
  };
}

/**
 * True when the process's ppid AT STARTUP is 1 — the signature of the
 * Railway/Docker hosted entrypoint (the Dockerfile CMD's shell form makes
 * `bun` a direct child of the container's PID-1 shell from the first
 * tick, never reparented into that state later). Used to gate the
 * never-connected watcher: a process that starts with ppid 1 is treated
 * as hosted-shaped and does not get the never-connected watcher armed by
 * default, because a legitimate hosted deployment can sit unconnected
 * far longer than any bounded local/test window without being abandoned.
 *
 * Deliberately NOT used to gate the parent-death watcher — that one is
 * self-gating via the transition check (`looksLikeHostedEntrypoint` would
 * be redundant there: a process that starts at ppid 1 and stays there
 * never trips a transition regardless).
 */
export function looksLikeHostedEntrypoint(initialPpid: number): boolean {
  return initialPpid === 1;
}

export interface NeverConnectedArmDecision {
  initialPpid: number;
  /** MINSKY_MCP_FORCE_NEVER_CONNECTED_EXIT=1 — arm regardless of the hosted signature. */
  forceEnable: boolean;
  /** MINSKY_MCP_DISABLE_NEVER_CONNECTED_EXIT=1 — never arm, regardless of anything else. */
  forceDisable: boolean;
}

/**
 * Pure decision function for whether the never-connected watcher should be
 * armed. Extracted from the wiring in `start-command.ts` so the hosted-
 * deployment safety gate (AT3) is unit-testable without spawning a real
 * process tree or a container.
 */
export function shouldArmNeverConnectedWatcher(decision: NeverConnectedArmDecision): boolean {
  if (decision.forceDisable) return false;
  if (decision.forceEnable) return true;
  return !looksLikeHostedEntrypoint(decision.initialPpid);
}

export interface WireOrphanExitWatchersOptions {
  initialPpid: number;
  getCurrentPpid: () => number;
  hasEverConnected: () => boolean;
  onExit: (reason: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Wire both watchers per the current env-var configuration. Thin
 * imperative shell over the pure pieces above — kept small and free of
 * `process` reads beyond the injected `env`/`getCurrentPpid`/
 * `hasEverConnected` so it stays testable, but this is the function
 * `start-command.ts` actually calls.
 */
export function wireOrphanExitWatchers(options: WireOrphanExitWatchersOptions): StoppableWatcher {
  const env = options.env ?? process.env;
  const watchers: StoppableWatcher[] = [];

  if (env.MINSKY_MCP_DISABLE_PARENT_DEATH_EXIT !== "1") {
    watchers.push(
      startParentDeathWatcher({
        initialPpid: options.initialPpid,
        getCurrentPpid: options.getCurrentPpid,
        pollIntervalMs: parsePositiveIntEnv(env.MINSKY_MCP_PARENT_DEATH_POLL_MS),
        onParentDeath: ({ initialPpid, currentPpid }) => {
          log.cli(
            `[mt#3764] Parent process died (ppid changed ${initialPpid} -> ${currentPpid}); exiting orphaned HTTP MCP server`
          );
          options.onExit("parent-death");
        },
      })
    );
  }

  const armNeverConnected = shouldArmNeverConnectedWatcher({
    initialPpid: options.initialPpid,
    forceEnable: env.MINSKY_MCP_FORCE_NEVER_CONNECTED_EXIT === "1",
    forceDisable: env.MINSKY_MCP_DISABLE_NEVER_CONNECTED_EXIT === "1",
  });

  if (armNeverConnected) {
    watchers.push(
      startNeverConnectedWatcher({
        timeoutMs: parsePositiveIntEnv(env.MINSKY_MCP_NEVER_CONNECTED_TIMEOUT_MS),
        hasEverConnected: options.hasEverConnected,
        onTimeout: () => {
          log.cli(
            "[mt#3764] No MCP client ever connected within the startup window; self-terminating idle HTTP server"
          );
          options.onExit("never-connected");
        },
      })
    );
  } else {
    log.debug(
      "[mt#3764] Skipping never-connected idle-exit watcher (hosted-entrypoint ppid signature, or explicit override)",
      { initialPpid: options.initialPpid }
    );
  }

  return {
    stop: () => watchers.forEach((w) => w.stop()),
  };
}

/* ------------------------------------------------------------------ *
 * mt#3886: resident-memory ceiling
 * ------------------------------------------------------------------ */

/**
 * Default resident-memory ceiling, in MB.
 *
 * Derived from observed values per `decision-defaults.mdc §Thresholds`,
 * not picked as a round number:
 *
 *   - ADR-038's live census (2026-08-06, 50 inner servers): mean 63.5 MB;
 *     `mcp proxy` mean 55.5 MB.
 *   - The 2026-08-08 panic stackshot: 43 of 46 `bun` processes sat at
 *     0.38-0.44 GB — the top of the observed NORMAL band.
 *   - mt#3811's daemon-under-load samples (N=1/5/10): an 84-257 MB band,
 *     non-monotonic in N (GC burst-and-decay, not session count).
 *   - The pathological tail that panicked the machine: 15.5 GB, 54.2 GB,
 *     59.9 GB in ONE stackshot, against 64 GB of physical RAM.
 *   - mt#3764's orphan, a case this codebase has already seen: 4083 MB.
 *
 * 2048 MB sits ~4.5x above the top of the observed normal band (leaving
 * room for a heavier workload than any yet measured, including a future
 * shared daemon per ADR-038), BELOW mt#3764's 4083 MB orphan so that a
 * repeat of that case is caught on memory as well as on idleness, and
 * ~7x below the SMALLEST of the three processes that took the machine
 * down. Capping the 2026-08-08 giants here would have held them to ~6 GB
 * combined instead of ~130 GB.
 *
 * ## Restated for the unit change (mt#4104)
 *
 * Every figure above is in RSS. The reading is now `phys_footprint` (macOS) /
 * `VmRSS + VmSwap` (Linux), and the two are NOT interconvertible — RSS counts
 * clean file-backed pages the kernel does not charge the task, and misses
 * swapped-out pages it does.
 *
 * Re-measured 2026-08-13 across 11 live `mcp start` processes plus the cockpit
 * daemon: the idle band is **210-413 MB** in footprint units, against mt#3973's
 * RSS-measured 427-644 MB. The band is both LOWER and tighter — the same two
 * processes read 44-56 MB RSS against 215-384 MB footprints, so RSS was
 * scattering the band in both directions rather than tracking it.
 *
 * **2048 MB is deliberately KEPT.** It now sits ~5x above the band top rather
 * than the ~4.5x computed above, so the unit change GAINS headroom rather than
 * losing it, and the ceiling's job is to bound a runaway well short of machine
 * exhaustion — not to sit tight against the idle band, where the only thing a
 * lower number buys is false positives. The bound that mattered is unchanged:
 * still below mt#3764's 4083 MB orphan, still far below the pathological tail.
 *
 * **Not made per-platform, and here is the limit of that claim:** only macOS
 * was measurable from where this was derived. The hosted Railway surface is
 * Linux and its band is UNMEASURED; mt#3888 owns whether to arm the ceiling
 * there and at what limit, and this band is not evidence about it.
 */
export const DEFAULT_MEMORY_CEILING_MB = 2048;

/** Default poll interval (ms) for the resident-memory ceiling watcher. */
export const DEFAULT_MEMORY_CEILING_POLL_INTERVAL_MS = 30_000;

const BYTES_PER_MB = 1024 * 1024;

/**
 * Read the current process's swap-inclusive memory in bytes, or `null` when it
 * could not be measured.
 *
 * Was `getCurrentProcessMemoryBytes`, reading `process.memoryUsage.rss()`
 * (mt#4104). RSS was the wrong quantity in the most consequential direction: it
 * FALLS as the OS swaps a process out, so the 2026-08-13 specimen read ~900 MB
 * while holding 48.2 GB and never tripped a 2048 MB ceiling. Measured on the
 * live fleet the same day, 2 of 11 MCP processes read 44-56 MB RSS against
 * 215-384 MB footprints — the same inversion, already happening, just not yet
 * at a dangerous scale.
 *
 * `null` rather than a fallback number: see `readProcessMemory`'s union.
 */
export function getCurrentProcessMemoryBytes(): number | null {
  const result = readProcessMemory(process.pid);
  return result.ok ? result.bytes : null;
}

/**
 * Seconds this process has been running. Same ambient-shim gap as
 * `getCurrentProcessPpid` and `getCurrentProcessMemoryBytes` — hoisted
 * here rather than cast at each call site, since both `start-command.ts`
 * and the proxy CLI need it for the breach record.
 */
export function getCurrentProcessUptimeSeconds(): number {
  return (process as typeof process & { uptime: () => number }).uptime();
}

/** Details of a ceiling breach, passed to the callback and logged before exit. */
export interface MemoryCeilingBreach {
  residentBytes: number;
  ceilingBytes: number;
}

export interface ResidentMemoryCeilingWatcherOptions {
  ceilingBytes: number;
  /**
   * Returns the process's swap-inclusive memory, or `null` when it could not be
   * measured (mt#4104). Injected so tests don't depend on the real `process`.
   *
   * `null` is not zero and not "fine": an unmeasurable tick is skipped, because
   * the alternative — substituting a number — is what let an RSS reading that
   * collapses under swap pass for a healthy process while it held 48 GB.
   */
  getResidentBytes: () => number | null;
  pollIntervalMs?: number;
  /** Injectable so tests can assert without real timers. Defaults to `setInterval`/`clearInterval`. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /**
   * Keep polling after a breach instead of disarming (mt#4112).
   *
   * The one-shot default is correct for the original caller, which EXITS on
   * breach — repeat firing during its own teardown would be noise. It is wrong
   * for a supervisor that OUTLIVES the process it is measuring: the stdio
   * proxy kills and respawns its child, so a one-shot watcher would bound the
   * first runaway and then sit disarmed for the rest of the proxy's lifetime,
   * leaving every subsequent child unguarded. That failure is invisible —
   * nothing errors, and the first kill looks like the mechanism working.
   *
   * A repeating watcher can fire again while the caller is still handling the
   * previous breach, so a caller that opts in owns its own re-entrancy guard.
   */
  repeatAfterBreach?: boolean;
  onCeilingExceeded: (breach: MemoryCeilingBreach) => void;
}

/**
 * Poll resident memory and fire `onCeilingExceeded` the first time it is
 * at or above `ceilingBytes`. Fires at most once per watcher by default,
 * mirroring `startParentDeathWatcher`'s one-shot semantics — the process is
 * exiting, so repeat firing during teardown would be noise. Pass
 * `repeatAfterBreach` when the caller survives the breach (mt#4112).
 */
export function startResidentMemoryCeilingWatcher(
  options: ResidentMemoryCeilingWatcherOptions
): StoppableWatcher {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_MEMORY_CEILING_POLL_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  let stopped = false;
  const timer = setIntervalFn(() => {
    if (stopped) return;
    const residentBytes = options.getResidentBytes();
    // Skip, do not substitute (mt#4104). An unmeasurable tick tells us nothing;
    // treating it as 0 would silently disarm the ceiling for the whole run.
    if (residentBytes === null) return;
    if (residentBytes >= options.ceilingBytes) {
      if (!options.repeatAfterBreach) {
        stopped = true;
        clearIntervalFn(timer);
      }
      options.onCeilingExceeded({ residentBytes, ceilingBytes: options.ceilingBytes });
    }
  }, pollIntervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

/**
 * The configured kill ceiling, in bytes.
 *
 * Extracted (mt#3973) so the capture watermark can be validated against the
 * SAME value the kill path uses. Reading `MINSKY_MCP_MEMORY_CEILING_MB` a
 * second time in the capture module would let the two drift the moment either
 * side's default or parsing changed, and a watermark silently above the ceiling
 * is a watcher that can never fire.
 */
export function resolveMemoryCeilingBytes(env: NodeJS.ProcessEnv = process.env): number {
  const ceilingMb =
    parsePositiveIntEnv(env.MINSKY_MCP_MEMORY_CEILING_MB) ?? DEFAULT_MEMORY_CEILING_MB;
  return ceilingMb * BYTES_PER_MB;
}

export interface MemoryCeilingArmDecision {
  initialPpid: number;
  /** MINSKY_MCP_FORCE_MEMORY_CEILING_EXIT=1 — arm even on the hosted entrypoint. */
  forceEnable: boolean;
  /** MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT=1 — never arm, regardless of anything else. */
  forceDisable: boolean;
}

/**
 * Whether the memory-ceiling watcher should be armed.
 *
 * Deliberately mirrors `shouldArmNeverConnectedWatcher`, including the
 * hosted-entrypoint skip. The skip is NOT because an unbounded hosted
 * server is safe — it is the same hazard — but because arming a new
 * self-kill path in a shared production service is a change to
 * production behavior that the operator authorizes, not one that rides
 * along with a local fix (`principal-context.mdc §Decisions Eugene
 * reserves`: authorization for shared/production state changes). The
 * hosted deployment opts in with MINSKY_MCP_FORCE_MEMORY_CEILING_EXIT=1
 * once a ceiling appropriate to the container's memory limit is chosen.
 */
export function shouldArmMemoryCeilingWatcher(decision: MemoryCeilingArmDecision): boolean {
  if (decision.forceDisable) return false;
  if (decision.forceEnable) return true;
  return !looksLikeHostedEntrypoint(decision.initialPpid);
}

export interface WireMemoryCeilingWatcherOptions {
  initialPpid: number;
  /**
   * Override the memory reader. `null` means "could not measure" and is
   * propagated to the watcher, which skips that tick (mt#4104).
   *
   * PR #2968 R1: this stayed `() => number` while the watcher it feeds moved to
   * `() => number | null`. It typechecked — the default `getCurrentProcessMemoryBytes`
   * widens the union at the call site — so nothing failed; the cost was that a
   * caller could not inject a null-returning reader through this seam at all,
   * which is exactly the new behavior. A type that compiles and still forbids
   * the intended use is the shape this note exists to prevent recurring.
   */
  getResidentBytes?: () => number | null;
  /**
   * Names the process class in the breach record — `"mcp start"` or
   * `"mcp proxy"`. The panic stackshot that motivated this carried no
   * argv, so which of the two ballooned was never determined; recording
   * it here is what lets mt#3885 answer that next time.
   */
  processRole: string;
  /** Seconds this process has been running, at breach time. */
  getUptimeSeconds: () => number;
  /** Optional extra state for the breach record (e.g. HTTP ever-connected). */
  getDiagnostics?: () => Record<string, unknown>;
  onExit: (reason: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Injectable so tests can assert the env-var wiring without real timers. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * Arm the resident-memory ceiling per the current env-var configuration.
 *
 * Separate from `wireOrphanExitWatchers` because that function is called
 * only in HTTP mode, and this watcher must also cover the stdio inner
 * server and the proxy — see the module header.
 */
export function wireMemoryCeilingWatcher(
  options: WireMemoryCeilingWatcherOptions
): StoppableWatcher {
  const env = options.env ?? process.env;

  const armed = shouldArmMemoryCeilingWatcher({
    initialPpid: options.initialPpid,
    forceEnable: env.MINSKY_MCP_FORCE_MEMORY_CEILING_EXIT === "1",
    forceDisable: env.MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT === "1",
  });

  if (!armed) {
    log.debug(
      "[mt#3886] Skipping resident-memory ceiling watcher (hosted-entrypoint ppid signature, or explicit override)",
      { initialPpid: options.initialPpid, processRole: options.processRole }
    );
    return { stop: () => {} };
  }

  const ceilingBytes = resolveMemoryCeilingBytes(env);

  return startResidentMemoryCeilingWatcher({
    ceilingBytes,
    getResidentBytes: options.getResidentBytes ?? getCurrentProcessMemoryBytes,
    pollIntervalMs: parsePositiveIntEnv(env.MINSKY_MCP_MEMORY_CEILING_POLL_MS),
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    onCeilingExceeded: ({ residentBytes, ceilingBytes }) => {
      // Emitted BEFORE the exit call: this record is the only forensic
      // trace a breach leaves, and mt#3885 needs it to narrow which
      // allocation path grows a server to tens of GB. Exiting first
      // would lose exactly the evidence the exit exists to collect.
      log.cli(
        `[mt#3886] Resident memory ${Math.round(residentBytes / BYTES_PER_MB)}MB reached the ` +
          `${Math.round(ceilingBytes / BYTES_PER_MB)}MB ceiling; self-terminating ${options.processRole}`
      );
      log.error("[mt#3886] MCP process exceeded resident-memory ceiling", {
        processRole: options.processRole,
        residentBytes,
        ceilingBytes,
        uptimeSeconds: options.getUptimeSeconds(),
        ...(options.getDiagnostics?.() ?? {}),
      });
      options.onExit("memory-ceiling");
    },
  });
}
