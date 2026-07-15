/**
 * Cockpit driven-session host (mt#2750, Rung 2A of the harness-host ladder).
 *
 * Spawns the GENUINE `claude` binary as a managed child —
 * `claude -p --input-format stream-json --output-format stream-json --verbose
 * --include-partial-messages`, cwd set to the target workspace — parses the
 * newline-delimited stream-json event stream defensively (the upstream event
 * schema is thin; see anthropics/claude-code#24594 / #24596), and exposes the
 * process through a `DrivenSessionRegistry` so the WS attach point
 * (./driven-session-ws.ts) and the Express routes (./routes/driven-sessions.ts)
 * can both observe/drive the same in-memory session set.
 *
 * Load-bearing invariant (RFC `372937f0-3cb4-8142-b3e3-c7238d3b51ba`): genuine
 * binary + user's own creds + user's own machine — NO Agent SDK anywhere on
 * this drive path. This module imports NOTHING from `@anthropic-ai/*` — see
 * the static-import assertion test in driven-session-host.test.ts.
 *
 * CRITICAL TESTING CONSTRAINT: every test in this codebase MUST inject a fake
 * `spawnFn` (see `SpawnFn`/`ProcessLike` below) rather than spawn the real
 * `claude` binary — spawning the genuine binary spends the user's Agent SDK
 * credit (real money) and runs a headless skip-permissions agent. Production
 * code (the default `spawnFn`) is the only caller of the real
 * `node:child_process.spawn`.
 *
 * Nested-scope note (SC5): the spawned `claude` child inherits the operator's
 * MCP config and MAY call back into Minsky MCP tools during its turn. The
 * cockpit daemon (this process) and the Minsky MCP server are SEPARATE OS
 * processes reached over stdio/HTTP by the child — there is no in-process
 * loop, no shared event loop, and no coupling between this host's stdout
 * parser and whatever the child's MCP tool call talks to. The child's own
 * `agentSessionId` (harness/conversation identity — see
 * docs/architecture/adr-022-session-vs-conversation-terminology.md) is
 * distinct from any Minsky WORKSPACE session the operator points `cwd` at;
 * this host never resolves or mutates a workspace session record. A
 * tool_use/tool_result pair appearing in the child's event stream is just
 * another pair of forwarded events to this host — see the "nested MCP tool
 * use doesn't deadlock" test.
 *
 * @see mt#2750 — this module
 * @see mt#2237 — parent (Rung 2), mt#2230 — umbrella
 * @see docs/architecture/adr-023-cockpit-ui-delivery-native-boundary.md — daemon-side + network transport
 * @see mt#2538 — daemon bind/auth (consumed by ./driven-session-ws.ts)
 * @see ./driven-session-ws.ts — WS upgrade attach point (auth + event fan-out)
 * @see ./routes/driven-sessions.ts — Express start/stop/list routes
 */

import { spawn as nodeSpawn } from "child_process";
import { randomUUID } from "crypto";
import { log } from "@minsky/shared/logger";

// ---------------------------------------------------------------------------
// Injectable process abstraction (mirrors mt#2749's fsMod/TailerLike pattern
// and mt#2538's overrideToken pattern) — production spawns the REAL `claude`
// binary via node:child_process.spawn; tests inject a fake ProcessLike that
// emits canned stream-json frames on stdout and captures stdin writes.
// ---------------------------------------------------------------------------

/**
 * Minimal structural surface of a spawned child process. A real
 * `child_process.ChildProcess` satisfies this; test fakes construct a small
 * EventEmitter + PassThrough-backed double instead (see
 * driven-session-host.test.ts) — neither this interface nor any production
 * code here cares which.
 */
export interface ProcessLike {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface SpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ProcessLike;

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

// ---------------------------------------------------------------------------
// Permission posture (SC6) — explicit, logged parameter; never a silent inject.
// ---------------------------------------------------------------------------

/**
 * `bypassPermissions` maps to `--dangerously-skip-permissions`, required for a
 * genuinely non-interactive `-p` session: Rung 2A ships no permission-prompt
 * UI (that's Rung 2B+), so there is nothing to answer an interactive
 * permission request with. `default` spawns the child WITHOUT that flag — a
 * tool call requiring permission is denied by the CLI in print mode (no TTY
 * to prompt against), which surfaces as an ordinary denied-tool-result event
 * on the stream, NOT a hang.
 *
 * Chosen default (see `DEFAULT_PERMISSION_MODE`): `bypassPermissions`. This is
 * a documented, logged choice — every spawn logs the mode it used (see
 * `startDrivenSession`) so the choice is always visible in daemon logs, and
 * callers may override it explicitly per session. If an org's managed policy
 * blocks `--dangerously-skip-permissions`, the child exits immediately with a
 * non-zero code and a policy-violation message on stderr; `startDrivenSession`
 * detects an exit with no prior `init` event and surfaces a readable
 * `minsky_error` event on the channel rather than leaving the caller hanging.
 */
export type PermissionMode = "bypassPermissions" | "default";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

function permissionModeArgs(mode: PermissionMode): string[] {
  return mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : [];
}

/** The genuine binary this host spawns. Never anything from `@anthropic-ai/*`. */
export const CLAUDE_BINARY = "claude";

/**
 * The documented headless invocation (mt#2750 spec Context — Claude Code
 * headless docs, code.claude.com/docs/en/headless): `-p` is required for
 * `--input-format stream-json`; `--output-format stream-json` for structured
 * output; `--verbose` for the full event stream; `--include-partial-messages`
 * for token deltas (`stream_event`).
 */
export function buildDrivenSessionArgs(permissionMode: PermissionMode): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...permissionModeArgs(permissionMode),
  ];
}

// ---------------------------------------------------------------------------
// Defensive stream-json line parsing
// ---------------------------------------------------------------------------

/**
 * Normalize a stream `"data"` chunk (Buffer or string, per Node stream
 * conventions) to a string. Deliberately avoids calling `chunk.toString("utf-8")`
 * with an explicit encoding argument — this project's root `@types/node` vs.
 * bun-types' bundled copy disagree on the `Buffer#toString` overload set (the
 * same ambient-typing ambiguity documented in ./auth.ts's token-encoding
 * comment), which either mis-narrows a `Buffer | string` union to zero-arg
 * `string.prototype.toString` or drops the `Buffer` global's static methods
 * entirely depending on which copy wins. `String(chunk)` sidesteps it:
 * for a real Node Buffer this invokes `.toString()` with no arguments, whose
 * documented default encoding is already `"utf8"`.
 */
function chunkToString(chunk: unknown): string {
  return typeof chunk === "string" ? chunk : String(chunk);
}

/** Accumulates chunked stdout data and yields complete newline-delimited lines. */
export class NewlineSplitter {
  private buffer = "";

  /** Feed a chunk; returns zero or more complete (non-empty) lines. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    return parts.filter((line) => line.length > 0);
  }
}

/**
 * Parse one stdout line as a stream-json event. Defensive per the mt#2750
 * spec (the upstream event schema is thin — anthropics/claude-code#24594 /
 * #24596): a non-JSON or non-object line becomes a `minsky_parse_error`
 * event rather than throwing, so one malformed line never kills the parser
 * loop or the session.
 */
export function parseStreamJsonLine(line: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { type: "minsky_parse_error", raw: line, error: "parsed value is not a JSON object" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { type: "minsky_parse_error", raw: line, error: message };
  }
}

/**
 * Extract the harness session id from a `system`/`init` event. Checked
 * defensively against BOTH `session_id` (the raw CLI stream's documented
 * snake_case field) and `sessionId` (camelCase) since the upstream schema is
 * thin and unconfirmed field casing is exactly the kind of gap
 * anthropics/claude-code#24594 tracks.
 */
function extractHarnessSessionId(payload: Record<string, unknown>): string | null {
  const raw = payload["session_id"] ?? payload["sessionId"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function isInitEvent(payload: Record<string, unknown>): boolean {
  return (
    payload["type"] === "system" &&
    payload["subtype"] === "init" &&
    extractHarnessSessionId(payload) !== null
  );
}

// ---------------------------------------------------------------------------
// Registry — daemon-side map of app-started driven sessions
// ---------------------------------------------------------------------------

export type DrivenSessionStatus = "spawned" | "running" | "exited" | "crashed";

/** One event observed on a driven session's channel (from the child's stdout
 * stream, or a host-generated synthetic terminal event — `minsky_error` /
 * `minsky_exit` — namespaced so they can never collide with an upstream
 * stream-json `type`). */
export interface DrivenSessionEvent {
  seq: number;
  receivedAt: string;
  payload: Record<string, unknown>;
}

/** Bounds the in-memory event log per session — generous, avoids unbounded
 * growth on a long-lived multi-turn session. */
const MAX_EVENT_LOG = 2000;

export interface DrivenSessionRecord {
  /**
   * Design decision: the spec's SC5 says the registry is "keyed by the init
   * event's session id" — but the WS route (./driven-session-ws.ts) needs an
   * addressable id SYNCHRONOUSLY at spawn time, before the child could
   * possibly have emitted its `init` event. `localId` is that spawn-time id
   * (the registry's PRIMARY key — see `DrivenSessionRegistry.get`);
   * `harnessSessionId` below is recorded as a secondary index once the `init`
   * event is observed, satisfying SC5's intent without blocking session
   * start on the child's first event.
   */
  readonly localId: string;
  readonly cwd: string;
  readonly permissionMode: PermissionMode;
  readonly argv: string[];
  readonly startedAt: string;
  /**
   * Task binding (mt#2752, Rung 2C). Opaque display/link strings recorded at
   * launch time by the caller (routes/driven-sessions.ts via
   * ../driven-session-launch.ts) — this module never resolves or mutates
   * them (the "no domain-layer session mutation" invariant in the module
   * docblock holds; these are data, not domain calls). Null for untasked
   * "scratch" sessions.
   */
  readonly taskId: string | null;
  /** The Minsky workspace sessionId the session was launched against (see taskId). */
  readonly minskySessionId: string | null;
  status: DrivenSessionStatus;
  harnessSessionId: string | null;
  pid: number | undefined;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  crashError: string | null;
  /** Set by `stopDrivenSession` — distinguishes an operator-requested
   * graceful stop from an unexpected crash when classifying the exit. */
  stopRequested: boolean;
  /** Internal — the wired child handle. Not serialized to any API response. */
  readonly proc: ProcessLike;
  /** All events observed since spawn, in order (bounded by MAX_EVENT_LOG). */
  readonly eventLog: DrivenSessionEvent[];
  /** Live WS subscribers (registered by ./driven-session-ws.ts on connect). */
  readonly subscribers: Set<(event: DrivenSessionEvent) => void>;
}

export class DrivenSessionRegistry {
  private readonly byLocalId = new Map<string, DrivenSessionRecord>();
  private readonly byHarnessId = new Map<string, DrivenSessionRecord>();

  register(record: DrivenSessionRecord): void {
    this.byLocalId.set(record.localId, record);
  }

  linkHarnessId(record: DrivenSessionRecord, harnessSessionId: string): void {
    record.harnessSessionId = harnessSessionId;
    this.byHarnessId.set(harnessSessionId, record);
  }

  /** Look up by EITHER id space — see the `localId` doc comment above. */
  get(id: string): DrivenSessionRecord | undefined {
    return this.byLocalId.get(id) ?? this.byHarnessId.get(id);
  }

  list(): DrivenSessionRecord[] {
    return [...this.byLocalId.values()];
  }

  remove(record: DrivenSessionRecord): void {
    this.byLocalId.delete(record.localId);
    if (record.harnessSessionId) this.byHarnessId.delete(record.harnessSessionId);
  }
}

/**
 * Shared production registry singleton — imported by both the Express routes
 * (./routes/driven-sessions.ts, start/stop/list) and the WS-upgrade attach
 * point (src/commands/cockpit/start-command.ts), so both sides observe the
 * same in-memory session set. Tests construct their own
 * `new DrivenSessionRegistry()` instance instead of importing this, so tests
 * never share state with each other or with a real running daemon.
 */
export const drivenSessionRegistry = new DrivenSessionRegistry();

function appendEvent(record: DrivenSessionRecord, payload: Record<string, unknown>): void {
  if (record.status === "spawned") record.status = "running";
  const event: DrivenSessionEvent = {
    seq: record.eventLog.length,
    receivedAt: new Date().toISOString(),
    payload,
  };
  record.eventLog.push(event);
  if (record.eventLog.length > MAX_EVENT_LOG) record.eventLog.shift();
  for (const subscriber of record.subscribers) {
    try {
      subscriber(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[driven-session] subscriber threw for ${record.localId}: ${message}`);
    }
  }
}

function classifyExit(
  record: DrivenSessionRecord,
  code: number | null,
  signal: NodeJS.Signals | null
): DrivenSessionStatus {
  if (record.stopRequested) return "exited";
  if (signal) return "crashed";
  return code === 0 ? "exited" : "crashed";
}

// ---------------------------------------------------------------------------
// Start / stop / input forwarding
// ---------------------------------------------------------------------------

export interface StartDrivenSessionOptions {
  /** Absolute path to the target workspace; passed as the child's cwd. */
  cwd: string;
  /** Explicit, logged permission mode (SC6). Defaults to DEFAULT_PERMISSION_MODE. */
  permissionMode?: PermissionMode;
  /** Task binding recorded on the record (mt#2752) — opaque to this module. */
  taskId?: string | null;
  /** Workspace-session binding recorded on the record (mt#2752) — opaque to this module. */
  minskySessionId?: string | null;
  /**
   * Observer invoked once, when the child's `system/init` event links the
   * harness session id (mt#2752 spawn-time identity registration). The
   * CALLER owns any domain-side effect (e.g. the `driven_spawn` link write
   * in ../driven-session-launch.ts) — keeping this module free of domain
   * imports per the docblock invariant. Errors are caught and logged; a
   * throwing observer never disturbs the event loop.
   */
  onHarnessSessionLinked?: (record: DrivenSessionRecord) => void;
  /** Override the claude binary command (test seam — points at a fake). */
  command?: string;
  /** Override the spawn function (test seam — REQUIRED for all tests, see module docblock). */
  spawnFn?: SpawnFn;
  /** Override environment variables passed to the child (test seam). */
  env?: NodeJS.ProcessEnv;
  /** Override the registry (test seam — hermetic instance per test). */
  registry?: DrivenSessionRegistry;
}

export interface StartDrivenSessionResult {
  record: DrivenSessionRecord;
}

/**
 * Spawn a driven session and wire its stdout/stderr/exit into the registry.
 * Returns synchronously (does NOT block on the child's `init` event) — the
 * caller (POST /api/driven-session) can hand the operator a session id
 * immediately; the `init` event (and everything else) is buffered into
 * `record.eventLog` and replayed to the WS channel on connect.
 */
export function startDrivenSession(opts: StartDrivenSessionOptions): StartDrivenSessionResult {
  const permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const command = opts.command ?? CLAUDE_BINARY;
  const spawnFn = opts.spawnFn ?? prodSpawnFn;
  const registry = opts.registry ?? drivenSessionRegistry;
  const argv = buildDrivenSessionArgs(permissionMode);

  log.info(
    `[driven-session] spawning ${command} ${argv.join(" ")} ` +
      `(cwd=${opts.cwd}, permissionMode=${permissionMode})`
  );

  const proc = spawnFn(command, argv, { cwd: opts.cwd, env: opts.env });

  const record: DrivenSessionRecord = {
    localId: randomUUID(),
    cwd: opts.cwd,
    permissionMode,
    argv,
    startedAt: new Date().toISOString(),
    taskId: opts.taskId ?? null,
    minskySessionId: opts.minskySessionId ?? null,
    status: "spawned",
    harnessSessionId: null,
    pid: proc.pid,
    exitCode: null,
    exitSignal: null,
    crashError: null,
    stopRequested: false,
    proc,
    eventLog: [],
    subscribers: new Set(),
  };
  registry.register(record);

  const stdoutSplitter = new NewlineSplitter();
  const stderrTail: string[] = [];

  proc.stdout.on("data", (chunk: unknown) => {
    const text = chunkToString(chunk);
    for (const line of stdoutSplitter.push(text)) {
      const payload = parseStreamJsonLine(line);
      if (isInitEvent(payload) && !record.harnessSessionId) {
        const harnessSessionId = extractHarnessSessionId(payload);
        if (harnessSessionId) {
          registry.linkHarnessId(record, harnessSessionId);
          if (opts.onHarnessSessionLinked) {
            try {
              opts.onHarnessSessionLinked(record);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log.error(
                `[driven-session] onHarnessSessionLinked observer threw for ${record.localId}: ${message}`
              );
            }
          }
        }
      }
      appendEvent(record, payload);
    }
  });

  proc.stderr.on("data", (chunk: unknown) => {
    const text = chunkToString(chunk);
    stderrTail.push(text);
    // Keep only a bounded tail for the eventual error message.
    while (stderrTail.join("").length > 4000) stderrTail.shift();
  });

  proc.on("error", (err: Error) => {
    record.status = "crashed";
    record.crashError = `Failed to start ${command}: ${err.message}`;
    log.error(`[driven-session] spawn error for ${record.localId}: ${err.message}`);
    appendEvent(record, {
      type: "minsky_error",
      message: record.crashError,
    });
  });

  proc.on("exit", (code, signal) => {
    record.exitCode = code;
    record.exitSignal = signal;
    record.status = classifyExit(record, code, signal);
    if (record.status === "crashed" && !record.crashError) {
      const tail = stderrTail.join("").slice(-2000);
      record.crashError = `${command} exited with code=${code ?? "null"} signal=${signal ?? "null"}${
        tail ? ` — stderr tail: ${tail}` : ""
      }${record.harnessSessionId ? "" : " (no init event was ever observed)"}`;
    }
    appendEvent(record, {
      type: "minsky_exit",
      code,
      signal,
      status: record.status,
      ...(record.crashError ? { error: record.crashError } : {}),
    });
  });

  return { record };
}

/**
 * Forward operator input to the child as a stream-json user message. Best
 * effort — the exact input-message shape is a documented-thin part of the
 * upstream schema (mt#2750 spec Context: "each input line is a complete JSON
 * user-message object"); this mirrors the Messages API content-block shape.
 * If the live-verification pass (main-agent, real `claude`) finds the real
 * binary expects a different shape, adjust ONLY this function.
 */
export function sendDrivenSessionInput(record: DrivenSessionRecord, text: string): boolean {
  if (record.status === "exited" || record.status === "crashed") return false;
  const line = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  });
  try {
    record.proc.stdin.write(`${line}\n`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[driven-session] failed to write input for ${record.localId}: ${message}`);
    return false;
  }
}

/**
 * Graceful stop: close stdin (the child finishes its current turn, sees EOF,
 * and exits on its own) with a SIGTERM fallback after `graceMs` if it hasn't
 * exited by then. Idempotent — a second call on an already-exited/crashed
 * record is a no-op.
 */
export function stopDrivenSession(
  record: DrivenSessionRecord,
  opts: { graceMs?: number } = {}
): void {
  if (record.status === "exited" || record.status === "crashed") return;
  record.stopRequested = true;
  try {
    record.proc.stdin.end();
  } catch {
    // Best-effort — the pipe may already be closed.
  }
  const graceMs = opts.graceMs ?? 3000;
  const timer = setTimeout(() => {
    if (record.status !== "exited" && record.status !== "crashed") {
      try {
        record.proc.kill("SIGTERM");
      } catch {
        // Best-effort.
      }
    }
  }, graceMs);
  // Bun's `setTimeout` return type doesn't structurally expose Node's
  // `Timeout#unref` in this project's ambient types (same class of ambiguity
  // as the chunkToString comment above) — mirrors the established
  // `eslint-disable` precedent in src/mcp/stdio-proxy/proxy.ts for an
  // identical "no alternative typing" cast.
  // eslint-disable-next-line custom/no-excessive-as-unknown -- Timeout#unref side-channel, no alternative typing
  (timer as unknown as { unref?: () => void }).unref?.();
}
