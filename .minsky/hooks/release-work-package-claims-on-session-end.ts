#!/usr/bin/env bun
// SessionEnd hook: release the work-package claims this conversation holds
// (mt#5132; mt#5122 SC2 — "release a claim whose conversation has ended").
//
// A conversation that claimed a work package (ADR-046) and then ended leaves
// the package IN-PROGRESS with nobody working it — invisible to the pointing
// surface and to the next conversation looking for a queue. This hook fires
// on SessionEnd and runs ONE CLI call:
//
//   minsky tasks release-conversation <session_id> --reason <reason>
//
// which releases every IN-PROGRESS package whose claim identity is exactly
// `<kind>:conv:<session_id>` — the payload's own conversation id, the one
// identity this hook holds that is not shared. It deliberately releases
// NOTHING claimed under a `proc:` id: that is a one-way hash of the MCP
// daemon process, shared by every conversation on the daemon, so "this
// process's claims" would be another conversation's too (measured 2026-09-13:
// two conversations' presence rows under one actor id). Those fall to the
// package-lifecycle sweep's 24h staleness backstop, which is the correctness
// layer; this hook is the latency optimization — ADR-017's posture for every
// SessionEnd hook, since the event does not fire on a crash or SIGKILL.
//
// Reasons under which the claims are KEPT (the command decides, the hook only
// forwards the value): `clear` — the process and its identity survive, and
// the successor conversation inherits the claim; `resume` — the conversation
// continues in a later process. Values per the Claude Code hooks reference
// (read 2026-09-13): clear | resume | logout | prompt_input_exit | other.
//
// Reliability boundary (Covers / Does NOT cover):
//   Covers   — a conversation that ends normally with a `conv:`-scoped claim.
//   Does NOT — `proc:`-scoped and free-text claims (the sweep's); a crash /
//              SIGKILL (SessionEnd never fires — the sweep's); a claim
//              inherited across `/clear` (the successor's session_id differs
//              — the sweep's).
//
// Observability: every run appends a JSON line to
// <state-dir>/release-work-package-claims-hook-log.jsonl with the command's
// exit code and (on failure) stderr. The hook ALWAYS exits 0 — SessionEnd
// cannot block exit and must never delay teardown; the CLI call is bounded.
//
// Override: MINSKY_HOOK_OVERRIDE=release-work-package-claims-on-session-end
// (ADR-028 D3 — no bespoke MINSKY_SKIP_* name is minted).
//
// @see mt#5132 — this hook, the sweep, the commands
// @see .claude/hooks/transcript-ingest-on-session-end.ts — the sibling whose shape this copies

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { readInput } from "./types";
import type { ClaudeHookInput } from "./types";

/** Guard name for MINSKY_HOOK_OVERRIDE. */
export const RELEASE_CLAIMS_HOOK_NAME = "release-work-package-claims-on-session-end";
const HOOK_OVERRIDE_ENV_VAR = "MINSKY_HOOK_OVERRIDE";

/** `MINSKY_HOOK_OVERRIDE=<name>[,...]|all` names this hook (ADR-028 D3's canonical channel). */
export function isOverridden(env: Record<string, string | undefined>): boolean {
  const raw = env[HOOK_OVERRIDE_ENV_VAR];
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .some((name) => name === "all" || name === RELEASE_CLAIMS_HOOK_NAME);
}
/** Observable JSONL log filename under the minsky state dir. */
export const RELEASE_CLAIMS_HOOK_LOG_FILENAME = "release-work-package-claims-hook-log.jsonl";
/** Bound on the one CLI call; the settings.json host timeout sits above it. */
export const RELEASE_CLAIMS_TIMEOUT_MS = 20_000;

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

export interface ReleaseClaimsDeps {
  runCommand: (cmd: string[], opts: { timeoutMs: number }) => CommandResult;
  appendLog: (logPath: string, line: string) => void;
  resolveLogPath: () => string;
  now: () => Date;
  /** Resolved minsky executable (bare "minsky" relies on the augmented PATH). */
  minskyBin: string;
}

export interface ReleaseClaimsOutcome {
  skipped: boolean;
  reason?: string;
  /** The argv the hook spawned, for the test to pin. */
  command?: string[];
  exitCode?: number;
  timedOut?: boolean;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

/** The exact argv the hook spawns for a payload. Pure; pinned by the unit test. */
export function releaseCommandFor(
  minskyBin: string,
  input: Pick<SessionEndHookInput, "session_id" | "reason">
): string[] {
  const cmd = [minskyBin, "tasks", "release-conversation", input.session_id];
  if (input.reason && input.reason.trim().length > 0) cmd.push("--reason", input.reason.trim());
  return cmd;
}

/**
 * Core hook logic. Pure with respect to injected deps so the test drives it
 * with a fake spawner. Never throws — every failure path lands in the log and
 * the returned outcome; the entrypoint always exits 0.
 */
export function runReleaseClaimsOnSessionEnd(
  input: SessionEndHookInput,
  deps: ReleaseClaimsDeps
): ReleaseClaimsOutcome {
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
      // intentional-swallow: logging is best-effort; never let it break the hook.
    }
  };

  if (!sessionId) {
    writeRecord({ skipped: true, reason: NO_SESSION_ID_REASON });
    return { skipped: true, reason: NO_SESSION_ID_REASON };
  }

  const command = releaseCommandFor(deps.minskyBin, input);
  let result: CommandResult;
  try {
    result = deps.runCommand(command, { timeoutMs: RELEASE_CLAIMS_TIMEOUT_MS });
  } catch (err) {
    writeRecord({
      sessionId,
      reason: input.reason ?? null,
      release: { error: err instanceof Error ? err.message : String(err) },
    });
    return { skipped: false, reason: "release-threw", command };
  }

  const ok = result.exitCode === 0 && !result.timedOut;
  writeRecord({
    sessionId,
    reason: input.reason ?? null,
    release: {
      exitCode: result.exitCode,
      timedOut: result.timedOut ?? false,
      ...(ok
        ? { stdout: truncate(result.stdout, 600) }
        : { stderr: truncate(result.stderr || result.stdout, 2000) }),
    },
  });
  return { skipped: false, command, exitCode: result.exitCode, timedOut: result.timedOut ?? false };
}

// ── Real dependency wiring ──────────────────────────────────────────────────

function resolveStateDir(env: Record<string, string | undefined>): string {
  const stateDir = env.MINSKY_STATE_DIR;
  return stateDir && stateDir.trim().length > 0
    ? stateDir
    : join(homedir(), ".local", "state", "minsky");
}

function realRunCommand(cmd: string[], opts: { timeoutMs: number }): CommandResult {
  // Same PATH augmentation as the sibling SessionEnd hooks: `minsky` lives in
  // ~/.bun/bin, which the shell that launched Claude Code may not carry. No
  // Postgres connect-timeout override — the spawned CLI inherits the 10s
  // default like every other Minsky process (domain-bootstrap.ts records why
  // the old 2s cap was unreachable).
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

  if (isOverridden(env)) {
    process.stdout.write(
      `[${RELEASE_CLAIMS_HOOK_NAME}] override active via MINSKY_HOOK_OVERRIDE at ${new Date().toISOString()}\n`
    );
    return;
  }

  let input: SessionEndHookInput;
  try {
    input = await readInput<SessionEndHookInput>();
  } catch {
    return; // garbage-in → no-op
  }

  runReleaseClaimsOnSessionEnd(input, {
    runCommand: realRunCommand,
    appendLog: (logPath, line) => {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line);
    },
    resolveLogPath: () => join(resolveStateDir(env), RELEASE_CLAIMS_HOOK_LOG_FILENAME),
    now: () => new Date(),
    minskyBin: "minsky",
  });
}

// Entrypoint guard: only run main() when invoked as a script. Tests import the
// pure functions without triggering a stdin read.
if (import.meta.main) {
  await main();
}
