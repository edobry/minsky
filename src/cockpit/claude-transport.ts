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
import { CLAUDE_BINARY, buildDrivenSessionArgs, buildResumeSessionArgs } from "./claude-argv";
import { readConfiguredAnthropicApiKey } from "@minsky/domain/credentials/anthropic-api-key";
import type {
  DriverAuthMode,
  DriverTransport,
  DriverTransportEvent,
  DriverTransportResumeOptions,
  DriverTransportSpawnResult,
  DriverTransportStartOptions,
  DrivenInputImage,
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
import { redactMcpConfigForLog, resolveDrivenSessionMcpConfig } from "./driven-session-mcp-config";

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

// Argv builders (CLAUDE_BINARY, buildDrivenSessionArgs, buildResumeSessionArgs,
// permissionModeArgs) moved to ./claude-argv.ts (PR #3594 R1) to keep this
// file under the 400-line warning after gaining `stop`/`isAlive` — see the
// import above and that module's own doc comment.

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
// auth_mode: "api-key" env resolution (mt#4935)
// ---------------------------------------------------------------------------

/**
 * Resolve the env object to spawn with, honouring `authMode` (mt#4935).
 *
 * `"subscription"` (the default, and the only value before this task) is a
 * no-op — returns `baseEnv` UNCHANGED, so the operator's own Claude Code
 * login is exactly as untouched as it always was.
 *
 * `"api-key"` sets `ANTHROPIC_API_KEY` in the CHILD's env only, from the
 * configured `ai.providers.anthropic.apiKey` credential — never the parent
 * process's env, never printed, never logged. Preserves the rest of
 * `baseEnv` (or `process.env`, matching `prodSpawnFn`'s own default when
 * `baseEnv` is `undefined`) rather than replacing it outright: an env
 * object carrying ONLY `ANTHROPIC_API_KEY` would spawn a child with no
 * `PATH`, unable to find the binary that is about to run it.
 *
 * A missing credential degrades to `baseEnv` with a WARNING, never a throw —
 * matching this file's existing `resolveMcpConfigForSpawn` posture (a
 * degraded driven session is recoverable; a driven session that will not
 * spawn is not). The route-level refusal (`routes/driven-sessions.ts`) is
 * what actually stops a launch with no credential configured; this is a
 * second, independent line of defense for a caller that reaches the
 * transport directly (e.g. a resume of a persisted `api-key` row whose
 * credential was later removed).
 */
function resolveEnvForAuthMode(
  authMode: DriverAuthMode | undefined,
  baseEnv: NodeJS.ProcessEnv | undefined,
  getAnthropicApiKey: () => string | null,
  context: string
): NodeJS.ProcessEnv | undefined {
  if (authMode !== "api-key") return baseEnv;

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    log.warn(
      `[driven-session] ${context}: auth_mode "api-key" but no Anthropic API key is configured ` +
        `(ai.providers.anthropic.apiKey) — spawning without ANTHROPIC_API_KEY set`
    );
    return baseEnv;
  }

  return { ...(baseEnv ?? process.env), ANTHROPIC_API_KEY: apiKey };
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

export interface ClaudeStreamJsonTransportOptions {
  /** Override the claude binary command (test seam — points at a fake). */
  command?: string;
  /** Override the spawn function (test seam — REQUIRED for all tests, see module docblock). */
  spawnFn?: SpawnFn;
  /**
   * Override how the configured Anthropic API key is read (mt#4935, test
   * seam) — defaults to {@link readConfiguredAnthropicApiKey}. Tests inject a
   * fake so `authMode: "api-key"` behavior is exercisable without a real
   * initialized configuration provider.
   */
  getAnthropicApiKey?: () => string | null;
}

export class ClaudeStreamJsonTransport implements DriverTransport {
  readonly id = "claude-stream-json";
  private readonly command: string;
  private readonly spawnFn: SpawnFn;
  private readonly getAnthropicApiKey: () => string | null;

  constructor(opts: ClaudeStreamJsonTransportOptions = {}) {
    this.command = opts.command ?? CLAUDE_BINARY;
    this.spawnFn = opts.spawnFn ?? prodSpawnFn;
    this.getAnthropicApiKey = opts.getAnthropicApiKey ?? readConfiguredAnthropicApiKey;
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

    const env = resolveEnvForAuthMode(opts.authMode, opts.env, this.getAnthropicApiKey, "start");
    const proc = this.spawnFn(this.command, argv, { cwd: opts.cwd, env });
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

    const env = resolveEnvForAuthMode(
      opts.authMode,
      opts.env,
      this.getAnthropicApiKey,
      `resume ${opts.localId ?? opts.harnessSessionId}`
    );
    const proc = this.spawnFn(this.command, argv, { cwd: opts.cwd, env });
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

  /**
   * Moved verbatim from the pre-split `stopDrivenSession` (mt#4934 PR #3594
   * R1): close stdin (the child finishes its current turn, sees EOF, and
   * exits on its own) with a SIGTERM fallback after `graceMs` if it hasn't
   * exited by then. Both steps are best-effort (the pipe/process may already
   * be gone) — same try/catch posture as before the split.
   *
   * The ORIGINAL code additionally re-checked the record's status inside the
   * timeout callback before calling `kill()`, to skip a redundant signal to
   * an already-exited process. That check is record-level state this method
   * has no access to (only `proc`, per the interface) — dropped rather than
   * threaded through as an extra parameter, since `kill()` on an
   * already-exited process is itself a documented no-op and the call is
   * already wrapped in try/catch; no existing test asserts on the skipped
   * call (`stopDrivenSession is idempotent on an already-exited record`
   * never advances real time far enough to observe it either way).
   */
  stop(proc: ProcessLike, opts: { graceMs?: number } = {}): void {
    try {
      proc.stdin.end();
    } catch {
      // Best-effort — the pipe may already be closed.
    }
    const graceMs = opts.graceMs ?? 3000;
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Best-effort.
      }
    }, graceMs);
    // eslint-disable-next-line custom/no-excessive-as-unknown -- Timeout#unref side-channel, no alternative typing (mirrors driven-session-host.ts's prior identical cast)
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * `proc.pid` is `undefined` only for {@link createDeadProcessPlaceholder}'s
   * stub (driven-session-host.ts) — every real spawned process has one, for
   * its whole lifetime including after it exits. This is therefore "is this
   * a real process object", not "has it exited since" — see the interface
   * doc comment for the distinction from record-level liveness.
   */
  isAlive(proc: ProcessLike): boolean {
    return proc.pid !== undefined;
  }
}
