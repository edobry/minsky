/**
 * mt#3764: HTTP-mode `mcp start` orphan/idle process exit path.
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
