# Cockpit tray/daemon supervision contract (mt#2629)

The tray's Rust supervisor (`cockpit-tray/src-tauri/src/supervisor.rs`,
`launchd.rs`) and the TypeScript cockpit modules
(`src/cockpit/routes/health.ts`, `src/cockpit/port-recovery.ts`,
`src/cockpit/launchd.ts`) independently implement the same supervision
fundamentals — port-holder detection, process kill, legacy-launchd eviction,
and health polling. Full unification is not available: the Rust supervisor
must keep working when the Minsky CLI/MCP process isn't running at all, so it
cannot simply import or shell out to the TS implementation. This directory
pins the parts of that duplicated contract that can be pinned with a test,
and documents the parts that can only be pinned with a comment.

## 1. Health response shape (`cockpit-health-shape.json`)

`GET /api/health` is emitted by `src/cockpit/routes/health.ts` and polled by
the Rust supervisor (`health_ok` / `poll_health_detail` in
`cockpit-tray/src-tauri/src/supervisor.rs`). `cockpit-health-shape.json` in
this directory is the single golden fixture both sides read:

- **Bun side** — `src/cockpit/health-contract.test.ts` boots the real
  `createCockpitServer()`, fetches `/api/health`, and asserts the live
  response's field set and per-field types equal `fields` in the fixture
  exactly (no missing field, no unexpected extra field, no type drift).
- **Cargo side** — `cockpit-tray/src-tauri/src/supervisor.rs`'s
  `health_contract` test module reads the SAME fixture via `include_str!`
  and asserts two things: (a) every field in `rustConsumedFields` (the
  fields `poll_health_detail` actually parses — currently `db` and
  `processStartedAtMs`) is present in the fixture, and (b) the literal
  TypeScript source of `src/cockpit/routes/health.ts` (also pulled in via
  `include_str!`) still emits each of those field names. (b) is what makes a
  same-PR rename in `health.ts` fail the cargo test directly, without
  requiring the fixture to be regenerated first.

**What this catches:** renaming, removing, or changing the type of any
top-level `/api/health` field in `health.ts` fails the bun test immediately
(the live response no longer matches the checked-in fixture). Renaming one
of the two Rust-consumed fields (`db`, `processStartedAtMs`) additionally
fails the cargo test immediately (the source-text scan no longer finds the
old field name). Landing the rename cleanly requires updating this fixture
AND (for the two Rust-consumed fields) `supervisor.rs`'s parsing code —
which is the explicit goal: the two implementations cannot silently drift
apart on the fields that matter to both.

**What this does NOT catch:** a _value_-level regression (e.g. `db` still
typed `string` but now emitting a value outside `"ok" | "degraded" |
"unreachable"`) is out of scope for this shape-level pin. Nested-object
internals of `transcriptWatcher` / `transcriptSweep` are pinned only at the
`"object"` type level — neither side parses their internals today, so a
finer-grained pin would be over-fitting to code that doesn't exist yet.

## 2. Port/process-detection semantics

Both sides answer "who, if anyone, is listening on the cockpit port
(3737)?" using the same underlying tool (`lsof`) but two independent
invocations that are NOT tested against each other — there is no shared
fixture for this half of the contract, only documentation + cross-reference
comments, because the signal is a live OS process table, not a static
response shape.

|                | TypeScript                                                                                                                                     | Rust                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point    | `findPortHolder(port)` in `src/cockpit/port-recovery.ts`                                                                                       | `pid_on_port(port, path)` in `cockpit-tray/src-tauri/src/supervisor.rs`                                                                |
| Command        | `lsof -i :<port> -sTCP:LISTEN -P -n -t`                                                                                                        | `lsof -ti tcp:<port> -sTCP:LISTEN`                                                                                                     |
| Output parsing | first whitespace-delimited token of stdout, parsed as a PID                                                                                    | first line of stdout that parses as `u32` (`parse_lsof_pid`)                                                                           |
| Extra step     | resolves the holder's command line via `ps -p <pid> -o command=` (used to classify recognized-zombie vs. unrecognized in `classifyPortHolder`) | none — the Rust side only needs the PID (to kill it or evict legacy launchd)                                                           |
| Kill mechanism | `killZombie`: SIGTERM, poll, then SIGKILL after a timeout — only for a PID this workspace recognizes as its own prior instance                 | `kill_pid`: unconditional SIGTERM (no SIGKILL escalation, no self-recognition check — the tray is the sole intended owner per ADR-014) |

Both invocations filter to `LISTEN`-state sockets only (so a client
connection to the port from an unrelated process is never mistaken for the
port holder) and both treat "no matching PID" as "port free" rather than an
error. These two invariants are the actual cross-language contract; the
exact `lsof` flags differ (`-i :N` vs `-ti tcp:N`) but are equivalent
filters, and are not expected to converge — see the cross-reference
comments at each function for the pointer back here.

## Cross-references

- mt#2629 — this contract-pinning task; mt#2607 finding 10 — the audit that
  named the drift risk; mt#2608 — CI wiring for the canonical bun suite;
  mt#2628 — the `main.rs` split that moved this code into `supervisor.rs` /
  `launchd.rs`.
- `docs/architecture/adr-014-cockpit-daemon-lifecycle-ownership.md` — the
  single-ownership model both port-detection paths serve.
- `docs/architecture/cockpit.md` — `/api/health` field documentation
  (`transcriptWatcher`, `transcriptSweep`).
