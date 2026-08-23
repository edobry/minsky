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

**Two health fixtures live here, for two different services (mt#4322).**
`cockpit-health-shape.json` pins the COCKPIT's `GET /api/health`;
`mcp-health-shape.json` pins the MCP DAEMON's `GET /health`. They are different
bodies with different consumers and must not be conflated — the tray polls both,
at different paths, and asserts a different `service` identity on each. Section 1
below covers the cockpit fixture; section 1a covers the MCP one.

## 1. Health response shape (`cockpit-health-shape.json`)

`GET /api/health` is emitted by `src/cockpit/routes/health.ts` and polled by
the Rust supervisor (`daemon_core::probe_health` for the transport and the
identity, `supervisor::db_status_from_body` for the cockpit-only `db` field).
`cockpit-health-shape.json` in this directory is the single golden fixture both
sides read:

**mt#3815 changed which fields the Rust side consumes, and why.** The supervisor
now watches a REGISTRY of daemons rather than one, so the endpoint path is
per-entry (`/api/health` for the cockpit, `/health` for the MCP daemon) and the
probe asserts the body's `service` identity instead of accepting any 2xx —
`service` is therefore a `rustConsumedFields` entry now. The old `health_ok` /
`poll_health_detail` pair named below is gone; their replacements are named
above and read the same fields.

- **Bun side** — `src/cockpit/health-contract.test.ts` boots the real
  `createCockpitServer()`, fetches `/api/health`, and asserts the live
  response's field set and per-field types equal `fields` in the fixture
  exactly (no missing field, no unexpected extra field, no type drift).
- **Cargo side** — `cockpit-tray/src-tauri/src/supervisor.rs`'s
  `health_contract` test module reads the SAME fixture via `include_str!`
  and asserts two things: (a) every field in `rustConsumedFields` (the
  fields the supervisor actually parses — currently `service`, `db` and
  `processStartedAtMs`) is present in the fixture, and (b) the literal
  TypeScript source of `src/cockpit/routes/health.ts` (also pulled in via
  `include_str!`) still emits each of those field names. (b) is what makes a
  same-PR rename in `health.ts` fail the cargo test directly, without
  requiring the fixture to be regenerated first.

**What this catches:** renaming, removing, or changing the type of any
top-level `/api/health` field in `health.ts` fails the bun test immediately
(the live response no longer matches the checked-in fixture). Renaming one
of the three Rust-consumed fields (`service`, `db`, `processStartedAtMs`)
additionally fails the cargo test immediately (the source-text scan no longer
finds the old field name). Landing the rename cleanly requires updating this
fixture AND (for the three Rust-consumed fields) the tray's parsing code —
which is the explicit goal: the two implementations cannot silently drift
apart on the fields that matter to both.

**What this does NOT catch:** a _value_-level regression (e.g. `db` still
typed `string` but now emitting a value outside `"ok" | "degraded" |
"unreachable"`) is out of scope for this shape-level pin. Nested-object
internals of `transcriptWatcher` / `transcriptSweep` are pinned only at the
`"object"` type level — neither side parses their internals today, so a
finer-grained pin would be over-fitting to code that doesn't exist yet.

## 1a. MCP daemon health response shape (`mcp-health-shape.json`)

`GET /health` on the MCP daemon, emitted by `buildMcpHealthResponse`
(`src/mcp/health-payload.ts`) and served by the route in
`src/commands/mcp/start-command.ts`. Pinned by mt#4322.

The assertion differs from section 1's in one deliberate way: the cockpit test
boots a real server and fetches the live route, which is cheap for an Express
app. Booting the MCP server to read one route is not — it resolves a DI
container, binds a port and installs shutdown handlers. So the payload was
extracted into a pure builder and `src/mcp/health-payload.test.ts` asserts THAT,
which is the same function the route calls. A field renamed in the emitter fails
the contract test; a field renamed only in the test fails nothing, because the
fixture is the contract rather than the test's copy of it.

Two invariants a consumer or a future edit must preserve, both documented at
length in the fixture's own `$readyFieldNote`:

1. **The status code is not derived from `ready`, and readiness is not derived
   from the status code.** `persistence.mode === "unconfigured"` is a 200 with
   `ready: false` on purpose — that is the expected local/dev/offline boot and
   the exact state `bundle-boot-smoke` asserts a 200 against, while a daemon in
   it can serve no DB-backed work. Collapsing the two either breaks that CI gate
   or re-opens the 31-hour outage `ready` was added to surface (mt#4297).
2. **`ready`'s consumer stays tolerant of its absence.** `classifyDaemonProbe`
   (`src/mcp/setup/local-http-apply.ts`) reads `ready` when present and falls
   back to `persistence.mode` otherwise, because keying on it alone would
   classify every pre-mt#4297 daemon as not-ready — including during a rollout.
   The fixture requiring the field and the consumer tolerating its absence are
   not in conflict: the fixture pins what THIS build emits, the fallback covers
   what an OLDER one does.

## 2. Port/process-detection semantics

Both sides answer "who, if anyone, is listening on the cockpit port?" using the
same underlying tool (`lsof`) but two independent invocations that are NOT
tested against each other — there is no shared fixture for this half of the
contract, only documentation + cross-reference comments, because the signal is a
live OS process table, not a static response shape.

**Which port that is, is itself part of the contract (mt#3988).** It used to be
the literal 3737 on both sides. It is now the `cockpit.port` configuration key
(default 3737, `MINSKY_COCKPIT_PORT` override, explicit `--port` wins), resolved
in ONE place — `resolveCockpitPort` in `src/commands/cockpit/port.ts` — and read
by the Rust side at tray startup rather than reimplemented there. Both entry
points below already TAKE a port parameter, so nothing about the probes changed;
what changed is that the callers no longer pin the argument to a constant. A
future change to either side must keep asking about the same port the daemon was
actually started on — the 2026-06-04 incident (two daemons, two ports, browser
on the stale one) is what a disagreement here looks like.

|                | TypeScript                                                                                                                                     | Rust                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point    | `findPortHolder(port)` in `src/cockpit/port-recovery.ts`                                                                                       | `pid_on_port(port, path)` in `cockpit-tray/src-tauri/src/supervisor.rs`                                                                |
| Command        | `lsof -i tcp@localhost:<port> -sTCP:LISTEN -P -n -t` (loopback only, mt#3787)                                                                  | `lsof -ti tcp@localhost:<port> -sTCP:LISTEN` (loopback only, mt#3785)                                                                  |
| Output parsing | first whitespace-delimited token of stdout, parsed as a PID                                                                                    | first line of stdout that parses as `u32` (`parse_lsof_pid`)                                                                           |
| Extra step     | resolves the holder's command line via `ps -p <pid> -o command=` (used to classify recognized-zombie vs. unrecognized in `classifyPortHolder`) | none — the Rust side only needs the PID (to kill it or evict legacy launchd)                                                           |
| Kill mechanism | `killZombie`: SIGTERM, poll, then SIGKILL after a timeout — only for a PID this workspace recognizes as its own prior instance                 | `kill_pid`: unconditional SIGTERM (no SIGKILL escalation, no self-recognition check — the tray is the sole intended owner per ADR-014) |

Both invocations filter to `LISTEN`-state sockets only (so a client
connection to the port from an unrelated process is never mistaken for the
port holder) and both treat "no matching PID" as "port free" rather than an
error. These two invariants are the actual cross-language contract, and both
sides still honor them; the exact `lsof` flags differ and are not expected to
converge — see the cross-reference comments at each function for the pointer
back here.

**Address scope is a third shared invariant (mt#3785 + mt#3787, 2026-08-05).**
Both probes are scoped to LOOPBACK, and neither should be widened without
widening the other. The flag forms were once described here as equivalent
filters while both were unscoped; that equivalence was the bug. An unscoped
form matches a listener on ANY interface, so with Tailscale serving the cockpit
port on the tailnet addresses, `lsof -i :3737 -sTCP:LISTEN` returned two PIDs
and each implementation's "first PID wins" parsing picked between them
arbitrarily. The consequences differed, which is why the two sides were fixed
in that order: on the Rust side the result fed `kill_pid`, so a SIGTERM meant
for the cockpit daemon could have gone to an unrelated process (mt#3785); on the
TypeScript side `killZombie` only fires on a PID this workspace recognizes as
its own prior instance, so the harm was `cockpit start` telling the OPERATOR to
kill the wrong process (mt#3787). `tcp@localhost` rather than `tcp@127.0.0.1` on
both sides: the resolver form covers both loopback families, verified against a
live IPv6-only listener.

Note also that the Rust side answers a SECOND question separately: whether the
port is available at all is now a bind probe (`port_in_use`), per ADR-014's
"prefer attempting the daemon's own bind" guidance, not an lsof lookup. Only
the "who holds it" question above uses `lsof`.

## Cross-references

- mt#2629 — this contract-pinning task; mt#2607 finding 10 — the audit that
  named the drift risk; mt#2608 — CI wiring for the canonical bun suite;
  mt#2628 — the `main.rs` split that moved this code into `supervisor.rs` /
  `launchd.rs`.
- `docs/architecture/adr-014-cockpit-daemon-lifecycle-ownership.md` — the
  single-ownership model both port-detection paths serve.
- `docs/architecture/cockpit.md` — `/api/health` field documentation
  (`transcriptWatcher`, `transcriptSweep`).
