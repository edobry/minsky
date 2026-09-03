/**
 * `ClaudeStreamJsonTransport` (mt#4934) — the first `DriverTransport`
 * implementation: the genuine `claude` binary, spoken to over
 * `--input-format stream-json --output-format stream-json`. Moved out of
 * driven-session-host.ts verbatim (not rewritten) — every spawn/argv/wiring
 * behavior here is byte-for-byte what the supervisor used to do inline.
 *
 * Load-bearing invariant (RFC `372937f0-3cb4-8142-b3e3-c7238d3b51ba`): genuine
 * binary + user's own creds + user's own machine — NO Agent SDK anywhere on
 * this drive path. This module imports NOTHING from `@anthropic-ai/*` — see
 * the static-import assertion test in driven-session-host.test.ts (unchanged
 * by this split; it reads driven-session-host.ts's own source, which still
 * transitively pulls in this module via `import`, so the assertion still
 * covers the real spawn path).
 *
 * CRITICAL TESTING CONSTRAINT: every test in this codebase MUST inject a fake
 * `spawnFn` (see `SpawnFn`/`ProcessLike` in ./driver-transport.ts) rather than
 * spawn the real `claude` binary — spawning the genuine binary spends the
 * user's Agent SDK credit (real money) and runs a headless skip-permissions
 * agent. `prodSpawnFn` below (the default) is the only caller of the real
 * `node:child_process.spawn`.
 *
 * @see mt#4934 — this split
 * @see ./driver-transport.ts — the interface this implements
 * @see ./claude-transport-parsing.ts — output/input wire-format interpretation
 * @see ./driven-session-host.ts — the supervisor that selects this transport
 */

import { spawn as nodeSpawn } from "child_process";
import { log } from "@minsky/shared/logger";
import { missingCwdReason, probeSpawnCwd } from "./claude-cwd-preflight";
import type {
  DriverTransport,
  DriverTransportEvent,
  DriverTransportResumeOptions,
  DriverTransportSpawnResult,
  DriverTransportStartOptions,
  DrivenInputImage,
  PermissionMode,
  ProcessLike,
  SpawnFn,
} from "./driver-transport";
import {
  buildInputContent,
  chunkToString,
  extractHarnessSessionId,
  extractResultSummary,
  isInitEvent,
  NewlineSplitter,
  parseStreamJsonLine,
} from "./claude-transport-parsing";
import {
  mcpConfigArgs,
  redactMcpConfigForLog,
  resolveDrivenSessionMcpConfig,
} from "./driven-session-mcp-config";

/**
 * Resolve the `--mcp-config` payload for a spawn, reporting what was refused.
 *
 * The resolver deliberately returns its rejections rather than logging them
 * (see its module docblock's invariant); this is the one place that turns them
 * into operator-visible output. Both the start and the resume path go through
 * here so a resume cannot silently provision a different server set than the
 * start did — the mt#3377 defect class, one level up.
 *
 * Every failure here is a WARNING, never a throw. A driven session with fewer
 * tools than intended is degraded; a driven session that will not spawn is
 * broken, and the second is much worse on a surface the principal drives from a
 * phone.
 */
function resolveMcpConfigForSpawn(
  repoPath: string,
  names: readonly string[] | undefined,
  context: string
): string {
  const resolution = resolveDrivenSessionMcpConfig(repoPath, names === undefined ? {} : { names });

  if (resolution.sourceError !== null) {
    log.warn(
      `[driven-session] ${context}: could not read the operator's MCP servers — ` +
        `provisioning only \`minsky\`. ${resolution.sourceError}`
    );
  }
  for (const { name, reason } of resolution.rejected) {
    log.warn(`[driven-session] ${context}: not provisioning MCP server \`${name}\` — ${reason}`);
  }

  return resolution.config;
}

/**
 * Production default — the ONLY place this module spawns a real process.
 * `child_process.spawn`'s return type (`ChildProcess`) is a strict structural
 * superset of `ProcessLike` (extra EventEmitter overloads, signal-typed
 * fields, etc.) that TypeScript won't narrow directly; the `as unknown` cast
 * is the same "no alternative typing for a real Node handle" case already
 * disabled at src/mcp/stdio-proxy/proxy.ts's ChildProcess side-channel cast.
 */
const prodSpawnFn: SpawnFn = (command, args, opts) =>
  // eslint-disable-next-line custom/no-excessive-as-unknown -- ChildProcess -> ProcessLike structural narrowing, no alternative typing (mirrors stdio-proxy/proxy.ts precedent)
  nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as ProcessLike;

/** The genuine binary this transport spawns. Never anything from `@anthropic-ai/*`. */
export const CLAUDE_BINARY = "claude";

function permissionModeArgs(mode: PermissionMode): string[] {
  return mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : [];
}

// ---------------------------------------------------------------------------
// Argv builders — the documented headless invocation (mt#2750 spec Context —
// Claude Code headless docs, code.claude.com/docs/en/headless).
// ---------------------------------------------------------------------------

/** `-p` is required for `--input-format stream-json`; `--output-format
 * stream-json` for structured output; `--verbose` for the full event stream;
 * `--include-partial-messages` for token deltas (`stream_event`). */
export function buildDrivenSessionArgs(
  permissionMode: PermissionMode,
  model?: string,
  mcpConfig?: string | null
): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // mt#3040: principal-selected model (a resolved dispatch alias, e.g. "fable").
    // Omitted → the genuine claude binary resolves its own default.
    ...(model ? ["--model", model] : []),
    // mt#3377: provision the minsky MCP server explicitly. Without this the
    // child resolves MCP servers against its cwd (a session workspace), which
    // carries none — see ./driven-session-mcp-config.ts.
    ...mcpConfigArgs(mcpConfig),
    ...permissionModeArgs(permissionMode),
  ];
}

/**
 * The resume-spawn invocation (mt#3038, RFC "Conversation-first drive"
 * Phase 1): identical to {@link buildDrivenSessionArgs} plus `--resume
 * <harnessSessionId>`, which resumes the CLI's own on-disk transcript for
 * that conversation id rather than starting a fresh one. This is the ONLY
 * difference between a fresh spawn and a restart-recovery respawn — the
 * durable entity is the conversation (the RFC's thesis), and the session
 * driver (child process) is disposable.
 *
 * Unchanged in behaviour by mt#4934 — the same argv, in the same order, for
 * the same inputs, as before the split (SC2).
 */
export function buildResumeSessionArgs(
  permissionMode: PermissionMode,
  harnessSessionId: string,
  model?: string | null,
  mcpConfig?: string | null
): string[] {
  return [
    "-p",
    "--resume",
    harnessSessionId,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // mt#3040 preservation: a resume must keep the ORIGINALLY-selected model
    // rather than silently falling back to the CLI's default.
    ...(model ? ["--model", model] : []),
    // mt#3377: a resumed session driver needs the same server set as a fresh spawn —
    // the conversation is durable, the process is disposable, and a resume
    // that silently dropped the MCP servers would degrade mid-conversation.
    ...mcpConfigArgs(mcpConfig),
    ...permissionModeArgs(permissionMode),
  ];
}

// ---------------------------------------------------------------------------
// Output wiring — replaces the pre-split `wireChildProcess`'s parsing half.
// The bookkeeping half (registry linking, cost history, record status,
// eventLog/subscriber fan-out) stays in the supervisor; this function only
// classifies each line/lifecycle signal into a normalized event.
// ---------------------------------------------------------------------------

function attachParser(
  proc: ProcessLike,
  command: string,
  cwd: string,
  onEvent: (event: DriverTransportEvent) => void
): void {
  const stdoutSplitter = new NewlineSplitter();
  const stderrTail: string[] = [];
  let turnIndex = 0;

  proc.stdout.on("data", (chunk: unknown) => {
    const text = chunkToString(chunk);
    for (const line of stdoutSplitter.push(text)) {
      const payload = parseStreamJsonLine(line);

      if (isInitEvent(payload)) {
        const harnessSessionId = extractHarnessSessionId(payload);
        if (harnessSessionId) {
          onEvent({ kind: "harnessSessionDiscovered", harnessSessionId, raw: payload });
          continue;
        }
      }

      if (payload["type"] === "result") {
        const summary = extractResultSummary(payload, turnIndex);
        if (summary) {
          turnIndex += 1;
          onEvent({ kind: "turnResult", summary, raw: payload });
          continue;
        }
      }

      onEvent({ kind: "raw", raw: payload });
    }
  });

  proc.stderr.on("data", (chunk: unknown) => {
    const text = chunkToString(chunk);
    stderrTail.push(text);
    // Keep only a bounded tail for the eventual error message.
    while (stderrTail.join("").length > 4000) stderrTail.shift();
  });

  proc.on("error", (err: Error) => {
    // mt#3397 — an ENOENT here is ambiguous by Node's own design: it means
    // EITHER the binary is not on PATH OR the cwd does not exist, and its
    // message names the binary in both cases. `spawn`/`spawnResume`'s own
    // preflight catches the ordinary missing-cwd case before we ever get
    // here, so reaching this branch with a missing cwd means the directory
    // vanished BETWEEN the preflight and the spawn — rare, but real, and
    // still unrecoverable rather than crashed.
    const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isEnoent && probeSpawnCwd(cwd) === "missing") {
      onEvent({ kind: "unrecoverable", reason: missingCwdReason(cwd) });
      return;
    }
    const crashError = isEnoent
      ? `Failed to start ${command}: not found — is '${command}' on this process's PATH? (${err.message})`
      : `Failed to start ${command}: ${err.message}`;
    onEvent({ kind: "processError", crashError });
  });

  proc.on("exit", (code, signal) => {
    const tail = stderrTail.join("").slice(-2000);
    const crashErrorBase = `${command} exited with code=${code ?? "null"} signal=${signal ?? "null"}${
      tail ? ` — stderr tail: ${tail}` : ""
    }`;
    onEvent({ kind: "processExited", code, signal, crashErrorBase });
  });
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

export interface ClaudeStreamJsonTransportOptions {
  /** Override the claude binary command (test seam — points at a fake). */
  command?: string;
  /** Override the spawn function (test seam — REQUIRED for all tests, see module docblock). */
  spawnFn?: SpawnFn;
}

export class ClaudeStreamJsonTransport implements DriverTransport {
  readonly id = "claude-stream-json";
  private readonly command: string;
  private readonly spawnFn: SpawnFn;

  constructor(opts: ClaudeStreamJsonTransportOptions = {}) {
    this.command = opts.command ?? CLAUDE_BINARY;
    this.spawnFn = opts.spawnFn ?? prodSpawnFn;
  }

  spawn(opts: DriverTransportStartOptions): DriverTransportSpawnResult {
    // mt#3397 — cwd preflight. Spawning into a directory that does not exist
    // fails with an ENOENT that NAMES THE BINARY (see probeSpawnCwd), so
    // without this check the operator reads "Failed to start claude" and goes
    // looking at their PATH.
    if (probeSpawnCwd(opts.cwd) === "missing") {
      const reason = missingCwdReason(opts.cwd);
      log.error(`[driven-session] not spawning ${this.command} — ${reason}`);
      return { ok: false, reason };
    }

    // mt#3377: `undefined` means "production default"; an explicit `null`
    // means "no MCP config" — so the two are deliberately NOT collapsed with `??`.
    const mcpConfig =
      opts.mcpConfig === undefined
        ? resolveMcpConfigForSpawn(opts.cwd, opts.mcpServerNames, "start")
        : opts.mcpConfig;
    const argv = buildDrivenSessionArgs(opts.permissionMode, opts.model, mcpConfig);

    log.info(
      `[driven-session] spawning ${this.command} ${redactMcpConfigForLog(argv)} ` +
        `(cwd=${opts.cwd}, permissionMode=${opts.permissionMode})`
    );

    const proc = this.spawnFn(this.command, argv, { cwd: opts.cwd, env: opts.env });
    return { ok: true, proc, argv };
  }

  spawnResume(opts: DriverTransportResumeOptions): DriverTransportSpawnResult {
    // mt#3397 — same cwd preflight as `spawn`, and the path the originating
    // incident actually took: a workspace deleted out from under a live
    // conversation left every resume attempt crashing with an ENOENT that
    // named `claude`.
    if (probeSpawnCwd(opts.cwd) === "missing") {
      const reason = missingCwdReason(opts.cwd);
      log.error(
        `[driven-session] not resuming ${opts.localId ?? opts.harnessSessionId} — ${reason}`
      );
      return { ok: false, reason };
    }

    // mt#3377: same undefined-vs-null contract as `spawn` — a resume must
    // re-provision the servers, or the conversation would silently lose its
    // whole MCP tool surface at the first daemon restart.
    const mcpConfig =
      opts.mcpConfig === undefined
        ? resolveMcpConfigForSpawn(
            opts.cwd,
            opts.mcpServerNames,
            `resume ${opts.localId ?? opts.harnessSessionId}`
          )
        : opts.mcpConfig;
    const argv = buildResumeSessionArgs(
      opts.permissionMode,
      opts.harnessSessionId,
      opts.model,
      mcpConfig
    );

    log.info(
      `[driven-session] resuming ${this.command} ${redactMcpConfigForLog(argv)} ` +
        `(localId=${opts.localId ?? "unknown"}, harnessSessionId=${opts.harnessSessionId}, ` +
        `generation=${(opts.driverGeneration ?? 0) + 1}, cwd=${opts.cwd})`
    );

    const proc = this.spawnFn(this.command, argv, { cwd: opts.cwd, env: opts.env });
    return { ok: true, proc, argv };
  }

  attach(proc: ProcessLike, cwd: string, onEvent: (event: DriverTransportEvent) => void): void {
    attachParser(proc, this.command, cwd, onEvent);
  }

  sendUserTurn(proc: ProcessLike, text: string, images: readonly DrivenInputImage[] = []): boolean {
    const content = buildInputContent(text, images);
    if (content.length === 0) return false;
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content,
      },
    });
    try {
      proc.stdin.write(`${line}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[driven-session] failed to write input: ${message}`);
      return false;
    }
    return true;
  }
}

/**
 * Shared singleton for callers that don't need per-call `command`/`spawnFn`
 * overrides — used by `sendDrivenSessionInput` in ./driven-session-host.ts,
 * where sending a turn to an already-live process needs no spawn-time
 * configuration at all.
 */
export const claudeStreamJsonTransport = new ClaudeStreamJsonTransport();
