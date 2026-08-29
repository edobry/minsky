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
import { statSync } from "fs";
import { stat } from "fs/promises";
import { PassThrough } from "stream";
import { log } from "@minsky/shared/logger";
import { INTERRUPTION_NOTICE_TEXT } from "@minsky/shared/minsky-notices";
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

// ---------------------------------------------------------------------------
// Spawn-cwd preflight (mt#3397)
// ---------------------------------------------------------------------------

/**
 * Verdict of {@link probeSpawnCwd}. Deliberately THREE-valued: `"unknown"` is
 * not merged into `"missing"`, because the two carry opposite consequences —
 * `"missing"` retires a conversation permanently, `"unknown"` must not.
 */
export type CwdProbeResult = "present" | "missing" | "unknown";

/**
 * Check whether a spawn cwd is a directory that exists.
 *
 * Why this exists: Node reports a missing `options.cwd` as an `ENOENT` naming
 * the COMMAND — `ENOENT: no such file or directory, posix_spawn 'claude'` —
 * indistinguishable from the binary being absent from PATH. Node documents this
 * ("If given, but the path does not exist, the child process emits an ENOENT
 * error and exits immediately. ENOENT is also emitted when the command does not
 * exist") and deliberately declined to pre-validate the cwd itself
 * (nodejs/node#11520 → doc-only PR nodejs/node#34505), leaving the check to the
 * caller. This is that caller-side check.
 *
 * `"unknown"` (a permission error, an I/O error, an unresponsive network mount)
 * fails OPEN — the caller spawns anyway and lets the real error surface. Only a
 * definitive ENOENT/ENOTDIR, or a path that exists but is not a directory,
 * returns `"missing"`, because `"missing"` is what marks a conversation
 * unrecoverable FOREVER. A transiently unreadable workspace must never retire a
 * conversation the principal may still want.
 */
export function probeSpawnCwd(cwd: string): CwdProbeResult {
  try {
    return classifyCwdStat(statSync(cwd).isDirectory());
  } catch (err) {
    return classifyCwdProbeError(err, cwd);
  }
}

/**
 * Async twin of {@link probeSpawnCwd}, for callers that are already async.
 *
 * PR #2452 R1 (BLOCKING): boot reconciliation probes every non-terminal row, so
 * a synchronous `statSync` there can stall the daemon's event loop for as long
 * as the slowest path takes to answer — unbounded on an unresponsive network
 * mount. The two spawn paths keep the sync probe deliberately: they are
 * synchronous by contract (`startDrivenSession` hands the caller a session id
 * without awaiting the child) and they are about to block on `spawn` anyway, so
 * making them async would ripple through four call sites to remove a stat that
 * immediately precedes a process launch. The loops get this one instead.
 */
export async function probeSpawnCwdAsync(cwd: string): Promise<CwdProbeResult> {
  try {
    const stats = await stat(cwd);
    return classifyCwdStat(stats.isDirectory());
  } catch (err) {
    return classifyCwdProbeError(err, cwd);
  }
}

function classifyCwdStat(isDirectory: boolean): CwdProbeResult {
  return isDirectory ? "present" : "missing";
}

/**
 * Shared error classification for both probes.
 *
 * The `"unknown"` branch logs at WARN (PR #2452 R1): failing open is the right
 * behavior, but doing it silently means an operator seeing a session stuck in
 * `reconnecting` has no way to find out that the probe could not read the
 * workspace. The errno is the diagnostic — EACCES reads very differently from
 * EIO or a hung mount's ETIMEDOUT.
 */
function classifyCwdProbeError(err: unknown, cwd: string): CwdProbeResult {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  log.warn(
    `[driven-session] could not determine whether ${cwd} exists (${code ?? "no errno"}) — ` +
      `treating it as possibly-present so the conversation is not retired on a transient fault`
  );
  return "unknown";
}

/**
 * The `unrecoverableReason` for a session whose workspace is gone.
 *
 * Deliberately says the WORKSPACE is gone, not that the work is: a driven
 * session's conversation lives in the harness's own on-disk transcript, which
 * survives both the session driver's death and the workspace's deletion (memory
 * mem#669 — "the process died" is NOT "the work is gone"). What is lost is the
 * ability to RESUME in place: `claude --resume` needs the original cwd, both to
 * run in and because the harness keys its transcript directory off that path.
 */
export function missingCwdReason(cwd: string): string {
  return (
    `deleted cwd — the workspace directory ${cwd} no longer exists, so this conversation ` +
    `cannot be resumed in place (its transcript is unaffected)`
  );
}

/**
 * The documented headless invocation (mt#2750 spec Context — Claude Code
 * headless docs, code.claude.com/docs/en/headless): `-p` is required for
 * `--input-format stream-json`; `--output-format stream-json` for structured
 * output; `--verbose` for the full event stream; `--include-partial-messages`
 * for token deltas (`stream_event`).
 */
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
 * durable entity is the conversation (the RFC's thesis), and the session driver
 * (child process) is disposable.
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
// Cost/usage extraction from the terminal `result` event (mt#2753, Rung 2D).
//
// Per the Claude Code headless docs (code.claude.com/docs/en/headless) and
// the Agent SDK cost-tracking guide (code.claude.com/docs/en/agent-sdk/cost-tracking),
// the terminal `result` message of EACH turn (a driven session is multi-turn —
// `--input-format stream-json` reads a continuous stream of user messages over
// stdin, so a long-lived session emits one `result` event per turn, not just
// one at process exit) carries:
//   - `total_cost_usd` (top-level, includes subagent activity)
//   - `duration_ms` / `duration_api_ms`
//   - `num_turns` (tool-round count for that turn — NOT the session's turn
//     index, which this module tracks separately as `DrivenSessionCostSummary.turnIndex`)
//   - `usage` — `{ input_tokens, output_tokens, cache_creation_input_tokens,
//     cache_read_input_tokens }` (top-level agent loop only — undercounts
//     under subagent nesting; see `total_cost_usd`/`modelUsage` for whole-tree)
//   - `modelUsage` — map of model name to `{ inputTokens, outputTokens,
//     cacheReadInputTokens, cacheCreationInputTokens, costUSD }` (whole-tree,
//     the "model mix" the mt#2753 spec asks for)
// Extraction is defensive (same posture as parseStreamJsonLine/extractHarnessSessionId
// above) — the upstream event schema is thin (anthropics/claude-code#24594/#24596)
// and `total_cost_usd`/`costUSD` are documented as CLIENT-SIDE ESTIMATES, not
// authoritative billing data.
// ---------------------------------------------------------------------------

/** Token totals shared by the top-level `usage` object and each per-model entry. */
export interface DrivenSessionUsageTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

/** One model's entry in the `result` event's `modelUsage` map — the "model mix". */
export interface DrivenSessionModelUsage extends DrivenSessionUsageTotals {
  costUsd: number | null;
}

/** Extracted cost/usage summary for ONE turn's terminal `result` event. */
export interface DrivenSessionCostSummary {
  /** 0-based ordinal of this `result` event within the session's lifetime
   * (a driven session may emit several across a multi-turn conversation). */
  turnIndex: number;
  subtype: string | null;
  isError: boolean;
  /** Cumulative estimated cost for this turn's `query()`-equivalent, including
   * subagent activity — a client-side estimate, not authoritative billing. */
  totalCostUsd: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  /** The CLI's own `num_turns` (tool-round count within this turn). */
  numTurns: number | null;
  /** Top-level agent-loop usage only — excludes subagent activity. */
  usage: DrivenSessionUsageTotals | null;
  /** Whole-tree per-model breakdown (includes subagent activity) — the "model mix". */
  modelUsage: Record<string, DrivenSessionModelUsage> | null;
  /** When this host observed the event (not the upstream event's own timestamp — it has none). */
  observedAt: string;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractUsageTotals(raw: unknown): DrivenSessionUsageTotals | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: numOrNull(u["input_tokens"]),
    outputTokens: numOrNull(u["output_tokens"]),
    cacheCreationInputTokens: numOrNull(u["cache_creation_input_tokens"]),
    cacheReadInputTokens: numOrNull(u["cache_read_input_tokens"]),
  };
}

function extractModelUsage(raw: unknown): Record<string, DrivenSessionModelUsage> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, DrivenSessionModelUsage> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    out[model] = {
      inputTokens: numOrNull(v["inputTokens"]),
      outputTokens: numOrNull(v["outputTokens"]),
      cacheCreationInputTokens: numOrNull(v["cacheCreationInputTokens"]),
      cacheReadInputTokens: numOrNull(v["cacheReadInputTokens"]),
      // costUSD is the documented TS SDK field name; costUsd tolerated defensively.
      costUsd: numOrNull(v["costUSD"] ?? v["costUsd"]),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Parse ONE `result`-type stream-json event into a cost summary. Returns
 * `null` for a non-`result` payload (callers gate on `payload["type"] ===
 * "result"` before calling this, but the guard is repeated here so the
 * function is safe to call unconditionally).
 */
export function extractResultSummary(
  payload: Record<string, unknown>,
  turnIndex: number
): DrivenSessionCostSummary | null {
  if (payload["type"] !== "result") return null;
  return {
    turnIndex,
    subtype: typeof payload["subtype"] === "string" ? payload["subtype"] : null,
    isError: payload["is_error"] === true || payload["subtype"] === "error",
    totalCostUsd: numOrNull(payload["total_cost_usd"]),
    durationMs: numOrNull(payload["duration_ms"]),
    durationApiMs: numOrNull(payload["duration_api_ms"]),
    numTurns: numOrNull(payload["num_turns"]),
    usage: extractUsageTotals(payload["usage"]),
    modelUsage: extractModelUsage(payload["modelUsage"]),
    observedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Registry — daemon-side map of app-started driven sessions
// ---------------------------------------------------------------------------

/**
 * mt#3038 (RFC "Conversation-first drive" Phase 1) adds two persisted-only
 * states beyond the original spawn/exit lifecycle:
 *   - `"reconnecting"` — loaded at daemon boot from a persisted non-terminal
 *     record (R1 delta #6: lazy-resume-only — this state alone never
 *     triggers a respawn; a respawn only happens on operator action or
 *     client reconnect).
 *   - `"unrecoverable"` — the fourth TERMINAL state (R1 delta #2): a
 *     persisted record that can never be resumed (deleted cwd,
 *     spawn-died-before-init — `harnessSessionId` never linked, so there is
 *     no transcript to resume — or a policy-blocked respawn). Distinct from
 *     `"crashed"` (which MAY still be resumable via `--resume` once a
 *     harness session id exists): the UI renders `unrecoverable` read-only
 *     with `unrecoverableReason`, never the crash card.
 */
export type DrivenSessionStatus =
  | "spawned"
  | "running"
  | "exited"
  | "crashed"
  | "reconnecting"
  | "unrecoverable";

/** One event observed on a driven session's channel (from the child's stdout
 * stream, or a host-generated synthetic terminal event — `minsky_error` /
 * `minsky_exit` — namespaced so they can never collide with an upstream
 * stream-json `type`). */
export interface DrivenSessionEvent {
  seq: number;
  receivedAt: string;
  payload: Record<string, unknown>;
}

/**
 * A live subscriber to a `DrivenSessionRecord` (registered by
 * ./driven-session-ws.ts on WS connect). Two callbacks, not one function
 * (mt#3038 R1 delta #3 — "record replacement, not mutation"): a session driver
 * swap (`DrivenSessionRegistry.replace`) constructs a NEW record for the
 * SAME `localId` rather than mutating the old one in place, so an existing
 * socket subscribed to the OLD record must be told to close and have its
 * client redial — it can never be silently re-pointed at the new record's
 * event stream (never hot-swap a live socket).
 */
export interface DrivenSessionSubscriber {
  /** A new event was appended to the record this subscriber is attached to. */
  onEvent: (event: DrivenSessionEvent) => void;
  /**
   * This record was just REPLACED by a session driver swap (a resume-respawn).
   * Called at most once per subscriber. The subscriber (a WS connection)
   * MUST close its socket with a reconnect-signaling code/reason so the
   * client redials the SAME `localId` — the registry will resolve the new
   * record on the next connect.
   */
  onSwap: () => void;
}

/** Bounds the in-memory event log per session — generous, avoids unbounded
 * growth on a long-lived multi-turn session. */
const MAX_EVENT_LOG = 2000;

/**
 * Synthetic frame type for an operator turn sent through the composer
 * (mt#3372). Minsky-namespaced like the other host-synthesized frames
 * (`minsky_exit` / `minsky_error` / `minsky_unrecoverable`) so it can never
 * collide with an upstream stream-json type.
 *
 * The frontend reducer matches this literal in
 * `web/lib/driven-session-accumulator.ts` rather than importing it: that module
 * is deliberately dependency-free so it bundles into the browser, and this one
 * pulls in node child-process machinery. Same hand-kept-in-sync arrangement the
 * existing `minsky_*` frame types already use.
 */
export const DRIVEN_OPERATOR_INPUT_EVENT_TYPE = "minsky_operator_input";

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
  /**
   * Project attribution (mt#4732), resolved by the CALLER at launch time from
   * the bound workspace's own `SessionRecord.projectId` when `minskySessionId`
   * is known and resolvable — this module never resolves it itself (the
   * "no domain-layer lookups" invariant this file's docblock states holds;
   * see ../driven-session-launch.ts's `resolveTaskWorkspace`). `null` for
   * every launch shape with no bound workspace (scratch sessions, explicit
   * `cwd` launches, the ambient principal-conversation driver, entity
   * threads) and for a session rehydrated from the `driven_sessions` table
   * after a daemon restart — `driven_sessions` does not persist this column,
   * so a rehydrated/attached record's project is unknown by construction,
   * not merely unresolved (same "not tracked" posture as `model` below).
   */
  readonly projectId: string | null;
  status: DrivenSessionStatus;
  /** Set only when `status === "unrecoverable"` (mt#3038 R1 delta #2). */
  unrecoverableReason: string | null;
  harnessSessionId: string | null;
  pid: number | undefined;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  crashError: string | null;
  /** Set by `stopDrivenSession` — distinguishes an operator-requested
   * graceful stop from an unexpected crash when classifying the exit. */
  stopRequested: boolean;
  /**
   * Session driver-swap generation (mt#3038 R1 delta #3/#7) — 0 for the original
   * spawn, incremented once per resume-respawn (`resumeDrivenSession`).
   * Persisted so cost continuity can attribute rows to a generation without
   * resetting/double-counting across a respawn.
   */
  readonly driverGeneration: number;
  /** Internal — the wired child handle. Not serialized to any API response. */
  readonly proc: ProcessLike;
  /** All events observed since spawn, in order (bounded by MAX_EVENT_LOG). */
  readonly eventLog: DrivenSessionEvent[];
  /**
   * Cost/usage summaries extracted from each terminal `result` event observed
   * so far (mt#2753, Rung 2D) — one entry per turn. Unbounded (a driven
   * session's turn count is orders of magnitude smaller than its raw event
   * count, so MAX_EVENT_LOG-style bounding is unnecessary here).
   */
  readonly costHistory: DrivenSessionCostSummary[];
  /** Live WS subscribers (registered by ./driven-session-ws.ts on connect). */
  readonly subscribers: Set<DrivenSessionSubscriber>;
  /**
   * True when this record's `eventLog` can never contain the conversation's
   * PRIOR history, so a connecting client must be sent the on-disk transcript
   * instead (mt#3453).
   *
   * Set for every record built by {@link resumeDrivenSession} — which covers
   * both origins that need it: a conversation ATTACHED from disk (mt#3095,
   * never observed in this process) and one REHYDRATED after a daemon restart
   * (mt#3038, whose log died with the previous process). A fresh
   * {@link startDrivenSession} spawn leaves it false: it starts the
   * conversation, so there is no prior history to replay.
   *
   * This is a property of the record's ORIGIN, deliberately not a check on
   * `eventLog.length`. The first implementation gated replay on an empty log
   * and live-verification found it silently never fired: the session driver starts
   * emitting frames immediately, so by the time any client connects the log is
   * already non-empty and the "needs history" condition has evaporated. Origin
   * does not change with timing.
   *
   * NOT cleared after a replay — every connecting client needs the history, not
   * just the first.
   */
  readonly needsHistoryReplay: boolean;
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

  /**
   * Session driver swap (mt#3038 R1 delta #3): replace whatever record is
   * currently registered under `localId` with `newRecord` — NEVER mutate the
   * old record in place. Every existing subscriber of the OLD record is told
   * to swap (see `DrivenSessionSubscriber.onSwap`) before the new record
   * takes over the `localId` slot, so a live WS connection always closes and
   * forces its client to redial rather than silently observing a spliced
   * event stream.
   */
  replace(localId: string, newRecord: DrivenSessionRecord): void {
    const old = this.byLocalId.get(localId);
    if (old) {
      for (const subscriber of old.subscribers) {
        try {
          subscriber.onSwap();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`[driven-session] subscriber onSwap threw for ${localId}: ${message}`);
        }
      }
      if (old.harnessSessionId) this.byHarnessId.delete(old.harnessSessionId);
    }
    this.byLocalId.set(localId, newRecord);
    if (newRecord.harnessSessionId) this.byHarnessId.set(newRecord.harnessSessionId, newRecord);
  }

  /**
   * Install `record` under its own `localId`, choosing between the two
   * semantics above (mt#3550, PR #2601 R1).
   *
   * The choice lives HERE rather than at each spawn site so a future caller
   * cannot half-remember it: spawning over a slot that already holds a record
   * must go through `replace`, and `register` is only correct for an empty
   * one. Keeping the routing in the registry is what stops the two from
   * drifting apart at call sites that never think about swaps.
   */
  install(record: DrivenSessionRecord, opts: { replacePrevious?: boolean } = {}): void {
    if (opts.replacePrevious) this.replace(record.localId, record);
    else this.register(record);
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
      subscriber.onEvent(event);
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

/** Statuses where the record's session driver is definitely gone — no live stdin to write to,
 * no live process to stop (mt#3038: `unrecoverable` joins the original exited/crashed pair). */
export function isTerminalStatus(status: DrivenSessionStatus): boolean {
  return status === "exited" || status === "crashed" || status === "unrecoverable";
}

/**
 * True when `record` has a REAL child process behind it — the precondition for
 * any write that claims delivery.
 *
 * Broader than `!isTerminalStatus`: a `"reconnecting"` record is non-terminal
 * but its `proc` is {@link createDeadProcessPlaceholder}'s stub, whose stdin is
 * an inert `PassThrough` that never receives real data (mt#3038 R1 delta #6 —
 * lazy-resume-only, nothing is spawned until an attach). A write there
 * succeeds at the stream level and goes nowhere.
 */
export function hasLiveSessionDriver(record: DrivenSessionRecord): boolean {
  return !isTerminalStatus(record.status) && record.status !== "reconnecting";
}

/**
 * True when `record` has an actively in-flight turn (mt#3048, RFC
 * "Conversation-first drive" Phase 1 slice 6) — its latest observed event is
 * not yet a terminal `result`/`minsky_exit` event. This is the daemon-side
 * signal the cockpit-tray watcher's pre-restart gate
 * (cockpit-tray/src-tauri/src/watcher_backend.rs) queries before triggering a
 * hot-reload daemon restart, so it can defer (a bounded grace period, never
 * indefinitely) rather than interrupt a turn that is actively streaming.
 *
 * A record with no LIVE session driver is never mid-turn, regardless of its
 * (possibly stale) `eventLog` tail:
 *   - any terminal status (`isTerminalStatus`) — the process is already gone;
 *   - `"reconnecting"` — the session driver already died and is deliberately NOT
 *     respawned eagerly (mt#3038 R1 delta #6, lazy-resume-only); there is no
 *     live turn to interrupt, that is exactly the case the mt#3038 resume
 *     machinery exists to recover, not a reason to defer a restart.
 *
 * A freshly-spawned record with NO events yet (before the child's first
 * stream-json line, e.g. its `system`/`init` event) counts as mid-turn: its
 * first turn is already in flight and has not reached a terminal event.
 */
export function isDrivenSessionMidTurn(record: DrivenSessionRecord): boolean {
  if (isTerminalStatus(record.status) || record.status === "reconnecting") return false;
  const last = record.eventLog[record.eventLog.length - 1];
  if (!last) return true;
  const type = last.payload["type"];
  return type !== "result" && type !== "minsky_exit";
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
   * Project attribution recorded on the record (mt#4732) — opaque to this
   * module, resolved by the caller (see `DrivenSessionRecord.projectId`'s
   * doc comment). Omitted/`null` when the launch has no bound workspace.
   */
  projectId?: string | null;
  /**
   * The `--model` argument for the spawned binary (a resolved dispatch alias,
   * e.g. "fable"; mt#3040). When set, appended to the spawn argv so the genuine
   * `claude` binary runs on the principal-selected model. Omitted → the CLI's
   * own default resolution (pre-mt#3040 behavior).
   */
  model?: string;
  /**
   * Observer invoked once, when the child's `system/init` event links the
   * harness session id (mt#2752 spawn-time identity registration). The
   * CALLER owns any domain-side effect (e.g. the `driven_spawn` link write
   * in ../driven-session-launch.ts) — keeping this module free of domain
   * imports per the docblock invariant. Errors are caught and logged; a
   * throwing observer never disturbs the event loop.
   */
  onHarnessSessionLinked?: (record: DrivenSessionRecord) => void;
  /**
   * Observer invoked once per turn, when the terminal `result` event yields a
   * cost/usage summary (mt#2753 — persistence is the CALLER's responsibility,
   * matching `onHarnessSessionLinked`'s domain-import-free convention above).
   * Errors are caught and logged; a throwing observer never disturbs the
   * event loop.
   */
  onResultSummary?: (record: DrivenSessionRecord, summary: DrivenSessionCostSummary) => void;
  /**
   * Observer invoked on every meaningful lifecycle transition — initial
   * registration, harness-session-link, and terminal exit/crash/error
   * (mt#3038: the "make the in-memory Map a rehydratable record" step). The
   * CALLER owns persistence (see ../driven-session-launch.ts's
   * `createDrivenSessionPersistObserver`), mirroring the domain-import-free
   * convention of `onHarnessSessionLinked`/`onResultSummary` above. Errors
   * are caught and logged; a throwing observer never disturbs the event loop
   * or the running session.
   */
  onStateChange?: (record: DrivenSessionRecord) => void;
  /** Override the claude binary command (test seam — points at a fake). */
  command?: string;
  /** Override the spawn function (test seam — REQUIRED for all tests, see module docblock). */
  spawnFn?: SpawnFn;
  /** Override environment variables passed to the child (test seam). */
  env?: NodeJS.ProcessEnv;
  /** Override the registry (test seam — hermetic instance per test). */
  registry?: DrivenSessionRegistry;
  /**
   * The `--mcp-config` payload for the child (mt#3377). Omitted → synthesized
   * from `cwd` by `buildDrivenSessionMcpConfig`, which is what production
   * wants. Pass `null` to spawn with NO MCP config at all (the pre-mt#3377
   * behavior); pass a string to override the server set. Tests pass `null` so
   * argv assertions stay independent of the host machine's binary path.
   */
  mcpConfig?: string | null;
  /**
   * Which MCP servers to provision, by name (mt#4239). Omitted → the
   * `DEFAULT_DRIVEN_SESSION_MCP_SERVERS` set.
   *
   * Ignored when `mcpConfig` is given: an explicit payload already IS the
   * answer, so honoring both would be two sources of truth for one question.
   * The cockpit layer reads `cockpit.drivenSession.mcpServers` from
   * configuration and passes it here — this module cannot, per its
   * no-domain-imports invariant.
   */
  mcpServerNames?: readonly string[];
  /**
   * Use THIS id instead of generating one (mt#3243).
   *
   * `localId` is the persisted row's primary key and the registry's handle, so
   * a caller that must find the same conversation again after its own memory is
   * gone — the principal channel, across a daemon restart — supplies a stable
   * one. The store upserts on this key, so the conversation occupies exactly
   * one row for its whole life rather than a new row per spawn.
   *
   * Callers with nothing to re-find omit it and get a fresh UUID.
   */
  localId?: string;
  /**
   * Install the new record with {@link DrivenSessionRegistry.replace} instead
   * of `register` (mt#3550).
   *
   * `register` is a bare `byLocalId.set`: spawning a fresh session driver for a
   * `localId` that ALREADY holds a record would drop the old one out of the
   * map without telling its subscribers, which is exactly what mt#3038 R1
   * delta #3 forbids — a live socket would keep observing a record nothing
   * writes to any more. A caller that knowingly spawns over a dead record for
   * a stable `localId` (the entity-thread re-spawn) sets this so the old
   * record's subscribers get `onSwap` and redial.
   *
   * Off by default: for the ordinary spawn the slot is empty, and `replace`
   * would only add a lookup.
   */
  replacePrevious?: boolean;
}

export interface StartDrivenSessionResult {
  record: DrivenSessionRecord;
}

/** Invoke `onStateChange` defensively — never let a throwing observer disturb the caller. */
function notifyStateChange(
  record: DrivenSessionRecord,
  onStateChange: ((record: DrivenSessionRecord) => void) | undefined
): void {
  if (!onStateChange) return;
  try {
    onStateChange(record);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[driven-session] onStateChange observer threw for ${record.localId}: ${message}`);
  }
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
  // mt#3377: `undefined` means "production default"; an explicit `null` means
  // "no MCP config" — so the two are deliberately NOT collapsed with `??`.
  const mcpConfig =
    opts.mcpConfig === undefined
      ? resolveMcpConfigForSpawn(opts.cwd, opts.mcpServerNames, "start")
      : opts.mcpConfig;
  const argv = buildDrivenSessionArgs(permissionMode, opts.model, mcpConfig);
  const installOpts = { replacePrevious: opts.replacePrevious ?? false };

  // mt#3397 — cwd preflight. Spawning into a directory that does not exist
  // fails with an ENOENT that NAMES THE BINARY (see probeSpawnCwd), so without
  // this check the operator reads "Failed to start claude" and goes looking at
  // their PATH. Terminal-and-registered rather than thrown: the caller
  // (POST /api/driven-session, the WS resume path) still gets a record back,
  // and the state-change observer persists the verdict like any other.
  if (probeSpawnCwd(opts.cwd) === "missing") {
    const reason = missingCwdReason(opts.cwd);
    log.error(`[driven-session] not spawning ${command} — ${reason}`);
    const record = buildReconnectingDrivenSessionRecord({
      localId: opts.localId ?? randomUUID(),
      harnessSessionId: null,
      cwd: opts.cwd,
      permissionMode,
      taskId: opts.taskId ?? null,
      minskySessionId: opts.minskySessionId ?? null,
      projectId: opts.projectId ?? null,
      status: "unrecoverable",
      unrecoverableReason: reason,
      driverGeneration: 0,
      startedAt: new Date().toISOString(),
    });
    registry.install(record, installOpts);
    notifyStateChange(record, opts.onStateChange);
    return { record };
  }

  log.info(
    `[driven-session] spawning ${command} ${redactMcpConfigForLog(argv)} ` +
      `(cwd=${opts.cwd}, permissionMode=${permissionMode})`
  );

  const proc = spawnFn(command, argv, { cwd: opts.cwd, env: opts.env });

  const record: DrivenSessionRecord = {
    localId: opts.localId ?? randomUUID(),
    cwd: opts.cwd,
    permissionMode,
    argv,
    startedAt: new Date().toISOString(),
    taskId: opts.taskId ?? null,
    minskySessionId: opts.minskySessionId ?? null,
    projectId: opts.projectId ?? null,
    status: "spawned",
    unrecoverableReason: null,
    harnessSessionId: null,
    pid: proc.pid,
    exitCode: null,
    exitSignal: null,
    crashError: null,
    stopRequested: false,
    driverGeneration: 0,
    proc,
    eventLog: [],
    // A fresh spawn STARTS the conversation — there is no prior history.
    needsHistoryReplay: false,
    costHistory: [],
    subscribers: new Set(),
  };
  registry.install(record, installOpts);
  notifyStateChange(record, opts.onStateChange);
  wireChildProcess(proc, record, registry, command, opts);

  return { record };
}

/**
 * Shared stdout/stderr/error/exit wiring — factored out of
 * {@link startDrivenSession} so {@link resumeDrivenSession} (mt#3038) can
 * wire a session driver-swap respawn's child through the IDENTICAL parse/persist
 * pipeline without duplicating it. Assumes `record` is ALREADY registered
 * under its `localId` in `registry` (both callers register/replace before
 * calling this).
 */
function wireChildProcess(
  proc: ProcessLike,
  record: DrivenSessionRecord,
  registry: DrivenSessionRegistry,
  command: string,
  opts: Pick<
    StartDrivenSessionOptions,
    "onHarnessSessionLinked" | "onResultSummary" | "onStateChange"
  >
): void {
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
          notifyStateChange(record, opts.onStateChange);
        }
      }
      if (payload["type"] === "result") {
        const summary = extractResultSummary(payload, record.costHistory.length);
        if (summary) {
          record.costHistory.push(summary);
          if (opts.onResultSummary) {
            try {
              opts.onResultSummary(record, summary);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log.error(
                `[driven-session] onResultSummary observer threw for ${record.localId}: ${message}`
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
    // mt#3397 — an ENOENT here is ambiguous by Node's own design: it means
    // EITHER the binary is not on PATH OR the cwd does not exist, and its
    // message names the binary in both cases. The preflight in
    // startDrivenSession/resumeDrivenSession catches the ordinary
    // missing-cwd case before we ever get here, so reaching this branch with a
    // missing cwd means the directory vanished BETWEEN the preflight and the
    // spawn — rare, but real, and still unrecoverable rather than crashed.
    const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isEnoent && probeSpawnCwd(record.cwd) === "missing") {
      const reason = missingCwdReason(record.cwd);
      record.status = "unrecoverable";
      record.unrecoverableReason = reason;
      log.error(`[driven-session] spawn failed for ${record.localId} — ${reason}`);
      appendEvent(record, { type: "minsky_unrecoverable", reason });
      notifyStateChange(record, opts.onStateChange);
      return;
    }
    record.status = "crashed";
    record.crashError = isEnoent
      ? `Failed to start ${command}: not found — is '${command}' on this process's PATH? (${err.message})`
      : `Failed to start ${command}: ${err.message}`;
    log.error(`[driven-session] spawn error for ${record.localId}: ${err.message}`);
    appendEvent(record, {
      type: "minsky_error",
      message: record.crashError,
    });
    notifyStateChange(record, opts.onStateChange);
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
    notifyStateChange(record, opts.onStateChange);
  });
}

// ---------------------------------------------------------------------------
// Session driver swap (resume-respawn) — mt#3038, RFC "Conversation-first drive"
// Phase 1. R1 expert-review deltas #3 (record replacement) and #5
// (interruption-notice injection) are BINDING here.
// ---------------------------------------------------------------------------

/**
 * Injected as the FIRST input line of every resume-respawn (R1 delta #5).
 * Empirical basis (RFC, kill-mid-tool test): the transcript durably records
 * an interruption when the session driver dies mid-turn, and a resumed model
 * VERIFIES rather than blindly re-executes when told to — this notice turns
 * that observed behavior into a designed one rather than leaving it to
 * chance whether the model happens to notice the gap on its own.
 *
 * The string itself moved to `@minsky/shared/minsky-notices` (mt#3396) and is
 * re-exported here so existing importers are unaffected. It needs a second
 * consumer the browser bundle can reach: the render surface detects this notice
 * so it stops rendering under the operator's label, and
 * `custom/no-node-import-in-cockpit-web` forbids importing this module there.
 */
export { INTERRUPTION_NOTICE_TEXT };

/** The subset of a persisted/in-memory record {@link resumeDrivenSession} needs to respawn. */
export interface DrivenSessionResumeSource {
  localId: string;
  cwd: string;
  permissionMode: PermissionMode;
  /** REQUIRED — resuming is impossible without a harness session id to resume (see the
   * `unrecoverable`/`spawn-died-before-init` case, which never reaches this function). */
  harnessSessionId: string;
  taskId: string | null;
  minskySessionId: string | null;
  /**
   * Project attribution (mt#4732) — carried forward from the record being
   * resumed. Optional so a caller building `previous` by hand (rather than
   * passing a live `DrivenSessionRecord` through structurally) doesn't need
   * to name it; defaults to `null` in {@link resumeDrivenSession}.
   */
  projectId?: string | null;
  /** Preserved from the ORIGINAL spawn — stable across every swap (see schema docblock). */
  startedAt: string;
  /** The PRE-swap generation counter; the new record's is `previous.driverGeneration + 1`. */
  driverGeneration: number;
  /** The principal-selected model alias (mt#3040) from the original launch — preserved
   * across the resume so it doesn't silently fall back to the CLI's default. */
  model?: string | null;
}

export interface ResumeDrivenSessionOptions {
  previous: DrivenSessionResumeSource;
  onHarnessSessionLinked?: (record: DrivenSessionRecord) => void;
  onResultSummary?: (record: DrivenSessionRecord, summary: DrivenSessionCostSummary) => void;
  /** See `StartDrivenSessionOptions.onStateChange` — same contract, fired for the respawn too. */
  onStateChange?: (record: DrivenSessionRecord) => void;
  /** Override the claude binary command (test seam — points at a fake). */
  command?: string;
  /** Override the spawn function (test seam — REQUIRED for all tests, see module docblock). */
  spawnFn?: SpawnFn;
  /** Override environment variables passed to the child (test seam). */
  env?: NodeJS.ProcessEnv;
  /** Override the registry (test seam — hermetic instance per test). */
  registry?: DrivenSessionRegistry;
  /** See `StartDrivenSessionOptions.mcpConfig` — same contract for the respawn (mt#3377). */
  mcpConfig?: string | null;
  /**
   * See `StartDrivenSessionOptions.mcpServerNames` — same contract for the
   * respawn (mt#4239). A resume that resolved a DIFFERENT set than the start
   * would silently change the conversation's tool surface mid-conversation,
   * which is the mt#3377 defect class one level up.
   */
  mcpServerNames?: readonly string[];
  /** Skip the interruption-notice injection (test seam only — production always injects). */
  skipInterruptionNotice?: boolean;
}

/**
 * Respawn `claude --resume <harnessSessionId>` to replace a dead session driver for
 * an EXISTING `localId` — the restart-recovery path (RFC minimal-first-slice
 * step 3): a WS connect to a persisted-but-dead record triggers this instead
 * of a fresh `startDrivenSession` spawn.
 *
 * Callers (../driven-session-launch.ts orchestration) MUST hold the
 * cross-process resume lock (`withDrivenSessionResumeLock`) for
 * `previous.harnessSessionId` before calling this — this function itself has
 * no cross-process awareness (mirrors `startDrivenSession`'s domain-import-free
 * invariant; the lock lives in the domain layer).
 *
 * Constructs a brand-NEW `DrivenSessionRecord` (R1 delta #3 — never mutates
 * the old one) and installs it via `registry.replace(localId, newRecord)`,
 * which forces every existing subscriber of the OLD record to swap (closing
 * their sockets so clients redial). The new record keeps the SAME `localId`
 * and `harnessSessionId` (a resume continues the same conversation) and
 * increments `driverGeneration`.
 */
export function resumeDrivenSession(opts: ResumeDrivenSessionOptions): StartDrivenSessionResult {
  const { previous } = opts;
  const command = opts.command ?? CLAUDE_BINARY;
  const spawnFn = opts.spawnFn ?? prodSpawnFn;
  const registry = opts.registry ?? drivenSessionRegistry;
  // mt#3377: same undefined-vs-null contract as startDrivenSession — a resume
  // must re-provision the servers, or the conversation would silently lose its
  // whole MCP tool surface at the first daemon restart.
  const mcpConfig =
    opts.mcpConfig === undefined
      ? resolveMcpConfigForSpawn(previous.cwd, opts.mcpServerNames, `resume ${previous.localId}`)
      : opts.mcpConfig;
  const argv = buildResumeSessionArgs(
    previous.permissionMode,
    previous.harnessSessionId,
    previous.model,
    mcpConfig
  );

  // mt#3397 — same cwd preflight as startDrivenSession, and the path the
  // originating incident actually took: a workspace deleted out from under a
  // live conversation left every resume attempt crashing with an ENOENT that
  // named `claude`. `registry.replace` (not `register`) so the old record's
  // subscribers get the swap signal and redial onto the terminal state; the
  // generation is NOT incremented, because no new session driver was created.
  if (probeSpawnCwd(previous.cwd) === "missing") {
    const reason = missingCwdReason(previous.cwd);
    log.error(`[driven-session] not resuming ${previous.localId} — ${reason}`);
    const record = buildReconnectingDrivenSessionRecord({
      localId: previous.localId,
      harnessSessionId: previous.harnessSessionId,
      cwd: previous.cwd,
      permissionMode: previous.permissionMode,
      taskId: previous.taskId,
      minskySessionId: previous.minskySessionId,
      projectId: previous.projectId ?? null,
      status: "unrecoverable",
      unrecoverableReason: reason,
      driverGeneration: previous.driverGeneration,
      startedAt: previous.startedAt,
    });
    registry.replace(previous.localId, record);
    notifyStateChange(record, opts.onStateChange);
    return { record };
  }

  log.info(
    `[driven-session] resuming ${command} ${redactMcpConfigForLog(argv)} (localId=${previous.localId}, ` +
      `harnessSessionId=${previous.harnessSessionId}, generation=${previous.driverGeneration + 1}, cwd=${previous.cwd})`
  );

  const proc = spawnFn(command, argv, { cwd: previous.cwd, env: opts.env });

  const record: DrivenSessionRecord = {
    localId: previous.localId,
    cwd: previous.cwd,
    permissionMode: previous.permissionMode,
    argv,
    startedAt: previous.startedAt,
    taskId: previous.taskId,
    minskySessionId: previous.minskySessionId,
    projectId: previous.projectId ?? null,
    status: "spawned",
    unrecoverableReason: null,
    harnessSessionId: previous.harnessSessionId,
    pid: proc.pid,
    exitCode: null,
    exitSignal: null,
    crashError: null,
    stopRequested: false,
    driverGeneration: previous.driverGeneration + 1,
    proc,
    eventLog: [],
    // Attached-from-disk or resumed: prior history is on disk, never in this
    // record's log (mt#3453).
    needsHistoryReplay: true,
    costHistory: [],
    subscribers: new Set(),
  };

  registry.replace(previous.localId, record);
  notifyStateChange(record, opts.onStateChange);
  wireChildProcess(proc, record, registry, command, opts);

  if (!opts.skipInterruptionNotice) {
    // Host-authored, not operator-authored — no operator-input echo (mt#3372).
    sendDrivenSessionInput(record, INTERRUPTION_NOTICE_TEXT, { echo: false });
  }

  return { record };
}

// ---------------------------------------------------------------------------
// Boot-time reconciliation placeholder (mt#3038 minimal-first-slice step 2)
// ---------------------------------------------------------------------------

/**
 * A `ProcessLike` stub with NO live session driver behind it — used for a record
 * loaded from persistence at daemon boot (R1 delta #6: lazy-resume-only,
 * nothing is spawned here). `stdin`/`stdout`/`stderr` are inert
 * `PassThrough` streams (never receive real data); `kill()` is a no-op
 * (nothing to kill); `on()` never fires (no exit/error will ever occur on a
 * placeholder).
 */
function createDeadProcessPlaceholder(): ProcessLike {
  return {
    pid: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: () => false,
    on: () => undefined,
  };
}

/** Input to {@link buildReconnectingDrivenSessionRecord} — the persisted-row shape. */
export interface ReconnectingRecordInput {
  localId: string;
  harnessSessionId: string | null;
  cwd: string;
  permissionMode: PermissionMode;
  taskId: string | null;
  minskySessionId: string | null;
  /**
   * Project attribution (mt#4732). Optional — the two external reconnect
   * callers (a persisted `driven_sessions` row at boot, an attach-from-disk)
   * build this from a schema/shape that doesn't carry it, so it defaults to
   * `null` in {@link buildReconnectingDrivenSessionRecord} rather than
   * forcing every call site to pass it explicitly.
   */
  projectId?: string | null;
  /** Only these two persisted-only statuses ever reach this builder — a
   * `spawned`/`running`/`exited`/`crashed` row belongs to a live or
   * genuinely-terminal session driver, never a boot-time placeholder. */
  status: "reconnecting" | "unrecoverable";
  unrecoverableReason: string | null;
  driverGeneration: number;
  startedAt: string;
}

/**
 * Build a placeholder `DrivenSessionRecord` — one with no live session driver behind
 * it. Two callers: a persisted row loaded at daemon boot (RFC
 * minimal-first-slice step 2, the original use), and the mt#3397 cwd preflight,
 * which produces a terminal `unrecoverable` record INSTEAD of spawning. Both
 * want the same thing: a well-formed record whose `proc` is inert. Registered
 * into the
 * in-memory registry as `"reconnecting"` (or `"unrecoverable"`, for a
 * persisted row already known to be unresumable) WITHOUT spawning anything.
 * The domain-layer caller (../driven-session-launch.ts) is responsible for
 * eventually calling {@link resumeDrivenSession} against this placeholder's
 * data on the LAZY trigger (an operator action or client reconnect) — never
 * eagerly, right here.
 */
export function buildReconnectingDrivenSessionRecord(
  input: ReconnectingRecordInput
): DrivenSessionRecord {
  return {
    localId: input.localId,
    cwd: input.cwd,
    permissionMode: input.permissionMode,
    argv: [],
    startedAt: input.startedAt,
    taskId: input.taskId,
    minskySessionId: input.minskySessionId,
    projectId: input.projectId ?? null,
    status: input.status,
    unrecoverableReason: input.unrecoverableReason,
    harnessSessionId: input.harnessSessionId,
    pid: undefined,
    exitCode: null,
    exitSignal: null,
    crashError: null,
    stopRequested: false,
    driverGeneration: input.driverGeneration,
    proc: createDeadProcessPlaceholder(),
    eventLog: [],
    // Rehydrated at boot: its predecessor's log died with that process (mt#3453).
    needsHistoryReplay: true,
    costHistory: [],
    subscribers: new Set(),
  };
}

/**
 * One image to attach to a driven-session turn (mt#3235).
 *
 * Base64 rather than a path or URL: the child process is given the bytes
 * inline, so nothing depends on it being able to reach a file the host fetched
 * from a third party with a short-lived credential.
 */
export interface DrivenInputImage {
  base64: string;
  /** An image mime type the Messages API accepts — e.g. `image/png`. */
  mediaType: string;
}

/**
 * Assemble the content-block array for one input turn (mt#3235).
 *
 * Text is omitted when blank rather than sent as an empty block: the Messages
 * API rejects an empty text block, so a caption-less image would otherwise fail
 * the whole turn. An empty result means there is genuinely nothing to send, and
 * the caller reports that as a failed delivery rather than writing a
 * content-less message the child cannot answer.
 */
function buildInputContent(
  text: string,
  images: DrivenInputImage[]
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  if (text.trim().length > 0) {
    content.push({ type: "text", text });
  }
  for (const image of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.base64 },
    });
  }
  return content;
}

/**
 * Forward operator input to the child as a stream-json user message. Best
 * effort — the exact input-message shape is a documented-thin part of the
 * upstream schema (mt#2750 spec Context: "each input line is a complete JSON
 * user-message object"); this mirrors the Messages API content-block shape.
 * If the live-verification pass (main-agent, real `claude`) finds the real
 * binary expects a different shape, adjust ONLY this function.
 *
 * On a successful write the text is ALSO appended to the record's event log as
 * a synthetic {@link DRIVEN_OPERATOR_INPUT_EVENT_TYPE} frame (mt#3372). The
 * child never echoes stdin back: the Agent SDK's documented streaming-OUTPUT
 * taxonomy is system / assistant / result / stream_event, and a direct probe of
 * the installed binary (2026-07-30) confirmed no frame carries the message that
 * was sent in. Without this append the operator's own turns are invisible in
 * the driven conversation view — the ONLY `user`-typed frames on the channel
 * are harness-origin ones (tool results, injected skill bodies), so the view
 * showed everything except what the operator actually wrote.
 *
 * The frame is deliberately its OWN type rather than a forged stream-json
 * `user` payload, so operator-authored content stays structurally
 * distinguishable from harness-origin `user` frames (mt#3374 keys on that
 * distinction rather than re-deriving it from the text).
 *
 * Appending here also makes {@link isDrivenSessionMidTurn} report true for the
 * window between the operator pressing send and the child's first response
 * frame — correct, not incidental: a turn IS in flight, so the cockpit-tray
 * restart gate should defer exactly as it does mid-stream.
 *
 * `echo: false` suppresses the append for text this function delivers on the
 * SYSTEM's behalf rather than the operator's — currently the resume-time
 * interruption notice. Echoing that would attribute a host-authored message to
 * the operator, which is the same false-attribution class mt#3372 exists to
 * fix, just pointed the other way.
 *
 * Two consequences of routing the echo through `appendEvent` worth stating
 * outright, since both are behavior changes rather than bookkeeping:
 *
 *   - **A `spawned` record flips to `running` on the operator's first send**,
 *     one event earlier than before (previously only the child's own first
 *     stdout frame could do it). `running` here means "this session is
 *     active", which it is — the operator just handed it a turn. It does NOT
 *     assert the child has spoken; nothing keys on that distinction.
 *   - **The guard is {@link hasLiveSessionDriver}, not `isTerminalStatus`.** A
 *     `"reconnecting"` record is non-terminal but has no child behind it, so
 *     the write would land in an inert `PassThrough` and vanish. Before this
 *     change that silent loss returned `true`; now it returns `false`, and no
 *     phantom operator turn is rendered for a message that was never
 *     delivered. (Callers already branch on the return: the principal-channel
 *     session driver surfaces the failure to the sender.)
 *   - **Content-less input now returns `false` instead of being written**
 *     (mt#3235, flagged in PR #2483 R1). Previously blank text was written as
 *     `[{type:"text", text:""}]`; the Messages API rejects an empty text block,
 *     so that turn failed at the child rather than here. The websocket path
 *     (`driven-session-ws.ts`) can reach this with an empty `text` field or an
 *     empty raw frame, so the change is observable: `POST` to an entity thread
 *     now reports `delivered: false` for a blank message. That is the honest
 *     answer — it was never going to be delivered — but it IS a change, not an
 *     invariant that always held.
 */
export function sendDrivenSessionInput(
  record: DrivenSessionRecord,
  text: string,
  opts: { echo?: boolean; images?: DrivenInputImage[] } = {}
): boolean {
  if (!hasLiveSessionDriver(record)) return false;
  const content = buildInputContent(text, opts.images ?? []);
  if (content.length === 0) return false;
  const line = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content,
    },
  });
  try {
    record.proc.stdin.write(`${line}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[driven-session] failed to write input for ${record.localId}: ${message}`);
    return false;
  }
  if (opts.echo !== false) {
    appendEvent(record, {
      type: DRIVEN_OPERATOR_INPUT_EVENT_TYPE,
      text,
      timestamp: new Date().toISOString(),
    });
  }
  return true;
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
  if (isTerminalStatus(record.status)) return;
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
