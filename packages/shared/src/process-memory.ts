/**
 * Swap-inclusive process memory measurement (mt#4104).
 *
 * ## Why this exists
 *
 * Every memory guardrail in this repo read `process.memoryUsage.rss()`, which
 * **falls** as the OS swaps a process out. On 2026-08-13 an MCP server measured
 * ~900 MB RSS against a 48.2 GB `phys_footprint` — comfortably under mt#3886's
 * 2048 MB ceiling while holding 48 GB. The harder a process leans on memory, the
 * more RSS under-reports it, which is the exact inversion you do not want in a
 * guardrail.
 *
 * RSS is not merely "lower"; it differs in BOTH directions, because the two
 * quantities count different things:
 *
 * - RSS counts resident pages INCLUDING clean file-backed ones (the mapped
 *   binary, shared libraries) that the kernel does not charge to the task.
 * - `phys_footprint` counts what the kernel CHARGES the task — dirty anonymous
 *   memory, whether resident, compressed, or swapped.
 *
 * Measured on one live `bun` process while writing this: RSS 1.14 GB against a
 * 335 MB footprint. And on the 2026-08-13 specimen: RSS ~900 MB against a
 * 48.2 GB footprint. Neither is a scaled version of the other, so a threshold
 * expressed in one unit does not carry over to the other — see mt#4104 SC4.
 *
 * ## Platform quantities
 *
 * **macOS: `phys_footprint`.** `task_vm_info.phys_footprint`
 * (`$(xcrun --show-sdk-path)/usr/include/mach/task_info.h:369`, via
 * `TASK_VM_INFO`), which is what `footprint(1)` and `vmmap` report and what
 * jetsam acts on.
 *
 * **Linux: `VmRSS + VmSwap`** from `/proc/<pid>/status`, per `proc_pid_status(5)`:
 * VmSwap is "Swapped-out virtual memory size by anonymous private pages; shmem
 * swap usage is not included". Note the kernel's own docs label both values
 * "inaccurate" — they are a racy snapshot, where the macOS figure is a ledger.
 * The two are NOT semantically identical; each platform's own documented
 * accounting quantity is used rather than inventing a portable derived metric.
 *
 * ## Why a subprocess rather than a native call
 *
 * `bun:ffi` calling `task_info(TASK_VM_INFO)` reads the current task cheaply but
 * **cannot read another process's** without `task_for_pid`, which requires root
 * or the debugger entitlement on modern macOS. Reading ANOTHER pid is a hard
 * requirement here (mt#4105's supervisor has to measure the daemon it
 * supervises), so `task_info` fails the actual requirement.
 *
 * **That objection is specific to `task_info`, and does NOT reach FFI as a class
 * (mt#4211).** `proc_pid_rusage(pid, flavor, buf)` takes a pid DIRECTLY and needs
 * no port lookup, so the entitlement problem never arises for it; its
 * `ri_phys_footprint` field is the same quantity `footprint(1)` reports. Declared
 * at `libproc.h:111` (macOS 10.9+), field at `sys/resource.h:211`. Probed
 * 2026-08-17 unprivileged against another owned `bun` process: the cross-pid read
 * succeeded, the value was byte-identical to `footprint -f bytes -p <pid>` for the
 * same pid at the same moment, at **1.02 µs/call** over 10,000 iterations.
 *
 * **Recorded as a verified escape hatch, deliberately NOT implemented.** After the
 * ADR-038 flip (mt#1713) there are ~2 concurrent pollers rather than ~50, so a 1 µs
 * reader buys nothing operational while introducing this repo's first `bun:ffi`
 * usage and native-ABI coupling. Reach for it only if some future surface genuinely
 * needs high-frequency or high-N reads.
 *
 * `footprint(1)` needs root only for processes owned by ANOTHER user, which a
 * supervisor and its own children never are. Measured cost: **88ms** — against
 * 451ms for `top -l 1 -pid N -stats mem`, which yields the same number. On Linux
 * the read is a plain file and cheaper still.
 *
 * **That 88ms is a per-call figure at N=1 and does NOT bound aggregate cost.**
 * Every call serializes on `sysmond`, so cost is superlinear in the number of
 * CONCURRENT callers — and this reader is armed per-connection, multiplying by an
 * N the author does not control. On 2026-08-17, ~50 MCP processes polling on one
 * aligned 30s cadence pinned a 16-core machine at load 176: the same call measured
 * 0.08s quiet and 21.20s under that load (~265x), with 48-51 `footprint` processes
 * resident whose individual lifetimes were 51-83s against a 30s interval. Killing
 * the MCP processes dropped load to 8.7; the ceiling had never fired on a real
 * breach. So read the 88ms as cheap at the concurrency it was MEASURED at — N=1 —
 * and never as a bound at the concurrency this reader is armed at. Establish that
 * concurrency before relying on the figure.
 *
 * **This parsing exists twice.** `cockpit-tray/src-tauri/src/supervisor/daemon_core.rs`
 * carries an independent Rust implementation — `parse_footprint_bytes` (L864) plus
 * `daemon_memory_bytes` (L936), which spawns `/usr/bin/footprint` itself — and THAT
 * copy is the one on the post-flip cross-pid enforcement path, not this module.
 * Establish which is load-bearing before "unifying" them. (mt#4211's spec placed
 * `daemon_memory_bytes` in `supervisor.rs`; both are in `daemon_core.rs`.)
 */

import { readFileSync } from "fs";

/** Where a reading came from — recorded so a caller can tell the platforms apart. */
export type ProcessMemorySource = "phys_footprint" | "vmrss+vmswap";

/**
 * A measurement, or an explicit statement that measurement was not possible.
 *
 * A discriminated union rather than a bare number, because the failure case MUST
 * NOT be representable as one: a `0` or a fallback RSS reading is a number that
 * silently means something else, and every guardrail downstream would compare it
 * to a ceiling and conclude everything is fine (mt#4104 SC2).
 */
export type ProcessMemoryResult =
  | { ok: true; bytes: number; source: ProcessMemorySource }
  | { ok: false; reason: string };

/** Injection seam so both platform paths are testable from either platform. */
export interface ProcessMemoryDeps {
  /** Defaults to `process.platform`. */
  platform?: string;
  /** Runs `footprint -f bytes -p <pid>`; returns stdout, or null if unavailable. */
  runFootprint?: (pid: number) => string | null;
  /** Reads `/proc/<pid>/status`; returns contents, or null if unavailable. */
  readProcStatus?: (pid: number) => string | null;
}

/** `phys_footprint: 15517760 B` — the `-f bytes` form, so no unit parsing. */
const PHYS_FOOTPRINT_BYTES = /^\s*phys_footprint:\s*(\d+)\s*B\s*$/im;

/** `VmRSS:  123456 kB` / `VmSwap:  789 kB` — proc(5) reports these in kB. */
const BYTES_PER_KB = 1024;

/**
 * Known causes of a `null` here, i.e. of a persistent `ok: false` upstream —
 * worth enumerating because the operator-facing symptom is an admission
 * decision marked `measured: false`, which says nothing about why:
 *
 * - The pid is gone (`footprint(1)` exits 66).
 * - The process is owned by ANOTHER user — `man 1 footprint`: "must be run as
 *   root when inspecting processes that are not owned by the current user." A
 *   supervisor's own children never are, but a mis-targeted pid could be.
 * - `footprint(1)` is absent, or blocked by a sandbox/TCC policy on a hardened
 *   machine. The spawn throws rather than exiting non-zero.
 *
 * PR #2968 R1 suggested threading the exit status into the failure `reason`.
 * Deliberately not done: no consumer reads `reason` today — every caller goes
 * through `getCurrentProcessMemoryBytes`, which collapses the union to
 * `number | null` — so it would add detail to a field nothing surfaces. If a
 * consumer ever displays the reason, thread it then, and change the injection
 * seam's return shape once rather than speculatively.
 */
function defaultRunFootprint(pid: number): string | null {
  try {
    const probe = Bun.spawnSync(["footprint", "-f", "bytes", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // Exit 66 is what footprint(1) returns for a pid that does not exist; any
    // non-success means we have no reading, not a reading of zero.
    if (!probe.success) return null;
    return probe.stdout.toString();
  } catch {
    return null;
  }
}

function defaultReadProcStatus(pid: number): string | null {
  try {
    // Synchronous by design: every caller is a poll tick that must not interleave
    // with its own next tick, and the file is a few hundred bytes.
    return String(readFileSync(`/proc/${pid}/status`, { encoding: "utf-8" }));
  } catch {
    return null;
  }
}

/** Sum a named kB-valued field out of /proc/<pid>/status. Returns null if absent. */
function readKbField(status: string, field: string): number | null {
  const match = status.match(new RegExp(`^${field}:\\s*(\\d+)\\s*kB\\s*$`, "im"));
  if (!match) return null;
  const kb = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(kb) ? kb * BYTES_PER_KB : null;
}

/**
 * Read `pid`'s swap-inclusive memory.
 *
 * Works for the calling process and for any other process the caller owns —
 * both are required (mt#4104 SC1/SC2), and the in-process-only shape is exactly
 * what would pass every in-process test while failing the supervisor.
 */
export function readProcessMemory(pid: number, deps: ProcessMemoryDeps = {}): ProcessMemoryResult {
  const platform = deps.platform ?? process.platform;

  if (platform === "darwin") {
    const output = (deps.runFootprint ?? defaultRunFootprint)(pid);
    if (output === null) {
      return { ok: false, reason: `footprint(1) produced no reading for pid ${pid}` };
    }
    const match = output.match(PHYS_FOOTPRINT_BYTES);
    if (!match) {
      return { ok: false, reason: `footprint(1) output carried no phys_footprint line` };
    }
    const bytes = Number.parseInt(match[1] as string, 10);
    if (!Number.isFinite(bytes)) {
      return { ok: false, reason: `phys_footprint did not parse as a number` };
    }
    return { ok: true, bytes, source: "phys_footprint" };
  }

  if (platform === "linux") {
    const status = (deps.readProcStatus ?? defaultReadProcStatus)(pid);
    if (status === null) {
      return { ok: false, reason: `/proc/${pid}/status could not be read` };
    }
    const rss = readKbField(status, "VmRSS");
    if (rss === null) {
      return { ok: false, reason: `/proc/${pid}/status carried no VmRSS field` };
    }
    // VmSwap has been present since Linux 2.6.34; treat its absence as zero swap
    // rather than as a failed measurement, since VmRSS alone is still a real
    // reading of resident memory — just one that cannot see swapped pages.
    const swap = readKbField(status, "VmSwap") ?? 0;
    return { ok: true, bytes: rss + swap, source: "vmrss+vmswap" };
  }

  return {
    ok: false,
    reason: `no swap-inclusive memory quantity is implemented for platform ${platform}`,
  };
}
