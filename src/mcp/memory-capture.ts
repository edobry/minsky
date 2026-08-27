/**
 * Resident-memory CAPTURE — the forensic half of mt#3886's ceiling (mt#3973).
 *
 * mt#3886 bounds a runaway MCP process: at `MINSKY_MCP_MEMORY_CEILING_MB`
 * (default 2048) the process logs `processRole`/`residentBytes`/`uptimeSeconds`
 * and self-terminates. That record answers WHICH process class ballooned. It
 * says nothing about WHAT the process was allocating, which is precisely what
 * mt#3885 needs and the reason mt#3885 has been unstartable across four
 * handoffs: its success criterion demands evidence no mechanism produced.
 *
 * This module adds a SECOND, INDEPENDENT one-shot watcher at a LOWER
 * watermark. When crossed it writes a capture artifact naming the MCP tool
 * calls in flight and how long each has been running, then gets out of the way.
 *
 * Three properties this design is built around:
 *
 * 1. **The kill path stays unconditional.** This is a separate watcher with its
 *    own timer; it never calls, blocks, or shares state with the ceiling
 *    watcher. Every failure mode here is swallowed into a log line, because a
 *    capture that prevented or delayed the self-terminate would trade a
 *    diagnostic for the machine-wide kernel panic the ceiling exists to stop.
 *
 * 2. **The heap snapshot is OPT-IN, and that is not timidity.** Node documents
 *    the V8 snapshot mechanism as needing "memory about twice the size of the
 *    heap at the time the snapshot is created" and as "a synchronous operation
 *    which blocks the event loop" (https://nodejs.org/api/v8.html). If that
 *    holds for Bun's JSC-backed implementation — unverified, and what mt#3973's
 *    AT3 measures — then a snapshot at watermark W transiently needs ~W + 2W,
 *    so W must sit below a third of the ceiling. The measured idle band for
 *    these processes is 427-644 MB against a 2048 MB ceiling, which leaves no
 *    safe room. So the always-on capture is the cheap half (in-flight context),
 *    and the snapshot is armed deliberately for a measurement run.
 *
 * 3. **The in-flight context is the half most likely to name the path.** The
 *    third giant in the 2026-08-08 stackshot held 15.48 GB against only 33 s of
 *    CPU — an I/O-and-allocation-bound path, not a compute loop. Knowing which
 *    tool was running is a stronger lead than a heap histogram.
 *
 * @see mt#3973 — this module
 * @see mt#3885 — the leak this exists to make findable
 * @see src/mcp/orphan-exit.ts — mt#3886's ceiling, deliberately untouched
 * @see src/mcp/daemon-state.ts — the state-dir convention followed here
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { log } from "@minsky/shared/logger";
import { parsePositiveIntEnv, type StoppableWatcher } from "./orphan-exit";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

export type { StoppableWatcher };

/** Default watermark (MB) at which a capture is taken. */
export const DEFAULT_MEMORY_CAPTURE_WATERMARK_MB = 1024;

/** Default poll interval (ms). Mirrors the ceiling watcher's cadence. */
export const DEFAULT_MEMORY_CAPTURE_POLL_INTERVAL_MS = 30_000;

const BYTES_PER_MB = 1024 * 1024;

/**
 * Transient RSS multiplier while `Bun.generateHeapSnapshot("v8")` runs.
 *
 * MEASURED, not inherited (mt#3973 AT3, `scripts/verify-memory-capture.ts`):
 * a process at 422 MB RSS peaked at 4620 MB taking one snapshot — **10.94x** —
 * and blocked for 5444 ms producing a 529 MB artifact.
 *
 * Node documents V8's equivalent as "memory about twice the size of the heap"
 * (https://nodejs.org/api/v8.html). Bun's JSC-backed implementation is roughly
 * FIVE TIMES worse than that, which is exactly why this task measured instead
 * of assuming: designing to the documented 2x would have put a snapshot at the
 * 1024 MB watermark at ~2 GB (uncomfortable but survivable), when the real
 * figure puts it near 11 GB — enough to cause the kernel panic the ceiling
 * exists to prevent.
 *
 * Rounded down from 10.94 to be honest about precision, not to be optimistic:
 * the guard below multiplies by it, so a lower value is the LESS conservative
 * choice, and 10 is already far above anything a caller would guess.
 */
export const HEAP_SNAPSHOT_RSS_MULTIPLIER = 10;

/**
 * Fraction of total system memory a snapshot's projected peak may reach.
 *
 * The kill ceiling alone is NOT a sufficient bound, because a class with no
 * self-terminate passes `ceilingBytes: Infinity` — and `projected > Infinity`
 * is never true, so a ceiling-only guard silently stops guarding exactly where
 * the process is least protected (PR #2864 R1, caught by the reviewer). The
 * cockpit daemon is that class and idles at 1.31 GB: at the measured ~10x it
 * would snapshot to ~13 GB, which is the memory-exhaustion path that panics the
 * machine — a diagnostic causing the incident it exists to explain.
 *
 * 1/8 of physical memory: 8 GB on this 64 GB workstation, which refuses the
 * cockpit's ~13 GB projection while still permitting a snapshot of a process in
 * the measured 427-644 MB `mcp start` band (~6 GB projected). Derived from
 * `os.totalmem()` rather than hardcoded so it holds on a smaller machine, where
 * the absolute headroom is what actually matters.
 */
export const HEAP_SNAPSHOT_MAX_TOTAL_MEMORY_FRACTION = 1 / 8;

/**
 * The bound a projected snapshot peak must stay under.
 *
 * The STRICTER of the kill ceiling and the system-memory cap, so neither an
 * absent ceiling nor a generously-raised one can leave the snapshot unguarded.
 */
export function resolveSnapshotBudgetBytes(ceilingBytes: number, totalMemoryBytes: number): number {
  return Math.min(ceilingBytes, totalMemoryBytes * HEAP_SNAPSHOT_MAX_TOTAL_MEMORY_FRACTION);
}

/** One MCP tool call in flight at capture time. */
export interface InFlightToolCall {
  toolName: string;
  elapsedMs: number;
}

/** The artifact written when the watermark is crossed. */
export interface MemoryCaptureRecord {
  task: "mt#3973";
  capturedAt: string;
  pid: number;
  processRole: string;
  residentBytes: number;
  watermarkBytes: number;
  uptimeSeconds: number;
  /** Sorted longest-running first — the likeliest culprit reads at the top. */
  inFlightToolCalls: InFlightToolCall[];
  heapSnapshotPath: string | null;
  /** Why no snapshot, when there is none. Absent when one was written. */
  heapSnapshotSkippedReason?: string;
  diagnostics?: Record<string, unknown>;
}

export interface BuildCaptureRecordInput {
  capturedAt: Date;
  pid: number;
  processRole: string;
  residentBytes: number;
  watermarkBytes: number;
  uptimeSeconds: number;
  inFlightToolCalls: InFlightToolCall[];
  heapSnapshotPath: string | null;
  heapSnapshotSkippedReason?: string;
  diagnostics?: Record<string, unknown>;
}

/**
 * Assemble the capture record. Pure — no clock, no filesystem, no `process`.
 *
 * Sorts in-flight calls longest-first: with several calls in flight the one
 * that has been running longest is the one worth reading first, and a reader
 * looking at a 40 GB process should not have to sort by hand.
 */
export function buildCaptureRecord(input: BuildCaptureRecordInput): MemoryCaptureRecord {
  const record: MemoryCaptureRecord = {
    task: "mt#3973",
    capturedAt: input.capturedAt.toISOString(),
    pid: input.pid,
    processRole: input.processRole,
    residentBytes: input.residentBytes,
    watermarkBytes: input.watermarkBytes,
    uptimeSeconds: input.uptimeSeconds,
    inFlightToolCalls: [...input.inFlightToolCalls].sort((a, b) => b.elapsedMs - a.elapsedMs),
    heapSnapshotPath: input.heapSnapshotPath,
  };
  if (input.heapSnapshotSkippedReason !== undefined) {
    record.heapSnapshotSkippedReason = input.heapSnapshotSkippedReason;
  }
  if (input.diagnostics !== undefined) {
    record.diagnostics = input.diagnostics;
  }
  return record;
}

/**
 * Filename stem for a capture, unique per (process, capture instant).
 *
 * The role is slugified into the name so an operator can tell at a glance which
 * process class produced the artifact without opening it — that is the one
 * question the panic stackshot could not answer (it carries no argv), and the
 * reason mt#3885's attribution premise is still open.
 */
export function buildCaptureFileStem(capturedAt: Date, pid: number, processRole: string): string {
  const timestamp = capturedAt.toISOString().replace(/[:.]/g, "-");
  const role = processRole.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return `memory-capture-${timestamp}-${role}-pid${pid}`;
}

/** Directory captures are written to. Honors the shared MINSKY_STATE_DIR override. */
export function getCaptureDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env["MINSKY_STATE_DIR"] ?? path.join(os.homedir(), ".local", "state", "minsky");
  return path.join(stateDir, "memory-captures");
}

export interface CaptureArmDecision {
  watermarkBytes: number;
  ceilingBytes: number;
  forceDisable: boolean;
}

export type CaptureArmVerdict =
  | { armed: true }
  | { armed: false; reason: "disabled" | "watermark-not-below-ceiling" };

/**
 * Whether the capture watcher should arm.
 *
 * A watermark at or above the ceiling can never fire before the process
 * self-terminates, so arming it would burn a timer for the life of every MCP
 * process to produce nothing. Refusing loudly beats a silent no-op: the
 * misconfiguration is invisible until the day someone needs the capture.
 */
export function decideCaptureArm(decision: CaptureArmDecision): CaptureArmVerdict {
  if (decision.forceDisable) return { armed: false, reason: "disabled" };
  if (decision.watermarkBytes >= decision.ceilingBytes) {
    return { armed: false, reason: "watermark-not-below-ceiling" };
  }
  return { armed: true };
}

export interface ResidentMemoryCaptureWatcherOptions {
  watermarkBytes: number;
  getResidentBytes: () => number | null;
  pollIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  onWatermarkCrossed: (residentBytes: number) => void;
}

/**
 * Poll resident memory; fire once, the first time it is at or above the
 * watermark. One-shot mirrors `startResidentMemoryCeilingWatcher` — a process
 * that crosses the watermark and keeps growing would otherwise write an
 * artifact every poll, and the first one is the one that matters (it is nearest
 * the growth, and the later ones cost the most to take).
 */
export function startResidentMemoryCaptureWatcher(
  options: ResidentMemoryCaptureWatcherOptions
): StoppableWatcher {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_MEMORY_CAPTURE_POLL_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  let stopped = false;
  const timer = setIntervalFn(() => {
    if (stopped) return;
    const residentBytes = options.getResidentBytes();
    // Skip, do not substitute (mt#4104) — same rule as the ceiling watcher: an
    // unmeasurable tick is not a low reading.
    if (residentBytes === null) return;
    if (residentBytes >= options.watermarkBytes) {
      stopped = true;
      clearIntervalFn(timer);
      options.onWatermarkCrossed(residentBytes);
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

type HeapSnapshotGenerator = (format: "v8", encoding: "arraybuffer") => ArrayBuffer;

/**
 * Bun's V8-format heap snapshot, or null when unavailable.
 *
 * `"v8"` (not the default `"jsc"`) because the JSC form is annotated in Bun's
 * own API reference as something it does not know how to make Chrome or Safari
 * read — an artifact nobody can open is not evidence. `"arraybuffer"` is Bun's
 * documented encoding for large snapshots, avoiding the intermediate JS string.
 *
 * @see https://bun.com/reference/bun/generateHeapSnapshot
 */
function generateHeapSnapshotBytes(): ArrayBuffer | null {
  const bunGlobal: unknown = Reflect.get(globalThis, "Bun");
  if (!bunGlobal || typeof bunGlobal !== "object") return null;
  const generate: unknown = Reflect.get(bunGlobal, "generateHeapSnapshot");
  if (typeof generate !== "function") return null;
  return (generate as HeapSnapshotGenerator)("v8", "arraybuffer");
}

export interface WriteCaptureOptions {
  captureDir: string;
  record: MemoryCaptureRecord;
  fileStem: string;
  heapSnapshotBytes?: ArrayBuffer | null;
}

/** Write the capture artifact (and its snapshot, when present). Returns the JSON path. */
export function writeCaptureArtifact(options: WriteCaptureOptions): string {
  fs.mkdirSync(options.captureDir, { recursive: true });
  if (options.heapSnapshotBytes) {
    fs.writeFileSync(
      path.join(options.captureDir, `${options.fileStem}.heapsnapshot`),
      new Uint8Array(options.heapSnapshotBytes)
    );
  }
  const jsonPath = path.join(options.captureDir, `${options.fileStem}.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(options.record, null, 2)}\n`);
  return jsonPath;
}

export interface WireMemoryCaptureWatcherOptions {
  /** Names the process class in the artifact — "mcp start (stdio)", "mcp shim", "cockpit". */
  processRole: string;
  /**
   * The kill ceiling in bytes; the watermark must sit below it to be useful.
   * `Number.POSITIVE_INFINITY` for a class with no self-terminate (the cockpit
   * daemon), which is honest about the absence rather than inventing a bound.
   */
  ceilingBytes: number;
  /**
   * Watermark default for THIS process class, when the env var is unset.
   *
   * Exists because the classes have genuinely different baselines: `mcp start`
   * idles at 427-644 MB, while the cockpit daemon was measured at 1.31 GB on
   * the same machine and the same day. One global default would either fire on
   * every cockpit start or sit uselessly far above the MCP band.
   */
  defaultWatermarkMb?: number;
  getResidentBytes: () => number | null;
  getUptimeSeconds: () => number;
  /** In-flight MCP tool calls at capture time. Absent for classes that serve no tools. */
  getInFlightToolCalls?: () => InFlightToolCall[];
  getDiagnostics?: () => Record<string, unknown>;
  /** Injected in tests so the snapshot budget can be asserted on a known machine size. */
  getTotalMemoryBytes?: () => number;
  env?: NodeJS.ProcessEnv;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Injected in tests so the artifact write can be asserted without touching disk. */
  writeArtifact?: (options: WriteCaptureOptions) => string;
  now?: () => Date;
}

/**
 * Arm the capture watcher per the current env configuration.
 *
 * Every failure past this point is swallowed into a log line ON PURPOSE — see
 * property 1 in the module header. The caller's kill path must not be able to
 * observe a capture failure.
 */
export function wireMemoryCaptureWatcher(
  options: WireMemoryCaptureWatcherOptions
): StoppableWatcher {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const writeArtifact = options.writeArtifact ?? writeCaptureArtifact;

  const watermarkMb =
    parsePositiveIntEnv(env["MINSKY_MCP_MEMORY_CAPTURE_MB"]) ??
    options.defaultWatermarkMb ??
    DEFAULT_MEMORY_CAPTURE_WATERMARK_MB;
  const watermarkBytes = watermarkMb * BYTES_PER_MB;

  const verdict = decideCaptureArm({
    watermarkBytes,
    ceilingBytes: options.ceilingBytes,
    forceDisable: env["MINSKY_MCP_DISABLE_MEMORY_CAPTURE"] === "1",
  });

  if (!verdict.armed) {
    if (verdict.reason === "watermark-not-below-ceiling") {
      log.error(
        "[mt#3973] Resident-memory capture NOT armed: watermark is not below the kill ceiling, so it could never fire",
        {
          processRole: options.processRole,
          watermarkMb,
          ceilingMb: Math.round(options.ceilingBytes / BYTES_PER_MB),
        }
      );
    } else {
      log.debug("[mt#3973] Resident-memory capture disabled by MINSKY_MCP_DISABLE_MEMORY_CAPTURE", {
        processRole: options.processRole,
      });
    }
    return { stop: () => {} };
  }

  const snapshotRequested = env["MINSKY_MCP_CAPTURE_HEAP_SNAPSHOT"] === "1";

  return startResidentMemoryCaptureWatcher({
    watermarkBytes,
    getResidentBytes: options.getResidentBytes,
    pollIntervalMs: parsePositiveIntEnv(env["MINSKY_MCP_MEMORY_CAPTURE_POLL_MS"]),
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
    onWatermarkCrossed: (residentBytes) => {
      try {
        let heapSnapshotBytes: ArrayBuffer | null = null;
        let heapSnapshotSkippedReason: string | undefined;

        const projectedPeakBytes = residentBytes * HEAP_SNAPSHOT_RSS_MULTIPLIER;
        const snapshotBudgetBytes = resolveSnapshotBudgetBytes(
          options.ceilingBytes,
          (options.getTotalMemoryBytes ?? os.totalmem)()
        );

        if (!snapshotRequested) {
          heapSnapshotSkippedReason =
            "not requested (set MINSKY_MCP_CAPTURE_HEAP_SNAPSHOT=1; see mt#3973 on why this is opt-in)";
        } else if (projectedPeakBytes > snapshotBudgetBytes) {
          // Refuse even when explicitly requested. Taking the snapshot here
          // would push the process past the very ceiling that exists to stop it
          // panicking the machine — the diagnostic would CAUSE the incident it
          // is meant to explain. The operator opted into a snapshot, not into
          // an outage, and this is the one case where honoring the flag is
          // worse than reporting why it could not be honored.
          heapSnapshotSkippedReason =
            `refused: a snapshot at ${Math.round(residentBytes / BYTES_PER_MB)}MB would transiently ` +
            `reach ~${Math.round(projectedPeakBytes / BYTES_PER_MB)}MB (measured ${HEAP_SNAPSHOT_RSS_MULTIPLIER}x, mt#3973 AT3), ` +
            `above the ${Math.round(snapshotBudgetBytes / BYTES_PER_MB)}MB budget ` +
            `(the stricter of the kill ceiling and 1/8 of system memory). ` +
            `Lower MINSKY_MCP_MEMORY_CAPTURE_MB or raise MINSKY_MCP_MEMORY_CEILING_MB.`;
        } else {
          heapSnapshotBytes = generateHeapSnapshotBytes();
          if (!heapSnapshotBytes) {
            heapSnapshotSkippedReason = "Bun.generateHeapSnapshot unavailable in this runtime";
          }
        }

        const capturedAt = now();
        const fileStem = buildCaptureFileStem(capturedAt, process.pid, options.processRole);
        const captureDir = getCaptureDir(env);

        const record = buildCaptureRecord({
          capturedAt,
          pid: process.pid,
          processRole: options.processRole,
          residentBytes,
          watermarkBytes,
          uptimeSeconds: options.getUptimeSeconds(),
          inFlightToolCalls: options.getInFlightToolCalls?.() ?? [],
          heapSnapshotPath: heapSnapshotBytes
            ? path.join(captureDir, `${fileStem}.heapsnapshot`)
            : null,
          ...(heapSnapshotSkippedReason !== undefined ? { heapSnapshotSkippedReason } : {}),
          ...(options.getDiagnostics ? { diagnostics: options.getDiagnostics() } : {}),
        });

        const jsonPath = writeArtifact({ captureDir, record, fileStem, heapSnapshotBytes });

        log.cli(
          `[mt#3973] Resident memory ${Math.round(residentBytes / BYTES_PER_MB)}MB crossed the ` +
            `${watermarkMb}MB capture watermark; wrote ${jsonPath}`
        );
      } catch (error) {
        // Deliberate swallow: the ceiling's self-terminate is the machine's
        // protection against a kernel panic, and it must not be affected by a
        // diagnostic that failed. Logged, never rethrown.
        log.error("[mt#3973] Resident-memory capture failed; the kill ceiling is unaffected", {
          processRole: options.processRole,
          error: getLoggableErrorSummary(error),
        });
      }
    },
  });
}
