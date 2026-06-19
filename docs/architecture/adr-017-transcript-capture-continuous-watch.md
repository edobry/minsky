# ADR-017: Transcript Capture — Continuous-JSONL Watch/Sweep over Session-Exit-Event Reliance

## Status

Proposed

## Context

Claude Code session transcripts are the source for the `agent_transcripts` /
`agent_transcript_turns` substrate (the queryable surface behind `transcripts_search` /
`transcripts_search-text`). The open question is **what triggers ingestion** so a finished
session becomes searchable promptly and reliably. Three mechanisms were on the table:

- **(A) A `SessionEnd` hook** that ingests the just-finished session (mt#2192, shipped as
  PR #1513).
- **(B) A periodic sweep** that re-scans recently-modified JSONL (mt#2234, cockpit-daemon
  scheduler track).
- **(C) A filesystem watcher** (FSEvents/inotify) on `~/.claude/projects/**/*.jsonl`.

The initial design treated **(A) the SessionEnd hook as the primary event path** and (B) the
sweep as a backstop. Investigation (2026-06-04) showed that framing is backwards, for two
reasons grounded in how Claude Code actually behaves:

**1. SessionEnd is exit-semantics-dependent, and those semantics are full of holes.**

- The dominant real-world exit for multi-tab workflows is **closing the terminal tab (Cmd+W)**,
  which sends `SIGHUP`. In Claude Code v2.1.163 the foreground process _does_ trap `SIGHUP`
  and run the SessionEnd path — but with caveats: terminal "a process is running" confirmation
  friction, a hook subprocess that can be killed before completion on slow async work
  (issue #41577), and total non-firing under `SIGKILL`, force-quit, and tmux isolation.
- The **inverted finding**: `/exit` and `/clear` — the "polite" ways to end a session — do
  **not** fire SessionEnd (issues #17885, #6428, both closed "not planned"). So nudging users
  toward clean exits would make capture _less_ reliable, not more. Any design that depends on
  user exit behavior is building on sand.

**2. The transcript JSONL is written continuously, so the data is already on disk.**

Per the official docs ("Sessions are saved continuously to local transcript files as you
work"), each turn is appended to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` as it
happens — not batched at exit. Therefore **whether SessionEnd fires only affects how _soon_ a
session is searchable, never _whether_ it is recoverable.** The worst case from a missed
SessionEnd is a single dangling `tool_use` without its `tool_result` (a killed-mid-tool tail),
which is read-up-to-last-complete-line recoverable.

**Prior art is unanimous.** atuin (moved history recording out of the shell exit lifecycle into
a continuous-write daemon precisely because exit hooks are unreliable), asciinema (append-only
newline-delimited events; partial files are valid), OpenTelemetry (exit-time flush is
documented-unreliable; periodic export is the norm), and log shippers (Filebeat/Fluentd —
watch append-only files, ingest from last offset) all converge on **continuous-write +
watch/sweep**, away from exit-hook reliance.

This is an instance of Minsky's house reliability default (`decision-defaults.mdc §Reliability:
sweeper, not durable queue` / reconciliation-over-replication): don't depend on cooperative
shutdown; depend on durable incremental state plus reconciliation.

## Decision

We will make **continuous-JSONL capture the reliability backbone of transcript ingestion, and
relegate the SessionEnd hook to a non-load-bearing latency optimization.**

Concretely:

- The **reliability owner is the cockpit daemon (mt#2234)**, capturing from the
  incrementally-written JSONL under `~/.claude/projects/`. Its primary mechanism should be a
  **filesystem watcher (FSEvents/inotify) that ingests-on-append from each file's last offset**,
  with a **periodic full sweep as the backstop** for missed FS events and sessions that predate
  the watcher. Both mechanisms are independent of how (or whether) a session exits.
- The **`SessionEnd` hook (mt#2192, PR #1513) is retained as a cheap belt-and-suspenders
  fast-path** for graceful exits, but it is explicitly **not** the coverage guarantee.
- A **`SessionStart` hook** (which fires reliably) gives the daemon a live registry of active
  sessions to watch and lets the cockpit display ingestion freshness per active session.
- **Capture must be independent of how the user ends sessions.** We will **not** nudge users
  toward `/exit` or any particular teardown ritual; the user's tab-cycling + Cmd+W workflow is
  treated as a fixed input, not a behavior to correct.

All paths converge on the same idempotent, high-watermark-gated `transcripts ingest` entry
point, so overlap between watcher, sweep, hook, and the MCP boot sweep (mt#2051) is harmless.

## Consequences

**Easier:**

- Coverage no longer depends on the unreliable, hole-ridden SessionEnd surface — a session is
  recoverable regardless of crash, `SIGKILL`, tmux, `/exit`, `/clear`, or force-quit.
- Latency and reliability are decoupled: the watcher gives near-real-time freshness, the sweep
  guarantees completeness, the hook is a bonus on graceful exits.
- The design matches established prior art and Minsky's own reconciliation default, so it
  generalizes to other harnesses (Cursor, etc.) that also write incremental session logs.

**Harder / newly committed:**

- The daemon must implement a file-watcher with per-file offset tracking plus a reconciling
  sweep — more moving parts than a single exit hook. (mt#2234 now owns this; its spec should be
  expanded from "periodic sweep" to "watcher-primary + sweep-backstop".)
- The ingest pipeline must tolerate the **incomplete-final-exchange artifact** (dangling
  `tool_use` with no `tool_result`) from sessions killed mid-tool, reading up to the last
  complete exchange.
- Concurrent writers (watcher + sweep + hook + boot sweep) can now overlap; the single-writer
  concurrency guard (mt#1418, `pg_advisory_lock`) becomes a soft prerequisite.
- The reliability guarantee is bounded by the daemon being alive. If the daemon is down, the
  MCP boot sweep (mt#2051) remains the floor; full freshness resumes when the daemon restarts.

## Implementation status

Implemented under the mt#2234 umbrella:

- **Primary watcher — mt#2320 (DONE):** recursive `fs.watch` over
  `~/.claude/projects/**/*.jsonl` with per-file offset tracking
  (`JsonlTailer`), ingest-on-append via the idempotent `ingestSession`. Health
  on the cockpit `/api/health` `transcriptWatcher` field.
- **Sweep backstop — mt#2321:** `startTranscriptSweepBackstop`
  (`src/cockpit/server.ts`) runs a full-discovery `ingestAll()` + vector-only
  `index-embeddings` backfill on a **configurable cadence** (default 30m, env
  override `MINSKY_TRANSCRIPT_SWEEP_INTERVAL_MS`), fail-open. Health on the
  cockpit `/api/health` `transcriptSweep` field (counts + ISO timestamps only;
  redacted — no paths / no raw error strings). Observability is on the
  same-process `/api/health` rather than `debug_systemInfo` (which runs in the
  MCP-server process and would read zero for cockpit-process state). See
  `docs/architecture/cockpit.md` for the operational detail.

Both compose with the mt#2051 MCP boot sweep and the mt#2192 SessionEnd
fast-path; overlap is harmless (per-`turn_index` upsert + timestamp HWM). The
mt#1418 single-writer guard remains the soft prerequisite for the overlap.

## Cross-references

- Related tasks: mt#2192 (SessionEnd hook fast-path, PR #1513), mt#2234 (cockpit-daemon
  watcher + sweep — the reliability backbone), mt#2051 (MCP boot sweep — the floor),
  mt#1418 (ingest concurrency guard — soft prerequisite), mt#1313 / mt#1324 (transcripts
  substrate), mt#2021 (context-inspector consumer), mt#2230 (harness-host program umbrella),
  mt#2308 (this ADR).
- Related ADRs: ADR-014 (cockpit-daemon lifecycle ownership) — the daemon this capture work
  runs inside; ADR-002 (persistence-provider architecture) — the single-owner-with-pluggable-
  backends shape this mirrors for capture mechanisms.
- External: Claude Code hooks reference and sessions docs (continuous JSONL writes);
  issues #17885 / #6428 (`/exit`, `/clear` don't fire SessionEnd), #41577 (async hooks killed
  before completion), #18880 (incomplete JSONL on mid-tool kill), #43058 (no active-session
  query API). Prior art: atuin daemon architecture, asciicast v3 format, OpenTelemetry
  shutdown-flush guidance.
- Origin: 2026-06-04 mt#2192/mt#2234 split investigation.
