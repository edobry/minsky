# MCP resident-memory: ceiling, capture, and how to read what they leave behind

Two mechanisms guard against — and now explain — a Minsky process growing until it exhausts host
memory. They are deliberately independent.

|          | **Ceiling** (mt#3886)                            | **Capture** (mt#3973)                                |
| -------- | ------------------------------------------------ | ---------------------------------------------------- |
| Fires at | `MINSKY_MCP_MEMORY_CEILING_MB`, default **2048** | `MINSKY_MCP_MEMORY_CAPTURE_MB`, default **1024**     |
| Does     | logs the breach, then `process.exit`             | writes an artifact to disk, then gets out of the way |
| Answers  | _which process class_ ballooned                  | _what it was doing_                                  |
| Covers   | `mcp start` (all transports), `mcp proxy`        | `mcp start`, `mcp proxy`, `cockpit start` (2048)     |

The capture watermark must sit **below** the ceiling or it could never fire; a misconfiguration
that puts it at or above the ceiling refuses to arm and logs an error rather than burning a timer
to produce nothing.

## What these numbers MEASURE changed on 2026-08-13 (mt#4104)

Both thresholds are still expressed in MB and both defaults are unchanged — but **the quantity
they are compared against is different**, so a number you set before that date does not mean what
it used to.

|                         | Before (mt#3886/mt#3973)                                         | Now (mt#4104)                                  |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| Reads                   | `process.memoryUsage.rss()`                                      | macOS `phys_footprint`; Linux `VmRSS + VmSwap` |
| Sees swap?              | **No** — RSS FALLS as a process is swapped out                   | Yes                                            |
| Sees shared file pages? | Yes — counts mapped binaries the kernel does not charge the task | No                                             |

**Why it changed.** RSS moves the wrong way under exactly the condition these guards exist for. On
2026-08-13 an orphaned `mcp start --http` process measured ~900 MB RSS while holding **48.2 GB** of
`phys_footprint`, and sailed under a 2048 MB ceiling that was armed the whole time. This is not
only a pathological-case problem: sampling 11 live MCP processes the same day, two read 44–56 MB
RSS against 215–384 MB footprints.

**What this means if you have tuned these.** A value you chose against RSS is not equivalent. The
re-measured idle band is **210–413 MB** in the new units (macOS, 11 MCP processes + cockpit),
against the 427–644 MB RSS band mt#3973 recorded. Both defaults were re-derived against the new
band and deliberately kept — 2048 now sits ~5x above the band top instead of ~4.5x, so the change
gains headroom rather than losing it.

**Linux is unmeasured.** The band above is macOS only. The hosted Railway surface is Linux; mt#3888
owns whether to arm the ceiling there and at what number, and the macOS band is not evidence about
it.

**A reading can now fail.** Where RSS always returned a number, `footprint(1)` or `/proc` can be
unavailable. That case is reported, never substituted: the ceiling and capture watchers SKIP the
tick and keep polling, and the shared-daemon admission gate fails OPEN while marking the decision
`measured: false`. If you see admissions with `measured: false`, memory is not being read — the
gate is not telling you the daemon is healthy, it is telling you it cannot see.

## Why they are separate

The self-terminate is the machine's protection against a whole-machine kernel panic (five in four
days, 2026-08-05 → 08-08; see mt#3885 and mem#913). It must not be able to fail, or be delayed,
because a diagnostic did. So the capture runs on its own timer and every failure inside it is
swallowed into a log line — asserted by a test, not merely intended.

## Where captures land

```
${MINSKY_STATE_DIR:-~/.local/state/minsky}/memory-captures/
    memory-capture-<ISO8601>-<role>-pid<PID>.json
    memory-capture-<ISO8601>-<role>-pid<PID>.heapsnapshot   # only when explicitly enabled
```

The role is slugified into the filename (`mcp-start-stdio`, `cockpit-start`) so the process class
is readable without opening the file — the one question the 2026-08-08 panic stackshot could not
answer, because macOS panic records carry `procname` but no argv.

## Matching a capture to a breach log line

The ceiling logs `[mt#3886] Resident memory <N>MB reached the <M>MB ceiling; self-terminating
<role>`; the capture logs `[mt#3973] Resident memory <N>MB crossed the <W>MB capture watermark;
wrote <path>`. Match on **pid + role**, both of which appear in the capture filename and in the
capture record's `pid` / `processRole` fields. Within one process there is at most one capture:
both watchers are one-shot.

## Reading the artifact

```jsonc
{
  "task": "mt#3973",
  "capturedAt": "2026-08-11T20:03:39.983Z",
  "pid": 48013,
  "processRole": "mcp start (stdio)",
  "residentBytes": 216743936,
  "watermarkBytes": 67108864,
  "uptimeSeconds": 1.47,
  "inFlightToolCalls": [], // sorted longest-running FIRST
  "heapSnapshotPath": null,
  "heapSnapshotSkippedReason": "not requested (...)",
}
```

`inFlightToolCalls` is the lead. An empty array means the process was idle when it crossed the
watermark — itself informative, since it rules out a tool call as the immediate cause and points
at retained state instead.

## The heap snapshot is opt-in, and there is a measured reason

Set `MINSKY_MCP_CAPTURE_HEAP_SNAPSHOT=1` to request one. It is **not** on by default, and the code
will **refuse** a requested snapshot whose projected peak exceeds its budget — the **stricter of
the kill ceiling and 1/8 of physical memory**.

Both halves of that budget are load-bearing. A ceiling-only test silently stops guarding on a class
that has no self-terminate (`ceilingBytes: Infinity`, the cockpit daemon), because nothing is ever
greater than `Infinity` — caught by the reviewer on PR #2864, where an un-fixed build was observed
taking a snapshot of a 1.34 GB process that would have peaked near 13 GB.

Node documents V8's snapshot as needing "memory about twice the size of the heap" and as "a
synchronous operation which blocks the event loop"
([nodejs.org/api/v8.html](https://nodejs.org/api/v8.html)). Bun's `generateHeapSnapshot` is backed
by JavaScriptCore, not V8, so mt#3973 measured it rather than inheriting that figure —
`bun scripts/verify-memory-capture.ts --at3`:

| Run | RSS before | RSS peak | Ratio      | Snapshot | Generation |
| --- | ---------- | -------- | ---------- | -------- | ---------- |
| 1   | 422 MB     | 4620 MB  | **10.94x** | 529 MB   | 5444 ms    |
| 2   | 423 MB     | 4400 MB  | **10.40x** | 529 MB   | 5763 ms    |

**Roughly 10x, not 2x** — about five times worse than the documented V8 figure, and blocking for
over five seconds. A snapshot at the 1024 MB watermark would transiently need ~10 GB, which would
cause the very kernel panic the ceiling exists to prevent. `HEAP_SNAPSHOT_RSS_MULTIPLIER` in
`src/mcp/memory-capture.ts` encodes this, and the capture refuses a requested snapshot whose
projected peak exceeds the ceiling, recording the refusal (and the arithmetic) in the artifact.

To take one safely, lower `MINSKY_MCP_MEMORY_CAPTURE_MB` so that `watermark x 10 < ceiling`, or
raise `MINSKY_MCP_MEMORY_CEILING_MB` for the duration of the investigation.

## Environment variables

| Variable                                 | Default                             | Effect                                                  |
| ---------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| `MINSKY_MCP_MEMORY_CEILING_MB`           | 2048                                | Self-terminate threshold (mt#3886)                      |
| `MINSKY_MCP_MEMORY_CEILING_POLL_MS`      | 30000                               | Ceiling poll interval                                   |
| `MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT` | unset                               | `1` disables the self-terminate                         |
| `MINSKY_MCP_FORCE_MEMORY_CEILING_EXIT`   | unset                               | `1` arms it on the hosted entrypoint (mt#3888)          |
| `MINSKY_MCP_MEMORY_CAPTURE_MB`           | 1024 (`mcp start`) / 2048 (cockpit) | Capture watermark                                       |
| `MINSKY_MCP_MEMORY_CAPTURE_POLL_MS`      | 30000                               | Capture poll interval                                   |
| `MINSKY_MCP_DISABLE_MEMORY_CAPTURE`      | unset                               | `1` disables capture                                    |
| `MINSKY_MCP_CAPTURE_HEAP_SNAPSHOT`       | unset                               | `1` requests a snapshot (subject to the refusal above)  |
| `MINSKY_STATE_DIR`                       | `~/.local/state/minsky`             | Shared state dir; captures go in its `memory-captures/` |

**Which of these the proxy's child-ceiling (mt#4112) reads, and the one asymmetry.** The proxy
reads `MINSKY_MCP_MEMORY_CEILING_MB`, `_POLL_MS` and `_DISABLE_MEMORY_CEILING_EXIT` exactly as the
in-process ceiling does, so a threshold or a disable set for one applies to both.
`MINSKY_MCP_FORCE_MEMORY_CEILING_EXIT` is the exception and is **not** read: it exists to opt the
hosted entrypoint into a self-kill path, and the hosted service runs `mcp start` directly — there
is no proxy there to arm. The proxy correspondingly applies no hosted-entrypoint skip, because a
per-conversation local supervisor is never the hosted service.

## Verifying

```bash
bun scripts/verify-memory-capture.ts          # both checks
bun scripts/verify-memory-capture.ts --at1    # real server: capture written AND process still exits
bun scripts/verify-memory-capture.ts --at3    # measure snapshot cost in this runtime
```

## When the proxy enforces the ceiling instead of the server (mt#4112)

Both mechanisms above run INSIDE the process they measure, on a `setInterval`. A process that has
wedged its own event loop runs neither — which is what the 2026-08-13 specimens did, reaching
48.2 GB and 32 GB with everything armed and nothing firing.

So `minsky mcp proxy` now polls its own child's swap-inclusive memory and, on a breach, kills and
respawns it. Nothing about the ceiling VALUE or its env vars changes: the proxy reads the same
`MINSKY_MCP_MEMORY_CEILING_MB` / `_POLL_MS`, and `MINSKY_MCP_DISABLE_MEMORY_CEILING_EXIT=1` turns
both off together.

**How to tell which one fired, from the artifact alone.** The `processRole` field:

| `processRole`                            | What happened                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp start (stdio)` / `mcp start (http)` | The server measured itself and self-terminated. Its event loop was running.                                                                                                                         |
| `mcp start (killed by proxy)`            | The **parent** measured it and had to kill it. Expect `heapSnapshotPath: null` with a `heapSnapshotSkippedReason` — a snapshot needs code running inside the target, and by hypothesis nothing was. |
| `mcp proxy`                              | The proxy's own memory, not its child's.                                                                                                                                                            |

A `killed by proxy` record is the stronger signal for mt#3885: it means the process was not merely
large but **unresponsive**, which the panic stackshots could never establish.

The client sees nothing. A breach takes the same kill-and-respawn path as
`__proxy_restart_server`, so the MCP connection survives — and, for the same reason, the restart is
not counted toward the proxy's crash-loop throttle.

Worst case from crossing the ceiling to the child being gone: one poll interval plus the 3s
SIGTERM grace. A wedged child always spends the full grace period, because it cannot run its own
SIGTERM handler — that is why SIGKILL is the path that actually ends it.

## Not covered

- **`mcp start` with no Minsky parent** — e.g. one a desktop app spawns directly. Nothing
  supervises it from outside, so it has the in-process ceiling only: correct measurement after
  mt#4104, still unable to fire when wedged. Unowned as of mt#4112; the tray-supervised daemon
  case is mt#4105.
- **`minsky mcp shim`** (mt#3812) has no watcher. Its entry point is deliberately import-free to
  hold a bundle-size merge gate, and importing this module would threaten that. Tracked on
  mt#3814, which owns the shim/daemon topology.
- **A shared daemon** (ADR-038) must not inherit the _ceiling_: self-terminating one process
  serving every conversation converts a leak into a fleet-wide outage. The _capture_ half carries
  over unchanged and gets more valuable there. Also mt#3814.

## See also

mt#3885 (the leak this exists to make findable) · mt#3886 (the ceiling) · mt#3888 (hosted arming)
· mem#913 (the verified panic diagnosis) · `src/mcp/memory-capture.ts` · `src/mcp/orphan-exit.ts`
