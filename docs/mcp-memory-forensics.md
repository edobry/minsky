# MCP resident-memory: ceiling, capture, and how to read what they leave behind

Two mechanisms guard against — and now explain — a Minsky process growing until it exhausts host
memory. They are deliberately independent.

|          | **Ceiling** (mt#3886)                            | **Capture** (mt#3973)                                |
| -------- | ------------------------------------------------ | ---------------------------------------------------- |
| Fires at | `MINSKY_MCP_MEMORY_CEILING_MB`, default **2048** | `MINSKY_MCP_MEMORY_CAPTURE_MB`, default **1024**     |
| Does     | logs the breach, then `process.exit`             | writes an artifact to disk, then gets out of the way |
| Answers  | _which process class_ ballooned                  | _what it was doing_                                  |
| Covers   | `mcp start` (all transports), `mcp proxy`        | `mcp start`, `cockpit start` (watermark 2048)        |

The capture watermark must sit **below** the ceiling or it could never fire; a misconfiguration
that puts it at or above the ceiling refuses to arm and logs an error rather than burning a timer
to produce nothing.

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

Set `MINSKY_MCP_CAPTURE_HEAP_SNAPSHOT=1` to request one. It is **not** on by default and the code
will **refuse** it when taking it would breach the ceiling.

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

## Verifying

```bash
bun scripts/verify-memory-capture.ts          # both checks
bun scripts/verify-memory-capture.ts --at1    # real server: capture written AND process still exits
bun scripts/verify-memory-capture.ts --at3    # measure snapshot cost in this runtime
```

## Not covered

- **`minsky mcp shim`** (mt#3812) has no watcher. Its entry point is deliberately import-free to
  hold a bundle-size merge gate, and importing this module would threaten that. Tracked on
  mt#3814, which owns the shim/daemon topology.
- **A shared daemon** (ADR-038) must not inherit the _ceiling_: self-terminating one process
  serving every conversation converts a leak into a fleet-wide outage. The _capture_ half carries
  over unchanged and gets more valuable there. Also mt#3814.

## See also

mt#3885 (the leak this exists to make findable) · mt#3886 (the ceiling) · mt#3888 (hosted arming)
· mem#913 (the verified panic diagnosis) · `src/mcp/memory-capture.ts` · `src/mcp/orphan-exit.ts`
