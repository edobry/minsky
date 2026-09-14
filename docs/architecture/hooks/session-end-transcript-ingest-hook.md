# Session-End Transcript Ingest Hook

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A `SessionEnd` hook that ingests the just-finished Claude Code session's
transcript into the `agent_transcripts` substrate so finished sessions are
searchable promptly (mt#2192). Before this, ingestion fired ONLY on MCP server
boot (a fire-and-forget best-effort sweep, mt#2051) or via a manual
`transcripts_ingest` — so a session that finished while the server was already
running stayed unsearchable until the next successful boot sweep, and boot-sweep
errors were silently swallowed (`.catch(() => {})`). Originating incident
(2026-05-31): a session that ran 2026-05-27→28 was missing from the DB and only
locatable by grepping raw JSONL.

**Hook file:** `.claude/hooks/transcript-ingest-on-session-end.ts`

**How it works:**

1. Reads `session_id` from the SessionEnd hook input.
2. Runs `minsky transcripts ingest --session=<id> --harness=claude_code --ended`
   synchronously. The ingest is HWM-gated and incremental (a cheap no-op for an
   already-ingested session). FTS search (`transcripts_search-text`) works
   immediately after a successful ingest; no external API is needed.
3. Optionally (opt-in) runs `minsky transcripts index-embeddings --session=<id>`
   so semantic `transcripts_search` is populated too — best-effort, default OFF.
4. Appends one JSON record per run to
   `<state-dir>/transcript-ingest-hook-log.jsonl` (the observability surface).

**The `--ended` flag (mt#3131 D2) — SessionEnd-only termination evidence.**
`agent_transcripts.ended_at` asserts that a conversation TERMINATED, and it is
populated only when an ingest call carries positive evidence of termination.
This hook is that one caller: the harness's own SessionEnd lifecycle event is
the evidence, so the hook's ingest invocation passes `--ended` (single-session
mode only — it has no meaning for an `--all` sweep). Every OTHER ingest path —
the MCP boot sweep (mt#2051), the cockpit transcript watcher, the cadence sweep
(mt#2234), and any manual `transcripts ingest` — MUST omit the flag: before
mt#3131, every ingest unconditionally stamped `endedAt` with the latest
observed line timestamp, which made the field mean "last observed" while its
name asserted "ended" (verified: 50/50 context-inspector rows carried non-null
`endedAt`, including live conversations). A routine sweep passing `--ended`
would reintroduce exactly that false-termination assertion. "Last observed"
remains available separately as `lastIngestedJsonlTimestamp` (surfaced to the
cockpit as `lastActivityAt`). A stale/duplicate SessionEnd delivery is safe:
a non-`--ended` ingest never regresses an already-recorded `endedAt`.

**Observability (the de-silenced boot sweep):** alongside the hook, the boot
sweep's swallowed failures were surfaced — `startup-transcript-ingest.ts` now
logs DB-unavailable skips and errored-session runs at `warn` (was `debug`-only),
and `start-command.ts`'s `.catch(() => {})` now logs the failure at `warn`. A
failed ingest now leaves an operator-findable signal rather than vanishing.

**Reliability boundary (Covers / Does NOT cover)** — enumerated from measured
SessionEnd deliveries, not from assumed exit semantics (mt#2313; the original
text said "covers sessions that end normally", which was never measured):

- **Covers** conversations whose SessionEnd fires. Measured 2026-09-13 in
  `conversation_run_state.ended_hint_reason` (written by
  `record-conversation-run-state.ts` on every delivery, 760 rows since
  2026-07-29): `clear` 340 — so **`/clear` DOES fire SessionEnd**, contrary to
  ADR-017's original reading of Claude Code issues #17885/#6428 — `other` 369,
  `prompt_input_exit` 50, `logout` 1, `resume` 0. The hooks reference
  (`https://code.claude.com/docs/en/hooks`) lists `clear` and `resume` among the
  `reason` values; `resume` is listed there and never observed in those 760
  rows, so treat it as a documented-but-unmeasured value, not as coverage.
- **Does NOT cover** a crash / SIGKILL (the event never fires); a SIGHUP from
  closing the tab that kills the hook mid-ingest (#41577 — the synchronous
  ingest can run up to 45s, so even a delivered SessionEnd is not a completed
  ingest); **`/exit`, which is UNMEASURED** — no `reason` value distinguishes
  it, `other` may include it, and the issues above say it does not fire; a
  mid-tool kill, whose tail is a dangling `tool_use` with no `tool_result`
  (#18880) that the ingest reads up to; and the default semantic-embed
  backfill. All are backstopped by the MCP boot sweep (mt#2051) and the cadence
  sweep (mt#2234, the periodic sweep in the cockpit daemon).

Per ADR-017 the watcher + sweep are the coverage **guarantee**; this hook is the
non-load-bearing **latency optimization** for the exits that do fire. Do not
read a SessionEnd delivery as proof a conversation ended cleanly, nor its
absence as proof it did not.

**Always exits 0.** SessionEnd is a no-decision-control event; the hook must
never block session teardown. Timeout 45s (settings.json).

**Override mechanism:** Set `MINSKY_SKIP_TRANSCRIPT_INGEST_HOOK=1` (or
`true` / `yes`) to skip the hook (emits a non-JSON audit line to stdout). Set
`MINSKY_TRANSCRIPT_INGEST_HOOK_EMBED=1` to opt in to the synchronous embedding
step (default OFF).

**Env-var registration:** both `MINSKY_SKIP_TRANSCRIPT_INGEST_HOOK` and
`MINSKY_TRANSCRIPT_INGEST_HOOK_EMBED` are registered in `HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` per the
`custom/no-unregistered-minsky-env-var` ESLint rule (mt#1788). The override
env-var names' source of truth lives in the hook file as exported constants
(`TRANSCRIPT_INGEST_OVERRIDE_ENV`, `TRANSCRIPT_INGEST_EMBED_ENV`).

**Verification artifact:** `scripts/smoke-transcript-ingest-hook.ts` live-verifies
the end-to-end SessionEnd-payload → CLI ingest → observable-log → DB-reachable
chain (env-gated; skips gracefully without `minsky` or a discoverable session).

**Cross-references:**

- mt#2192 — this hook's tracking task (event/hook slice)
- mt#2234 — cockpit-daemon cadence sweep (periodic backstop + default
  semantic-embed backfill); mt#2047 was CLOSED and subsumed
- mt#2051 — boot-time ingest sweep (the prior sole automatic trigger)
- mt#1418 — `ingestAll()` single-writer concurrency guard (soft prerequisite once
  multiple triggers overlap)
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration contract)
