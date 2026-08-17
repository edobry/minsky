/**
 * Out-of-process memory bound for the proxy's inner MCP server (mt#4112).
 *
 * ## Why this exists at all, given mt#3886 already ships a ceiling
 *
 * mt#3886's ceiling is a `setInterval` inside the process it polices, as are
 * mt#3764's parent-death and never-connected watchers and the
 * `SIGTERM`/`SIGINT`/`SIGHUP` handlers in `start-command.ts`. On 2026-08-13 two
 * `mcp start` processes reached 48.2 GB and 32 GB with all of that armed and
 * none of it running: a 3s `sample` put all 2483 main-thread samples in one
 * unbroken JS stack with zero `kevent`/`kqueue` samples process-wide. The event
 * loop never turned, so nothing on the timer queue could fire — and the same
 * wedge is why those processes required SIGKILL.
 *
 * **A process that has wedged its own event loop cannot be the thing that
 * notices it has wedged.** The bound has to come from a different process.
 *
 * ## Why the proxy is that process
 *
 * mt#4105 assigns the same job to the tray supervisor's daemon registry, which
 * is right for the topology ADR-038 is building toward. A `ps` census on
 * 2026-08-13 found that topology carrying **zero** live processes — no
 * `mcp start --local-daemon`, no discovery file — while **11 of 13** live
 * `mcp start` processes were children of a `minsky mcp proxy`. The proxy
 * already owns its child's lifecycle (`killChild` is SIGTERM then SIGKILL after
 * a grace period), its own event loop is untouched by the child's, and a breach
 * can be answered with a RESTART rather than a kill — which is the whole reason
 * the proxy exists (mt#1322 / mt#2011: the client never observes a disconnect).
 *
 * ## Population boundary — what this does NOT cover
 *
 * Stated rather than left to be discovered, per mt#4105's scope note:
 *
 * - **Tray-supervised local daemons** (`mcp start --local-daemon`) — mt#4105.
 * - **Ad-hoc test-spawned servers** — mt#4098 reaps the descendant tree when a
 *   test runner's watchdog fires; that is an orphan reaper, not a memory bound.
 * - **`mcp start` spawned directly by a harness with no Minsky parent** (e.g.
 *   Claude Desktop, whose parent is its own helper binary) — nothing supervises
 *   these, so no Minsky change can bound them from outside. They retain the
 *   in-process ceiling only: correct measurement after mt#4104, still unable to
 *   fire when wedged. Unowned as of mt#4112.
 *
 * @see src/mcp/orphan-exit.ts — the in-process ceiling this backstops
 * @see packages/shared/src/process-memory.ts — the cross-pid reader (mt#4104)
 */

import { log } from "@minsky/shared/logger";
import { readProcessMemory } from "@minsky/shared/process-memory";
import {
  parsePositiveIntEnv,
  resolveMemoryCeilingBytes,
  startResidentMemoryCeilingWatcher,
  type MemoryCeilingBreach,
  type StoppableWatcher,
} from "../orphan-exit";
import {
  buildCaptureFileStem,
  buildCaptureRecord,
  getCaptureDir,
  writeCaptureArtifact,
  type WriteCaptureOptions,
} from "../memory-capture";

/**
 * Process role recorded on the breach artifact.
 *
 * Distinct from the inner server's own `"mcp start (stdio)"` and the proxy's
 * `"mcp proxy"`: an operator reading `~/.local/state/minsky/memory-captures/`
 * needs to tell a self-terminated breach from one the parent had to enforce,
 * because only the second means the process was wedged — which is the single
 * fact mt#3885 most needs and the panic stackshots could never supply.
 */
export const PROXY_CHILD_PROCESS_ROLE = "mcp start (killed by proxy)";

/** Reads a pid's swap-inclusive memory. Injected so tests need no live process. */
export type ProcessMemoryReader = (pid: number) => ReturnType<typeof readProcessMemory>;

export interface ChildMemoryReaderOptions {
  /** The pid to measure right now, or undefined when no child is running. */
  getChildPid: () => number | undefined;
  readMemory?: ProcessMemoryReader;
}

/**
 * Build the `() => number | null` reader the ceiling watcher consumes.
 *
 * Resolves the pid on EVERY tick rather than closing over one, so a respawn is
 * covered without re-arming anything — the watcher outlives any individual
 * child, which is the point of putting it in the parent.
 *
 * `null` means "no reading", never "zero": between children, and on a failed
 * measurement, the watcher must skip the tick. Substituting a number here is
 * the exact failure mt#4104 was filed for — a reading that looks fine while the
 * process holds tens of GB.
 */
export function createChildMemoryReader(options: ChildMemoryReaderOptions): () => number | null {
  const readMemory = options.readMemory ?? readProcessMemory;
  return () => {
    const pid = options.getChildPid();
    if (pid === undefined) return null;
    const result = readMemory(pid);
    return result.ok ? result.bytes : null;
  };
}

export interface ArmChildMemoryCeilingOptions extends ChildMemoryReaderOptions {
  /** Invoked when the child crosses the ceiling. Owns its own re-entrancy guard. */
  onBreach: (breach: MemoryCeilingBreach) => void;
  env?: NodeJS.ProcessEnv;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * Arm the out-of-process ceiling over the proxy's current child.
 *
 * Reuses `MINSKY_MCP_MEMORY_CEILING_MB` / `_POLL_MS` / `_DISABLE_MEMORY_CEILING_EXIT`
 * rather than minting a parallel set: the ceiling is a property of the process
 * CLASS being bounded, not of who is doing the bounding, and two knobs that can
 * disagree about the same number is how a watermark ends up silently above a
 * ceiling. The disable flag is honored for the same reason — an operator who
 * turned the ceiling off means "do not kill this on memory", and it would be a
 * surprise for the parent to keep doing it.
 *
 * There is deliberately no hosted-entrypoint skip here (unlike
 * `shouldArmMemoryCeilingWatcher`): that skip exists because arming a self-kill
 * path in a shared production service is an operator decision, and the stdio
 * proxy is a local, per-conversation process that is never the hosted service.
 */
export function armChildMemoryCeiling(options: ArmChildMemoryCeilingOptions): StoppableWatcher {
  const env = options.env ?? process.env;

  if (env.MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT === "1") {
    log.debug("[mt#4112] Child memory ceiling disabled by MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT");
    return { stop: () => {} };
  }

  const ceilingBytes = resolveMemoryCeilingBytes(env);

  return startResidentMemoryCeilingWatcher({
    ceilingBytes,
    getResidentBytes: createChildMemoryReader(options),
    pollIntervalMs: parsePositiveIntEnv(env.MINSKY_MCP_MEMORY_CEILING_POLL_MS),
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    // The proxy survives the breach and keeps supervising, so a one-shot
    // watcher would leave every child after the first one unguarded.
    repeatAfterBreach: true,
    onCeilingExceeded: options.onBreach,
  });
}

export interface WriteChildBreachRecordOptions {
  pid: number;
  residentBytes: number;
  ceilingBytes: number;
  /** Seconds the CHILD has been running — not the proxy's uptime. */
  uptimeSeconds: number;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  writeArtifact?: (options: WriteCaptureOptions) => string;
}

/**
 * Write the forensic record for a child the proxy is about to kill.
 *
 * Reuses mt#3973's artifact shape and directory so the operator-facing surfaces
 * built on it — `docs/mcp-memory-forensics.md` and the mt#3997 capture notice —
 * pick this up with no change. What it cannot carry is the heap snapshot:
 * `Bun.generateHeapSnapshot` runs only INSIDE the target, and the target here is
 * by hypothesis not running anything. `heapSnapshotSkippedReason` says so
 * explicitly rather than leaving a null a reader has to interpret.
 *
 * Every failure is swallowed into a log line on purpose, matching
 * `wireMemoryCaptureWatcher`'s property: the kill must not be observable to a
 * capture failure. Returns the artifact path, or null when nothing was written.
 */
export function writeChildBreachRecord(options: WriteChildBreachRecordOptions): string | null {
  const now = (options.now ?? (() => new Date()))();
  const writeArtifact = options.writeArtifact ?? writeCaptureArtifact;

  try {
    const record = buildCaptureRecord({
      capturedAt: now,
      pid: options.pid,
      processRole: PROXY_CHILD_PROCESS_ROLE,
      residentBytes: options.residentBytes,
      // The artifact field is named for mt#3973's watermark; for a breach the
      // threshold that was actually crossed IS the ceiling, so recording the
      // ceiling keeps "what was this number compared against" answerable.
      watermarkBytes: options.ceilingBytes,
      uptimeSeconds: options.uptimeSeconds,
      // The proxy pipes raw bytes and does not track the inner server's
      // in-flight calls; claiming an empty list is different from claiming
      // none were running, which is why the diagnostics note says so.
      inFlightToolCalls: [],
      heapSnapshotPath: null,
      heapSnapshotSkippedReason:
        "observed out-of-process by the stdio proxy; a heap snapshot requires " +
        "running code inside the target, which a wedged event loop cannot do",
      diagnostics: {
        observedBy: "mcp proxy",
        enforcedBy: "mt#4112 out-of-process ceiling",
        inFlightToolCallsUnknown: true,
      },
    });

    const jsonPath = writeArtifact({
      captureDir: getCaptureDir(options.env ?? process.env),
      record,
      fileStem: buildCaptureFileStem(now, options.pid, PROXY_CHILD_PROCESS_ROLE),
    });
    log.debug("[mt#4112] Wrote child memory-breach record", { path: jsonPath, pid: options.pid });
    return jsonPath;
  } catch (err) {
    log.debug("[mt#4112] Failed to write child memory-breach record (non-blocking)", {
      error: (err as Error).message,
    });
    return null;
  }
}
