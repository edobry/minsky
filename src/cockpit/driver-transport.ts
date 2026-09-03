/**
 * `DriverTransport` — the harness-agnostic contract between the driven-session
 * supervisor (./driven-session-host.ts) and whatever process/protocol actually
 * drives a session's turns (mt#4934, ADR-047).
 *
 * Before this split, ./driven-session-host.ts fused three things: the
 * supervisor (the drive record, `driverGeneration`, restart/reconnect policy,
 * cost rows), the Claude Code driver (spawn the genuine `claude` binary,
 * build its argv, parse its stream-json event stream), and the WebSocket
 * channel. This module defines the middle piece's CONTRACT so the supervisor
 * no longer needs to know how a session driver is spawned or how its wire
 * protocol is shaped — only that it can be started (fresh or resumed), sent a
 * user turn, stopped, and observed through a normalized event stream.
 *
 * The one implementation today is `ClaudeStreamJsonTransport`
 * (./claude-transport.ts), moved out of driven-session-host.ts
 * verbatim (not rewritten) — the genuine `claude -p --input-format
 * stream-json --output-format stream-json` pipe, under the user's own
 * subscription auth (RFC `372937f0-3cb4-8142-b3e3-c7238d3b51ba`'s load-bearing
 * invariant, unchanged by this split). A second implementation (ACP,
 * mt#4936) is added later without touching the supervisor; a drive record's
 * transport selection (mt#4935) is a single hard-coded default until then —
 * see `selectDriverTransport` in ./driven-session-host.ts.
 *
 * @see mt#4934 — this split
 * @see docs/architecture/adr-047-driver-transport-interface.md
 * @see ./driven-session-host.ts — the supervisor this interface serves
 * @see ./claude-transport.ts — the first (only) implementation
 */

// ---------------------------------------------------------------------------
// Process abstraction — any transport that drives a session by spawning a CLI
// child process (today's Claude pipe, and plausibly a future ACP-speaking
// CLI) shares this shape. Mirrors mt#2749's fsMod/TailerLike pattern and
// mt#2538's overrideToken pattern: production spawns a REAL child process;
// tests inject a fake double that emits canned frames on stdout and captures
// stdin writes — see driven-session-host.test.ts's `FakeClaudeProcess`.
// ---------------------------------------------------------------------------

/**
 * Minimal structural surface of a spawned child process. A real
 * `child_process.ChildProcess` satisfies this; test fakes construct a small
 * EventEmitter + PassThrough-backed double instead — neither this interface
 * nor any transport implementation cares which.
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

// ---------------------------------------------------------------------------
// Start parameters shared by every transport
// ---------------------------------------------------------------------------

/**
 * `bypassPermissions` runs the driven session fully non-interactively (no
 * permission-prompt UI exists on this ladder rung); `default` spawns without
 * that flag, so a tool call requiring permission is denied by the CLI (no TTY
 * to prompt against) rather than hanging. See
 * `ClaudeStreamJsonTransport`'s argv builders for how this maps to CLI flags.
 */
export type PermissionMode = "bypassPermissions" | "default";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

/**
 * The credential/identity posture a transport drives under. `"subscription"`
 * (the user's own Claude Code login, no Agent SDK) is the only value any
 * transport supports today — ask#11489 (customer-facing auth policy) and
 * mt#4935/mt#4936 may extend this set later. Declared now so `start`/`resume`
 * already carry the parameter SC1 asks for, without inventing branching logic
 * nothing yet needs.
 */
export type DriverAuthMode = "subscription";

// ---------------------------------------------------------------------------
// Normalized cost/usage shape — the "turn result" every transport reports,
// independent of the wire fields it was read from.
// ---------------------------------------------------------------------------

/** Token totals shared by the top-level `usage` object and each per-model entry. */
export interface DrivenSessionUsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

/** One model's entry in a turn result's per-model usage breakdown ("model mix"). */
export interface DrivenSessionModelUsage extends DrivenSessionUsageTotals {
  costUsd: number | null;
}

/** Normalized cost/usage summary for ONE turn (mt#2753, Rung 2D). */
export interface DrivenSessionCostSummary {
  /** 0-based ordinal of this turn result within the session's lifetime. */
  turnIndex: number;
  subtype: string | null;
  isError: boolean;
  /** Cumulative estimated cost for this turn, including subagent activity —
   * a client-side estimate, not authoritative billing. */
  totalCostUsd: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  /** Tool-round count within this turn. */
  numTurns: number | null;
  /** Top-level agent-loop usage only — excludes subagent activity. */
  usage: DrivenSessionUsageTotals | null;
  /** Whole-tree per-model breakdown (includes subagent activity) — the "model mix". */
  modelUsage: Record<string, DrivenSessionModelUsage> | null;
  /** When this host observed the event (not the upstream event's own timestamp — it has none). */
  observedAt: string;
}

/**
 * One image attached to a driven-session turn (mt#3235). Base64 rather than a
 * path or URL: the transport is given the bytes inline, so nothing depends on
 * it being able to reach a file the host fetched from a third party with a
 * short-lived credential.
 */
export interface DrivenInputImage {
  base64: string;
  /** An image mime type the Messages API accepts — e.g. `image/png`. */
  mediaType: string;
}

// ---------------------------------------------------------------------------
// Normalized event stream
// ---------------------------------------------------------------------------

/**
 * One event a transport reports while a session driver is live. Every
 * line-shaped variant (everything except the three process-lifecycle kinds)
 * carries `raw` — the exact upstream payload for that event, forwarded
 * verbatim so the WebSocket protocol the SPA consumes stays byte-identical
 * regardless of which transport produced it (mt#2751's accumulation layer
 * must not notice a transport swap).
 *
 * `assistantDelta` / `toolUseStarted` / `toolUseFinished` / `permissionRequested`
 * are named here because SC1 asks the interface to cover them, and a future
 * transport (ACP) may need to distinguish them. `ClaudeStreamJsonTransport`
 * does NOT classify into these today: the current WS/persistence pipeline
 * never needed the distinction (the SPA's own accumulator classifies the raw
 * stream-json payload client-side), and inventing shape-matching heuristics
 * against a payload schema the upstream docs call "thin"
 * (anthropics/claude-code#24594/#24596) would be new, unverified behavior on
 * a task whose whole premise is "moved not rewritten." Every line that isn't
 * one of the three kinds the supervisor actually needs (`harnessSessionDiscovered`,
 * `turnResult`, and the process-lifecycle kinds below) is forwarded as `raw`.
 */
export type DriverTransportEvent =
  | { kind: "harnessSessionDiscovered"; harnessSessionId: string; raw: Record<string, unknown> }
  | { kind: "turnResult"; summary: DrivenSessionCostSummary; raw: Record<string, unknown> }
  | { kind: "assistantDelta"; raw: Record<string, unknown> }
  | { kind: "toolUseStarted"; raw: Record<string, unknown> }
  | { kind: "toolUseFinished"; raw: Record<string, unknown> }
  | { kind: "permissionRequested"; raw: Record<string, unknown> }
  | { kind: "raw"; raw: Record<string, unknown> }
  /** The session driver's OS process exited (cleanly or not) — `crashErrorBase`
   * is a fully-formatted, command/stderr-aware message the supervisor may
   * attach to the record when it classifies this exit as a crash. */
  | {
      kind: "processExited";
      code: number | null;
      signal: NodeJS.Signals | null;
      crashErrorBase: string | null;
    }
  /** The session driver's OS process failed to start (a genuine crash, not a
   * missing-cwd race — see `unrecoverable`). */
  | { kind: "processError"; crashError: string }
  /** The spawn target (a workspace directory) vanished BETWEEN the transport's
   * own preflight and the OS-level spawn — see `missingCwdReason`. Distinct
   * from `processError`: this conversation may still be resumed once the
   * workspace reappears; classified `unrecoverable`, not `crashed`, by the
   * supervisor. */
  | { kind: "unrecoverable"; reason: string };

export interface DriverTransportStartOptions {
  cwd: string;
  permissionMode: PermissionMode;
  authMode?: DriverAuthMode;
  /** The principal-selected model alias (mt#3040). Omitted → the transport's own default. */
  model?: string;
  /** `undefined` → transport resolves its own default config; `null` → no MCP config at all. */
  mcpConfig?: string | null;
  mcpServerNames?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export interface DriverTransportResumeOptions extends DriverTransportStartOptions {
  /** REQUIRED — resuming is impossible without an id to resume. */
  harnessSessionId: string;
  /** Context only, for transport-level log messages — no behavioral effect. */
  localId?: string;
  driverGeneration?: number;
}

export type DriverTransportSpawnResult =
  | { ok: true; proc: ProcessLike; argv: string[] }
  | { ok: false; reason: string };

/**
 * The contract itself. `spawn`/`spawnResume` return synchronously (matching
 * the supervisor's own non-blocking contract — see `startDrivenSession`'s doc
 * comment) without wiring the event stream; the caller builds its own record
 * around the returned `proc`/`argv` and THEN calls `attach` so the record
 * exists before any event could reach it — mirrors the pre-split
 * spawn-then-wire structure exactly (see `wireChildProcess`'s successor,
 * `attachParser`, in ./claude-transport.ts).
 */
export interface DriverTransport {
  /** Stable id for this transport (mt#4935 will select by it). */
  readonly id: string;
  /** Fresh spawn. Returns `{ ok: false, reason }` without spawning anything
   * when the target cwd does not exist. */
  spawn(opts: DriverTransportStartOptions): DriverTransportSpawnResult;
  /** Respawn to continue an existing conversation. */
  spawnResume(opts: DriverTransportResumeOptions): DriverTransportSpawnResult;
  /** Wire `proc`'s output into normalized `DriverTransportEvent`s via `onEvent`. */
  attach(proc: ProcessLike, cwd: string, onEvent: (event: DriverTransportEvent) => void): void;
  /** Send one user turn. Returns `false` for content-less input or a failed write. */
  sendUserTurn(proc: ProcessLike, text: string, images?: readonly DrivenInputImage[]): boolean;
  /**
   * Graceful stop: end the input side (so the session driver finishes its
   * current turn and exits on its own) with a forceful fallback after
   * `graceMs` if it hasn't exited by then. Idempotent at the transport level
   * (mirrors the pre-split `stopDrivenSession`'s best-effort try/catch
   * around both steps) — a caller-side terminal-status guard still belongs
   * to the supervisor (see `stopDrivenSession`), not here.
   */
  stop(proc: ProcessLike, opts?: { graceMs?: number }): void;
  /**
   * Liveness of the underlying process object — true for a real spawned
   * process, false for a placeholder with nothing behind it (e.g.
   * `createDeadProcessPlaceholder`'s stub, whose `pid` is `undefined`).
   * Distinct from record-level liveness (`hasLiveSessionDriver`, which also
   * accounts for supervisor-tracked exit/status): this is what the
   * transport itself can say about `proc` alone.
   */
  isAlive(proc: ProcessLike): boolean;
}
