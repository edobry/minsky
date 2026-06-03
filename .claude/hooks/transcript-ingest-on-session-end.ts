#!/usr/bin/env bun
// SessionEnd hook: ingest the just-finished Claude Code session's transcript into
// the agent_transcripts substrate so it becomes searchable promptly (mt#2192).
//
// Why this exists. Transcript ingestion previously fired ONLY on MCP server boot
// (a fire-and-forget best-effort sweep, mt#2051) or via a manual
// `transcripts_ingest` command. A session that finished while the server was
// already running stayed unsearchable until the next successful boot sweep — and
// boot-sweep errors were silently swallowed (`.catch(() => {})`). Originating
// incident (2026-05-31): a session that ran 2026-05-27→28 was missing from the
// DB and was only locatable by grepping the raw JSONL on disk.
//
// This hook fires on SessionEnd and runs `minsky transcripts ingest
// --session=<id>` synchronously. Ingest is HWM-gated and incremental, so it is a
// cheap no-op for an already-ingested session and an incremental top-up
// otherwise. FTS search (`transcripts_search-text`) works immediately after
// ingest and needs no external API — which is exactly the surface the originating
// incident needed (the session was ultimately found by text grep). Semantic
// search (`transcripts_search`) additionally needs embeddings; that is a heavier,
// provider-dependent step gated behind MINSKY_TRANSCRIPT_INGEST_HOOK_EMBED
// (default OFF). The default semantic-backfill home is mt#2234's cadence sweep,
// which can run index-embeddings off the session-exit critical path.
//
// Observability (mt#2192 SC2): every run appends a JSON line to
// <state-dir>/transcript-ingest-hook-log.jsonl recording the ingest exit code
// and (on failure) stderr, so a failed ingest leaves a signal an operator can
// find rather than being silently swallowed.
//
// Reliability boundary (Covers / Does NOT cover):
//   Covers   — sessions that end normally (SessionEnd fires).
//   Does NOT — sessions killed via SIGKILL / crash (SessionEnd never fires), and
//              embedding backfill when the opt-in embed step is off or times out.
//              Both are backstopped by the MCP boot sweep (mt#2051) and the
//              cadence sweep (mt#2234).
//
// Override: MINSKY_SKIP_TRANSCRIPT_INGEST_HOOK=1|true|yes skips the hook with an
// audit line to stdout. The hook ALWAYS exits 0 — SessionEnd is a
// no-decision-control event and must never block session teardown.
//
// @see mt#2192 — this hook
// @see mt#2051 — boot-time ingest sweep (the prior sole automatic trigger)
// @see mt#2234 — cadence sweep (periodic ingest backstop + semantic-embed backfill)
// @see .claude/hooks/inject-current-time.ts — hook structure template

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { readInput } from "./types";
import type { ClaudeHookInput } from "./types";

/** Skip the whole hook. Registered in HOOK_ONLY_ENV_VARS (mt#1788 rule). */
export const TRANSCRIPT_INGEST_OVERRIDE_ENV = "MINSKY_SKIP_TRANSCRIPT_INGEST_HOOK";
/** Opt in to the heavier, provider-dependent embedding step (default OFF). */
export const TRANSCRIPT_INGEST_EMBED_ENV = "MINSKY_TRANSCRIPT_INGEST_HOOK_EMBED";
/** Observable JSONL log filename under the minsky state dir. */
export const HOOK_LOG_FILENAME = "transcript-ingest-hook-log.jsonl";

// Internal per-step budgets. The settings.json host timeout (45s) bounds the
// whole hook; these keep ingest + optional embed under that cap.
export const INGEST_TIMEOUT_MS = 20_000;
export const EMBED_TIMEOUT_MS = 20_000;

// Single source of truth for the no-session-id skip reason, so the JSONL log
// record and the returned outcome cannot drift (reviewer R1, PR #1513).
export const NO_SESSION_ID_REASON = "no-session-id";

export interface SessionEndHookInput extends ClaudeHookInput {
  reason?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface IngestDeps {
  runCommand: (cmd: string[], opts: { timeoutMs: number }) => CommandResult;
  appendLog: (logPath: string, line: string) => void;
  resolveLogPath: () => string;
  now: () => Date;
  /** Resolved minsky executable (bare "minsky" relies on the augmented PATH). */
  minskyBin: string;
  /** Whether to run the optional embedding step after a successful ingest. */
  embeddingsEnabled: boolean;
}

export function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

export interface IngestOutcome {
  skipped: boolean;
  reason?: string;
  ingestExitCode?: number;
  /** Surfaced so a timed-out ingest is distinguishable from a generic failure. */
  ingestTimedOut?: boolean;
  embeddingsRan?: boolean;
  embeddingsExitCode?: number;
  embeddingsTimedOut?: boolean;
}

/**
 * Core hook logic. Pure with respect to injected deps so tests drive it with
 * fakes. Never throws — every failure path is recorded to the log and folded
 * into the returned outcome. The entrypoint always exits 0.
 */
export function runTranscriptIngestOnSessionEnd(
  input: SessionEndHookInput,
  deps: IngestDeps
): IngestOutcome {
  const logPath = deps.resolveLogPath();
  const ts = deps.now().toISOString();
  const sessionId = input.session_id;

  const writeRecord = (record: Record<string, unknown>): void => {
    try {
      deps.appendLog(
        logPath,
        `${JSON.stringify({ timestamp: ts, event: "session_end", ...record })}\n`
      );
    } catch {
      // Logging is best-effort; never let it break the hook.
    }
  };

  if (!sessionId) {
    writeRecord({
      skipped: true,
      reason: NO_SESSION_ID_REASON,
      detail: "no session_id in hook input",
    });
    return { skipped: true, reason: NO_SESSION_ID_REASON };
  }

  // ── Ingest (synchronous, fast, no external API needed). ──
  let ingest: CommandResult;
  try {
    ingest = deps.runCommand(
      [deps.minskyBin, "transcripts", "ingest", `--session=${sessionId}`, "--harness=claude_code"],
      { timeoutMs: INGEST_TIMEOUT_MS }
    );
  } catch (err) {
    writeRecord({
      sessionId,
      ingest: { error: err instanceof Error ? err.message : String(err) },
    });
    return { skipped: false, reason: "ingest-threw" };
  }

  const ingestOk = ingest.exitCode === 0 && !ingest.timedOut;

  // ── Embeddings (opt-in, heavier; needs embedding + LLM providers). ──
  let embeddingsRan = false;
  let embed: CommandResult | undefined;
  if (ingestOk && deps.embeddingsEnabled) {
    try {
      embed = deps.runCommand(
        [deps.minskyBin, "transcripts", "index-embeddings", `--session=${sessionId}`],
        { timeoutMs: EMBED_TIMEOUT_MS }
      );
      embeddingsRan = true;
    } catch (err) {
      embed = {
        exitCode: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  }

  writeRecord({
    sessionId,
    ingest: {
      exitCode: ingest.exitCode,
      timedOut: ingest.timedOut ?? false,
      ...(ingestOk ? {} : { stderr: truncate(ingest.stderr || ingest.stdout, 2000) }),
    },
    ...(deps.embeddingsEnabled
      ? {
          embeddings: embed
            ? {
                exitCode: embed.exitCode,
                timedOut: embed.timedOut ?? false,
                ...(embed.exitCode === 0 && !embed.timedOut
                  ? {}
                  : { stderr: truncate(embed.stderr || embed.stdout, 2000) }),
              }
            : { attempted: false, reason: "ingest failed; embeddings skipped" },
        }
      : {}),
  });

  return {
    skipped: false,
    ingestExitCode: ingest.exitCode,
    ingestTimedOut: ingest.timedOut ?? false,
    embeddingsRan,
    ...(embed
      ? { embeddingsExitCode: embed.exitCode, embeddingsTimedOut: embed.timedOut ?? false }
      : {}),
  };
}

// ── Real dependency wiring ──────────────────────────────────────────────────

function resolveStateDir(env: Record<string, string | undefined>): string {
  const stateDir = env.MINSKY_STATE_DIR;
  return stateDir && stateDir.trim().length > 0
    ? stateDir
    : join(homedir(), ".local", "state", "minsky");
}

function realRunCommand(cmd: string[], opts: { timeoutMs: number }): CommandResult {
  // Augment PATH so `minsky` (installed at ~/.bun/bin) resolves regardless of
  // the shell PATH that launched Claude Code. Mirrors execWithPath in types.ts
  // but additionally prepends ~/.bun/bin where the minsky binary lives.
  const pathPrefix = `${join(homedir(), ".bun", "bin")}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  const result = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs,
    env: { ...process.env, PATH: pathPrefix },
  });
  const timedOut = result.exitCode === null && result.signalCode === "SIGTERM";
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    timedOut,
  };
}

async function main(): Promise<void> {
  const env = process.env;

  // Override path: skip everything, emit a non-JSON audit line to stdout
  // (Claude Code logs it as "Ignoring non-JSON line on stdout" — the
  // sibling-hook audit convention).
  if (isTruthy(env[TRANSCRIPT_INGEST_OVERRIDE_ENV])) {
    process.stdout.write(
      `[transcript-ingest-on-session-end] override active: ${TRANSCRIPT_INGEST_OVERRIDE_ENV}=${env[TRANSCRIPT_INGEST_OVERRIDE_ENV]} at ${new Date().toISOString()}\n`
    );
    return;
  }

  let input: SessionEndHookInput;
  try {
    input = await readInput<SessionEndHookInput>();
  } catch {
    return; // garbage-in → no-op
  }

  runTranscriptIngestOnSessionEnd(input, {
    runCommand: realRunCommand,
    appendLog: (logPath, line) => {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line);
    },
    resolveLogPath: () => join(resolveStateDir(env), HOOK_LOG_FILENAME),
    now: () => new Date(),
    minskyBin: "minsky",
    embeddingsEnabled: isTruthy(env[TRANSCRIPT_INGEST_EMBED_ENV]),
  });
}

// Entrypoint guard: only run main() when invoked as a script. Tests import the
// pure functions without triggering a stdin read.
if (import.meta.main) {
  await main();
}
