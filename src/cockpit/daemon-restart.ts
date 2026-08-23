/**
 * Supervision-independent daemon restart/stop (mt#4232).
 *
 * `minsky cockpit restart` and `stop` were launchd-only: both opened by checking
 * for `~/Library/LaunchAgents/com.minsky.cockpit.plist` and threw "No cockpit
 * daemon installed" without it. Under the tray-supervised setup ADR-014 makes
 * the DEFAULT, that plist does not exist, so the only working restart was a GUI
 * menu click — which an agent applying a fix cannot perform.
 *
 * **The process is the universal restart interface, so this is not supervision-
 * AWARE.** Both supervisors already implement "child exits with the port free →
 * respawn": the tray's `handle_child_exit` respawns on `CleanStop | Crash |
 * CeilingKill` (`cockpit-tray/src-tauri/src/supervisor.rs`), and the launchd
 * plist carries `KeepAlive { SuccessfulExit: false }`, which respawns a
 * signal-killed process. So signalling the pid works under either, and a
 * supervision-aware restart would re-introduce exactly the split-ownership
 * branching ADR-014 exists to end. No tray IPC is involved.
 *
 * **Confirmation is observed, not assumed.** Sending a signal is an action; the
 * outcome is a DIFFERENT process serving the port, which `processStartedAtMs`
 * (mt#2578) exists to detect. Reporting success on having called `kill` would
 * report success in every case where the supervisor failed to bring it back.
 *
 * **The signal target is identity-checked before it is signalled.** We only ever
 * signal a pid that a payload asserting `service: "minsky-cockpit"` reported as
 * its own. That matters because a pid is a reusable integer — the discipline
 * `process-identity.ts` records as BINDING (the "Conversation-first drive" RFC's
 * R1 expert review) for exactly this reason.
 *
 * Decision logic is separated from IO so it is testable without patching
 * `fetch`, `execSync`, or `process.kill` in place (ADR-036).
 *
 * @see ./launchd.ts — plist management + `getDaemonStatus`
 * @see ./port-recovery.ts — `findPortHolder` / `isProcessAlive`, reused here
 * @see ./routes/health.ts — emits the `pid` this resolves against
 */

import { COCKPIT_SERVICE_IDENTITY, findPortHolder, isProcessAlive } from "./port-recovery";
import { killIfIdentityMatches } from "./process-identity";
import { DEFAULT_DAEMON_PORT, readPid } from "./launchd";

/**
 * The argv substring that identifies a cockpit daemon, checked against the LIVE
 * command line immediately before signalling (PR #3097 R1, BLOCKING).
 *
 * **Measured against both spawn paths, not guessed.** launchd's plist builds
 * `[bun, run, src/cli.ts, cockpit, start, --no-dev-chromium, --port, N]`
 * (`launchd.ts` `generatePlist`), and the tray's `cockpit_spawn_args` produces
 * the same subcommand pair — confirmed against the live tray-supervised daemon
 * on 2026-08-18, where `"cockpit start"` matched and, notably, `"minsky"` did
 * NOT (the daemon runs through `bun run src/cli.ts`, never the `minsky` bin).
 * That is worth recording: the intuitive substring is the one that silently
 * fails, and its failure mode is `killIfIdentityMatches` returning false, which
 * is indistinguishable from "nothing to kill" at the call site.
 */
export const COCKPIT_DAEMON_CMD_SUBSTRING = "cockpit start";

/**
 * How long to wait for a supervisor to bring the daemon back.
 *
 * Sized from the SLOWER supervisor's own constant rather than a round number
 * (`decision-defaults.mdc §Thresholds`): the launchd plist sets
 * `ThrottleInterval 60`, so launchd will not relaunch the job sooner than 60s
 * after it exits. 75s is that plus boot headroom.
 *
 * The tray is far faster — `POLL_INTERVAL` 5s + `RESPAWN_THROTTLE` 5s in
 * `daemon_core.rs`, so ~10s plus boot — and costs nothing here, because the poll
 * below returns as soon as it OBSERVES the restart. Only the launchd case ever
 * waits near this budget.
 */
export const RESTART_CONFIRM_BUDGET_MS = 75_000;

/**
 * How long to watch for a respawn before calling a stop successful.
 *
 * Only the externally-supervised path uses this: under launchd, `stop` unloads
 * the agent, which prevents the respawn outright rather than racing it. So the
 * window is sized from the TRAY's ~10s worst case, not launchd's 60s.
 */
export const STOP_OBSERVE_BUDGET_MS = 15_000;

/** Poll cadence while waiting; well under either supervisor's respawn latency. */
export const RESTART_POLL_INTERVAL_MS = 1_000;

/** The fields `/api/health` supplies to a restart decision. */
export interface ServingProcess {
  /** `process.pid` self-reported by the daemon; null on a build predating mt#4232. */
  pid: number | null;
  /** Epoch-ms of this process's start (mt#2578). A CHANGE is what confirms a restart. */
  processStartedAtMs: number | null;
  /** The payload's service discriminator — asserted before anything is signalled. */
  service: string | null;
}

/**
 * What a restart or stop actually did.
 *
 * A discriminated union rather than a boolean, because the outcomes callers must
 * word differently are genuinely distinct — in particular "the supervisor
 * brought it back" and "nothing brought it back" are BOTH successful signals and
 * only one of them is a restart.
 */
export type DaemonSignalOutcome =
  /** Nothing answered on the port; there is no process to signal. */
  | { kind: "not-running" }
  /** Something answers, but it is not ours. Never signalled — see the module docblock. */
  | { kind: "foreign-service"; service: string | null }
  /** Ours, but neither health nor the port would name a pid. Never signalled. */
  | { kind: "pid-unresolved" }
  /** Signalled; a supervisor brought a DIFFERENT process back on the port. */
  | { kind: "restarted"; pid: number; waitedMs: number }
  /** Signalled; it exited and nothing brought it back (no supervisor present). */
  | { kind: "stopped"; pid: number }
  /** Signalled; still alive and still serving when the budget elapsed. */
  | { kind: "still-running"; pid: number }
  /** The signal itself failed (gone already, or not ours to signal). */
  | { kind: "signal-failed"; pid: number; reason: string };

/** The IO a restart decision needs, injected so the decision is testable (ADR-036). */
export interface RestartProbes {
  /** Health fields when the port answers as a service, or null when it does not. */
  serving(port: number): Promise<ServingProcess | null>;
  /** Pid holding the port — the fallback when health carries none. */
  portHolderPid(port: number): number | null;
  /**
   * Signal the pid, verifying its live command line first.
   *
   * Returns a result rather than throwing because the sanctioned primitive
   * behind it (`killIfIdentityMatches`) deliberately collapses "identity did not
   * match" and "the kill itself failed" into one negative — both mean no signal
   * was delivered, and neither is recoverable here.
   */
  signal(
    pid: number,
    signal: NodeJS.Signals
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Whether a pid is still alive. */
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  /** Monotonic-ish clock, injected so a test need not actually wait. */
  now(): number;
}

/**
 * Has the daemon on the port been REPLACED by a different process?
 *
 * Two independent discriminators, because either one can be missing:
 *
 * - `processStartedAtMs` differing is the primary signal, and the only one that
 *   works when a recycled pid happens to match.
 * - The pid differing covers a payload without `processStartedAtMs`.
 *
 * A pid that is present and UNCHANGED is treated as not-yet-restarted even if
 * the start time appears to differ — that combination means we are reading the
 * same process, so the start time is the field to distrust.
 */
export function isRestartConfirmed(
  before: ServingProcess,
  after: ServingProcess,
  signalledPid: number
): boolean {
  if (after.pid !== null && after.pid === signalledPid) return false;
  if (after.pid !== null && after.pid !== signalledPid) return true;
  if (before.processStartedAtMs !== null && after.processStartedAtMs !== null) {
    return before.processStartedAtMs !== after.processStartedAtMs;
  }
  // Neither discriminator is available. Refuse to claim a restart rather than
  // guess: an unconfirmed restart reported as confirmed is the failure this
  // whole path exists to avoid.
  return false;
}

/** Options shared by the restart and stop decisions. */
export interface SignalOptions {
  /** Budget for the post-signal observation. Defaults per operation. */
  budgetMs?: number;
  pollIntervalMs?: number;
}

/**
 * Resolve the pid to signal, asserting identity first.
 *
 * Returns a terminal outcome when there is nothing to signal, so both callers
 * below share one identity gate rather than each re-implementing it.
 */
async function resolveSignalTarget(
  port: number,
  probes: RestartProbes
): Promise<
  { ok: true; pid: number; before: ServingProcess } | { ok: false; outcome: DaemonSignalOutcome }
> {
  const before = await probes.serving(port);
  if (!before) return { ok: false, outcome: { kind: "not-running" } };

  if (before.service !== COCKPIT_SERVICE_IDENTITY) {
    // Something else holds the port. mt#3148 is the precedent: every Minsky
    // service builds from one monorepo and answers 200 identically, so the
    // status code cannot tell them apart — and this is a path that SIGNALS what
    // it finds, which makes guessing unacceptable rather than merely sloppy.
    return { ok: false, outcome: { kind: "foreign-service", service: before.service } };
  }

  // Health's own pid first: it is self-reported by the process that served the
  // response, so it needs no inference. The port fallback exists because the
  // daemon you are restarting is very often the STALE build that predates the
  // field — the common case on first use, not an edge case.
  const pid = before.pid ?? probes.portHolderPid(port);
  if (pid === null) return { ok: false, outcome: { kind: "pid-unresolved" } };

  return { ok: true, pid, before };
}

/**
 * Restart the daemon by signalling it and waiting for a supervisor to replace it.
 */
export async function resolveRestart(
  port: number,
  probes: RestartProbes,
  opts: SignalOptions = {}
): Promise<DaemonSignalOutcome> {
  const target = await resolveSignalTarget(port, probes);
  if (!target.ok) return target.outcome;
  const { pid, before } = target;

  const sent = await probes.signal(pid, "SIGTERM");
  if (!sent.ok) return { kind: "signal-failed", pid, reason: sent.reason };

  const budgetMs = opts.budgetMs ?? RESTART_CONFIRM_BUDGET_MS;
  const pollMs = opts.pollIntervalMs ?? RESTART_POLL_INTERVAL_MS;
  const startedAt = probes.now();

  while (probes.now() - startedAt < budgetMs) {
    await probes.sleep(pollMs);
    const after = await probes.serving(port);
    if (after && after.service === COCKPIT_SERVICE_IDENTITY) {
      if (isRestartConfirmed(before, after, pid)) {
        return { kind: "restarted", pid, waitedMs: probes.now() - startedAt };
      }
    }
  }

  // Budget elapsed with no replacement observed. The two states differ in what
  // the operator should do next, so distinguish them rather than reporting one
  // ambiguous timeout.
  if (!probes.isAlive(pid)) return { kind: "stopped", pid };
  return { kind: "still-running", pid };
}

/**
 * Stop the daemon by signalling it, then observe whether a supervisor undoes it.
 *
 * **Why observe rather than refuse under a supervisor.** The spec's concern is
 * that "a stop that is silently undone is worse than a refusal" — and silence,
 * not the respawn, is the part that misleads. Refusing up-front would require
 * knowing a supervisor is present, and nothing here can: `getDaemonStatus`
 * reports `external` for a tray-supervised daemon and a hand-started one alike,
 * so a refusal keyed on it would break the manual case, which is precisely the
 * case where stopping works. Signalling and reporting what actually happened is
 * the only accurate answer, and it is the same discipline the restart path uses.
 */
export async function resolveStop(
  port: number,
  probes: RestartProbes,
  opts: SignalOptions = {}
): Promise<DaemonSignalOutcome> {
  const target = await resolveSignalTarget(port, probes);
  if (!target.ok) return target.outcome;
  const { pid, before } = target;

  const sent = await probes.signal(pid, "SIGTERM");
  if (!sent.ok) return { kind: "signal-failed", pid, reason: sent.reason };

  const budgetMs = opts.budgetMs ?? STOP_OBSERVE_BUDGET_MS;
  const pollMs = opts.pollIntervalMs ?? RESTART_POLL_INTERVAL_MS;
  const startedAt = probes.now();

  while (probes.now() - startedAt < budgetMs) {
    await probes.sleep(pollMs);
    const after = await probes.serving(port);
    // Nothing answering is the state we WANT here, but it is not yet terminal:
    // a supervisor's respawn has a gap where the port is briefly dead, and
    // returning "stopped" on the first such read would report the respawn
    // window as a successful stop. Keep watching until the budget elapses.
    if (!after) continue;
    if (after.service === COCKPIT_SERVICE_IDENTITY && isRestartConfirmed(before, after, pid)) {
      // A supervisor put a new one back. Report it as a restart: that is what
      // observably happened, and naming it "stopped" would be the silent
      // undoing this path exists to prevent.
      return { kind: "restarted", pid, waitedMs: probes.now() - startedAt };
    }
  }

  if (!probes.isAlive(pid)) return { kind: "stopped", pid };
  return { kind: "still-running", pid };
}

/** Production IO. The only place this module touches the network or a signal. */
export const realRestartProbes: RestartProbes = {
  serving: async (port) => {
    try {
      const resp = await fetch(`http://localhost:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) return null;
      const health = (await resp.json()) as Record<string, unknown>;
      const startedAt = health["processStartedAtMs"];
      return {
        pid: readPid(health),
        processStartedAtMs: typeof startedAt === "number" ? startedAt : null,
        service: typeof health["service"] === "string" ? health["service"] : null,
      };
    } catch {
      // Nothing answering on the port, or it answered something unparseable.
      // Both mean "no serving daemon observed", which the caller handles.
      return null;
    }
  },
  portHolderPid: (port) => findPortHolder(port)?.pid ?? null,
  // Routed through the sanctioned identity-before-kill primitive rather than a
  // bare `process.kill` (PR #3097 R1, BLOCKING). `process-identity.ts`'s own
  // docblock names itself "the ONLY sanctioned way this codebase kills a pid" —
  // a pid is a reusable integer, and the health-identity assertion upstream
  // proves the PORT is ours, not that this pid still is by the time we signal.
  signal: async (pid, signal) => {
    const killed = await killIfIdentityMatches(pid, COCKPIT_DAEMON_CMD_SUBSTRING, signal);
    return killed
      ? { ok: true }
      : {
          ok: false,
          reason:
            `the identity check refused it, or the signal failed — pid ${pid} no longer looks like ` +
            `a \`${COCKPIT_DAEMON_CMD_SUBSTRING}\` process (it may have exited, or the pid was reused)`,
        };
  },
  isAlive: isProcessAlive,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Human-readable rendering of an outcome, plus whether it is a failure.
 *
 * Shared by both commands so the wording of a given outcome cannot drift between
 * them, and so the exit code is decided in one place.
 */
export function describeOutcome(
  outcome: DaemonSignalOutcome,
  operation: "restart" | "stop",
  port: number = DEFAULT_DAEMON_PORT
): { message: string; failed: boolean } {
  switch (outcome.kind) {
    case "not-running":
      return {
        message: `Nothing is serving on port ${port}, so there is nothing to ${operation}. Run \`minsky cockpit start\`.`,
        failed: true,
      };
    case "foreign-service":
      return {
        message:
          `Port ${port} is held by ${outcome.service ? `\`${outcome.service}\`` : "an unidentified service"}, not the cockpit daemon. ` +
          `Refusing to signal it.`,
        failed: true,
      };
    case "pid-unresolved":
      return {
        message:
          `The cockpit daemon is serving on port ${port} but would not name its pid, and no process could be ` +
          `resolved from the port. Cannot ${operation} it by signal.`,
        failed: true,
      };
    case "restarted":
      return operation === "restart"
        ? {
            message: `Cockpit daemon restarted (was pid ${outcome.pid}; confirmed after ${Math.round(outcome.waitedMs / 1000)}s by a change in processStartedAtMs).`,
            failed: false,
          }
        : {
            message:
              `Stopped pid ${outcome.pid}, but a supervisor restarted it — the daemon is running again. ` +
              `Signalling cannot stop a supervised daemon; respawning is the supervisor's job. ` +
              `Use the tray menu's Stop item, or \`minsky cockpit uninstall\` under launchd.`,
            failed: true,
          };
    case "stopped":
      return operation === "stop"
        ? { message: `Cockpit daemon stopped (was pid ${outcome.pid}).`, failed: false }
        : {
            message:
              `Stopped pid ${outcome.pid}, but nothing brought it back within the wait budget — no supervisor ` +
              `appears to be present. Run \`minsky cockpit start\`.`,
            failed: true,
          };
    case "still-running":
      return {
        message:
          `Signalled pid ${outcome.pid}, but it is still running and still serving port ${port}. ` +
          `It may be ignoring SIGTERM.`,
        failed: true,
      };
    case "signal-failed":
      return {
        message: `Could not signal pid ${outcome.pid}: ${outcome.reason}`,
        failed: true,
      };
  }
}
