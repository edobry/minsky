# 2026-06-27/28 Supabase connectivity outage — Supavisor auth-failure breaker (mis-attributed to "runaway disk")

**Incident task:** gh#1762 **Severity:** SEV-2 **Status:** Reviewed
**Impact window:** ~2026-06-27 11:00 UTC - 2026-06-28 11:21 UTC (~24h DB-read outage)
**Detection:** by accident (agent attempting a cockpit demo) ~2026-06-28 01:46 UTC — no alert fired (MTTD ~14h45m)
**Authors:** Claude (investigation + remediation); Eugene (principal — restart + spend-cap toggle)

## Summary

For ~24h the Minsky Supabase Postgres (project ref `yvkkrpyjhoiilmizlnac`, "minsky (dev 2)") rejected
new connections, taking down the cockpit daemon's DB reads, the Minsky MCP server's vector storage, and
the prod-state cadence sweep. The proximate cause was **Supavisor's auth-failure circuit breaker**
(`ECIRCUITBREAKER: too many authentication failures, new connections are temporarily blocked`), tripped
by a sustained connection/auth storm and then self-sustaining as every retry re-armed it. The storm came
from a multi-week leak of ~126 MCP server processes, the `com.minsky.cockpit` launchd agent crash-looping
(~49,650 restarts), and Railway services crash-looping — each re-running the drizzle auto-migrate
bootstrap on every boot. It was cleared by killing the local process storm and a **full** Supabase
project restart; a _fast database reboot_ was insufficient because the breaker lives in Supavisor (the
shared pooler), not in Postgres.

The incident was initially mis-diagnosed as "runaway disk growth to hundreds of GB." That was a dashboard
misread: actual disk usage is **2.04 GB** (database 1.5 GB) on a ~9.7 GB allocation, flat across the
window. There was no disk consumer and the disk was never the cause; the misread anchored the first
diagnosis onto a disk-full story (a wrong-hypothesis-anchoring contributing factor).

## Impact

- **Surfaces:** cockpit daemon DB reads (`session_list`, etc.) failed ~24h; the Minsky MCP server fell
  back to `UnconfiguredPersistenceProvider` (no vector storage — `tasks_search` / `memory_search`
  degraded); the prod-state cadence sweep stopped (~14h stale at discovery).
- **Data:** none lost. Postgres intact — DB 1.5 GB, WAL 384 MB, logs 111 MB, 0 replication slots, 0 temp.
- **Cost exposure:** the spend cap was DISABLED as the emergency unblock and remained off; cost accrued
  against the (modestly) autoscaled disk for the duration. Re-enable pending (safe now: 2 GB << 8 GB quota).
- **MTTD ~14h45m** (outage ~11:00 UTC -> detected ~01:46 UTC, by accident, no alert). **MTTR ~24h**
  (outage -> connectivity restored ~11:21 UTC June 28). Most of the gap was detection + the restart
  round-trips, not investigation.

## Timeline (UTC)

| Time (UTC)         | Event                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~2026-06-14 onward | MCP server processes begin leaking (oldest survivor ~14 days old at investigation); `com.minsky.cockpit` launchd agent crash-looping (ADR-014 eviction never done — gh#1761) |
| 2026-06-27 10:54   | Last successful prod-state read (sweeper) — last known-good                                                                                                                  |
| 2026-06-27 ~11:00  | **OUTAGE BEGINS** — Supavisor breaker trips; new connections rejected                                                                                                        |
| 2026-06-27 11:03   | Railway reviewer service: `(EDBHANDLEREXITED) connection to database closed` -> crash -> `migration_error` loop                                                              |
| 2026-06-27 ~11:07  | Postgres log stream + Railway reviewer logs go quiet (last visible activity)                                                                                                 |
| 2026-06-28 ~01:46  | **DETECTED** — agent attempts a cockpit demo, finds DB reads failing; no alert had fired (~14h45m detection lag)                                                             |
| 2026-06-28 (early) | Principal disables the spend cap (emergency unblock; autoscale uncapped)                                                                                                     |
| 2026-06-28 ~02:00  | Investigation: 126 leaked MCP procs identified + SIGKILLed (126 -> 2, session chain preserved); 2 HTTP MCP servers killed; launchd agent confirmed already booted-out        |
| 2026-06-28 08:02   | **Fast database reboot** (principal) — INSUFFICIENT (breaker is Supavisor-level, not Postgres)                                                                               |
| 2026-06-28 08:33   | **Full project restart** (principal) — Postgres postmaster start                                                                                                             |
| 2026-06-28 ~11:21  | **RESOLVED** — breaker reset; first successful read; connections healthy                                                                                                     |
| 2026-06-28 ~11:29+ | Diagnostics confirm DB 2.04 GB, no disk consumer; the "hundreds of GB" premise refuted                                                                                       |

## Analysis

### Trigger

Supavisor's per-tenant auth-failure circuit breaker tripped (`ECIRCUITBREAKER: too many authentication
failures, new connections are temporarily blocked`) and then stayed tripped because every client retry —
the cockpit daemon's retry loop, the Railway crash-loops, new MCP process boots, and even diagnostic
probes — re-armed it.

### Contributing factors (each necessary, jointly sufficient)

1. **Multi-week MCP process leak** — ~126 `minsky mcp start/proxy` processes (oldest ~14 days), un-reaped
   orphans plus harness staleness-respawns (2,523 `process_start`, 970 `staleness_exit` in the disconnect
   log). Each idle but holding/cycling pooler connections.
2. **`com.minsky.cockpit` launchd crash-loop** (~49,650 restarts) — ADR-014 / mt#2241 made the cockpit-tray
   the canonical supervisor but never EVICTED the legacy launchd agent; both ran simultaneously; the legacy
   one couldn't bind port 3737 (held by the tray's daemon) and crash-looped. (gh#1761)
3. **Railway services crash-looping** — the reviewer service crash-looped against the same DB (minsky-mcp
   was up but idle); more connection/auth churn.
4. **Auto-migrate-on-every-boot** — each process boot re-runs the drizzle bootstrap
   (`CREATE SCHEMA / __drizzle_migrations IF NOT EXISTS`), opening a fresh connection/auth every time — a
   connection-pressure amplifier multiplied across every boot of the leaked/looping processes. (gh#1761)
5. **Self-sustaining breaker** — once tripped, retries kept it armed; a _fast database reboot_ (Postgres
   only) did not reset the Supavisor-level breaker.

### Detection gap

The cockpit is Minsky's operator-observability surface but cannot observe its OWN degradation (the
observer-can't-observe-its-own-failure meta-gap). No out-of-band alert exists; discovery was accidental
~14h in. The existing escalation machinery (MCP-disconnect tracker, subagent-dispatch tracker) covers MCP
transport and subagent cadence — not cockpit-daemon DB health. (gh#1760)

### Wrong-hypothesis note

The incident was framed as "runaway disk growth to hundreds of GB" (gh#1762's premise and the prior
agent's causal model: disk-full -> connections rejected). Evidence refuted it: the Disk Usage obs panel
showed 2.04 GB used / ~9.7 GB allocated, flat Jun 26-28; SQL showed DB 1.5 GB, 0 replication slots, WAL
384 MB, 0 temp files, and `pg_stat_archiver` failed*count 0 with ~19.6 GB of WAL generated \_in total* over
10 days (never hundreds of GB). The "hundreds of GB" figure was a dashboard misread (the principal could
not reproduce it afterward). It is plausible because Supabase surfaces several large-number metrics
(GB-hours compute billing, disk IO) that are easy to conflate with disk size, and the live disk metric was
not in the agent's context. The misread anchored the first diagnosis and delayed identifying the breaker;
notably the correct model (breaker-from-storm) was already stated in the sibling specs gh#1761 and gh#1760.

## Lessons learned

### What went well

- The local process storm was fully characterized (ps ancestry, ages, the disconnect-log cadence) and
  stopped surgically (126 -> 2, this session's MCP chain preserved).
- The disk premise was tested against authoritative evidence (SQL + the obs panel) rather than accepted,
  and corrected with proof.
- Once the opaque surfaces were identified, the authoritative ones were used: direct `psql` for the real
  pooler error, and the GitHub MCP to confirm task data when the Minsky task backend returned false data.

### What went wrong

- ~14h with zero alert — the outage was found by accident, not by monitoring.
- The "hundreds of GB" misread anchored the first diagnosis; the disk-full causal model in gh#1762's spec
  was never true.
- A _fast database reboot_ was tried first and did not reset the Supavisor breaker (wrong layer) — a
  round-trip lost.
- Self-inflicted friction: a kill-loop shell bug (output suppression hiding a zsh word-split) cost a
  diagnostic round; repeated diagnostic probes re-armed the breaker.

### Where we got lucky

- The DB was never actually at risk — ~2 GB on a text workload. Had the storm generated real WAL/data
  growth, or had an inactive replication slot been retaining WAL, a true disk-full (read-only mode, harder
  recovery, possible reconciliation writes) was entirely plausible. The same crash-loop with a different
  downstream effect would have been materially worse.
- Autoscale (with the cap then disabled) absorbed the modest growth, so a hard disk-full was avoided.
- The leaked processes were idle (~0% CPU), so mass-killing them was low-risk and fast.

## Action items

| ID (task)          | Type               | Owner      | Priority | Item                                                                                                                                                                                                                                                  |
| ------------------ | ------------------ | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gh#1761            | Prevent + Mitigate | unassigned | P1       | Tray evicts the competing `com.minsky.cockpit` launchd agent (enforce ADR-014 single ownership); daemon degrades gracefully on DB-init failure (no crash-loop, `/health` reports DB state, retry on backoff); remove `--watch` from supervised plists |
| gh#1761            | Prevent            | unassigned | P1       | Auto-migrate runs once per deploy, not per process boot (the connection-pressure amplifier)                                                                                                                                                           |
| gh#1760            | Detect             | unassigned | P1       | Out-of-band cockpit-health watchdog -> principal alert on restart-storm / DB-unreachable; prod-state-staleness escalation                                                                                                                             |
| gh#1762            | Process            | Eugene     | P2       | Re-enable the spend cap (safe now: ~2 GB << 8 GB quota) — principal dashboard                                                                                                                                                                         |
| gh#1762 -> gh#1760 | Detect             | unassigned | P2       | Disk-growth / spend-cap-approach alert (folds into the watchdog)                                                                                                                                                                                      |
| mt#2572            | Prevent            | unassigned | P1       | Fix the Minsky github-issues task backend: read-after-write consistency, id->content mapping, false-success status writes, backend-param routing                                                                                                      |
| mt#2571            | Process            | unassigned | P2       | Escalate the §Verification Commands rule to cover bulk-loop output-suppression + zsh word-splitting                                                                                                                                                   |
| mt#2574 (filed)    | Detect             | unassigned | P3       | Self-serve Supabase restart capability (Management-API restart via a working token) — removes the principal round-trips during a pooler-breaker outage                                                                                                |

## Evidence & retention

- **Disk (authoritative, post-restart SQL):** `pg_database_size(postgres)` = 1525 MB; top relations
  `agent_transcripts` 687 MB / `agent_transcript_turns` 547 MB / embeddings tables; `pg_replication_slots`
  = 0 rows; `pg_ls_waldir` = 384 MB / 25 files; `pg_ls_logdir` = 111 MB; `pg_stat_database.temp_files/bytes`
  = 0; `pg_stat_archiver` failed_count = 0, archived_count 1,225 since 2026-06-18 (~19.6 GB WAL total).
- **Disk (obs panel screenshot, 2026-06-28):** 2.04 GB used / ~9.7 GB allocated, flat Jun 26-28.
- **Real pooler error:** direct `psql` via the pooler connstr from `~/.config/minsky/config.yaml` ->
  `FATAL: (ECIRCUITBREAKER) too many authentication failures`. The Supabase MCP `execute_sql` only ever
  returned an opaque "Connection terminated due to connection timeout".
- **Process leak:** `ps` — 126 `minsky mcp` procs, oldest ~14d, ~0% CPU; disconnect log 2,523
  `process_start` / 970 `staleness_exit`.
- **Retention caveats:** `get_logs(postgres)` returned a FROZEN snapshot (~1.5d stale, identical lines, no
  staleness marker — must NOT be read as current activity); Railway deploy logs have ~24h retention; the
  dashboard "hundreds of GB" number was NOT reproducible afterward (treat as a misread, not evidence).

## Self-serve restart path (mt#2574)

`scripts/supabase/restart-project.ts` is the agent-invokable restart helper produced by this
incident's Retro 7. It wraps `POST /v1/projects/{ref}/restart` and is guarded as a destructive
op (dry-run by default; `--execute` to actually restart):

```
# Preview (safe):
bun scripts/supabase/restart-project.ts

# Execute (DESTRUCTIVE — drops active connections, ~1-3 min downtime):
bun scripts/supabase/restart-project.ts --execute
```

Token resolution: `SUPABASE_ACCESS_TOKEN` env var → `MINSKY_SUPABASE_ACCESS_TOKEN` env var →
`supabase.accessToken` in `~/.config/minsky/config.yaml`.

**KEY REMINDER:** A _fast database reboot_ (`database/restart`) only restarts Postgres — it does
NOT reset the Supavisor circuit breaker. Only this full project restart (or a pause→resume cycle)
clears the ECIRCUITBREAKER state. Do not waste time on the fast reboot if the breaker is tripped.

## Cross-references

- gh#1762 — this incident (premise corrected from "runaway disk" to "Supavisor auth-failure breaker").
- gh#1761 — split-ownership eviction + daemon graceful-degradation + auto-migrate-on-boot.
- gh#1760 — out-of-band cockpit-health watchdog / the surfacing gap.
- mt#2571, mt#2572, mt#2574 — process/tooling fixes surfaced by the incident retros.
- `scripts/supabase/restart-project.ts` — the self-serve restart helper (mt#2574).
- ADR-014 (`docs/architecture/adr-014-cockpit-daemon-lifecycle-ownership.md`) — the tray-as-supervisor
  decision whose incomplete cutover (no legacy-agent eviction) is contributing factor 2.
- Memories: `a436cdba` (Supabase incident diagnostics), `c0446133` (github task-backend bug), `ec5a1eca`
  (bulk-loop shell discipline), `d998bffa` (batch-retro discipline).
- Format precedent: `docs/incidents/2026-05-20-reviewer-triple-failure.md`. Methodology: `/postmortem` skill.
