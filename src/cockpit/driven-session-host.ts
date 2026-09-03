/**
 * Cockpit driven-session HOST — the supervisor (mt#2750, Rung 2A; split from
 * its transport by mt#4934, ADR-047).
 *
 * Owns the drive record (`DrivenSessionRecord`), the `driverGeneration`
 * counter, restart/reconnect policy (mt#3038), cost-row bookkeeping, and the
 * `DrivenSessionRegistry` the WS attach point (./driven-session-ws.ts) and
 * the Express routes (./routes/driven-sessions.ts) both observe. It does
 * NOT know how a session driver is spawned or how its wire protocol is
 * shaped — that is a `DriverTransport` (./driver-transport.ts). This module
 * selects a single transport today (`ClaudeStreamJsonTransport`,
 * ./claude-transport.ts — the genuine `claude` binary under the
 * user's own subscription auth; RFC `372937f0-3cb4-8142-b3e3-c7238d3b51ba`'s
 * load-bearing invariant, unchanged by the split); mt#4935 will make that
 * selection per drive record.
 *
 * @see mt#2750 — this module's origin
 * @see mt#4934 — the transport-interface split, ADR-047
 * @see mt#2237 — parent (Rung 2), mt#2230 — umbrella
 * @see docs/architecture/adr-023-cockpit-ui-delivery-native-boundary.md — daemon-side + network transport
 * @see mt#2538 — daemon bind/auth (consumed by ./driven-session-ws.ts)
 * @see ./driven-session-ws.ts — WS upgrade attach point (auth + event fan-out)
 * @see ./routes/driven-sessions.ts — Express start/stop/list routes
 * @see ./driver-transport.ts — the transport contract
 * @see ./claude-transport.ts — the transport this module selects
 */

import { randomUUID } from "crypto";
import { PassThrough } from "stream";
import { log } from "@minsky/shared/logger";
import { INTERRUPTION_NOTICE_TEXT } from "@minsky/shared/minsky-notices";
import type {
  DriverAuthMode,
  DriverTransport,
  DriverTransportEvent,
  DrivenInputImage,
  DrivenSessionCostSummary,
  PermissionMode,
  ProcessLike,
  SpawnFn,
} from "./driver-transport";
import {
  DEFAULT_AUTH_MODE,
  DEFAULT_HARNESS_KIND,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TRANSPORT_ID,
} from "./driver-transport";
import { ClaudeStreamJsonTransport } from "./claude-transport";

export * from "./driver-transport";
export * from "./claude-cwd-preflight";
export * from "./claude-argv";
export * from "./claude-transport-parsing";
export * from "./claude-transport";

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

/** One event observed on a driven session's channel (from the transport's
 * output, or a host-generated synthetic terminal event — `minsky_error` /
 * `minsky_exit` — namespaced so they can never collide with an upstream
 * event `type`). */
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
 * collide with an upstream event type.
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
   * Which harness drives this session (mt#4935, ADR-047 §Consequences) —
   * `"claude-code"` today. Read-only after construction: a session driver
   * swap (`resumeDrivenSession`) carries the SAME harness forward from
   * `DrivenSessionResumeSource.harnessKind`, never re-derives it.
   */
  readonly harnessKind: string;
  /**
   * Which `DriverTransport` this record was spawned/resumed through — the
   * SAME instance as {@link transport}'s own `.id` (mt#4935). Persisted
   * separately from `transport` (which is never serialized) so a rehydrated
   * record can report a transport id without holding a live transport
   * instance.
   */
  readonly transportId: string;
  /**
   * The harness's OWN conversation id (mt#4935) — for `harnessKind ===
   * "claude-code"` the SAME value as {@link harnessSessionId}. Mutable for
   * the same reason that field is: unknown until the child's `init` event
   * links it (see `DrivenSessionRegistry.linkHarnessId`).
   */
  harnessConversationId: string | null;
  /**
   * Credential/identity posture this drive runs under (mt#4935) —
   * `"subscription"` or `"api-key"`. Read-only after construction, same
   * carry-forward rule as `harnessKind`.
   */
  readonly authMode: DriverAuthMode;
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
  /** Internal — the wired child handle, owned by whichever `DriverTransport`
   * spawned it. Not serialized to any API response. */
  readonly proc: ProcessLike;
  /**
   * The `DriverTransport` instance selected FOR THIS RECORD at spawn/resume
   * time (mt#4934 PR #3594 R1) — every later call that needs to talk to the
   * session driver (`sendDrivenSessionInput`, `stopDrivenSession`) goes
   * through this, never a global singleton or a freshly-constructed default.
   * A single hard-coded transport type is selected everywhere today
   * (`selectDriverTransport`); mt#4935 makes the selection meaningful by
   * reading a transport id off the drive record. Not serialized to any API
   * response.
   */
  readonly transport: DriverTransport;
  /** All events observed since spawn, in order (bounded by MAX_EVENT_LOG). */
  readonly eventLog: DrivenSessionEvent[];
  /**
   * Cost/usage summaries extracted from each terminal turn result observed
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
    // mt#4935: for every harness this codebase drives today, the harness's
    // own conversation id IS the value just discovered — `harnessSessionId`
    // stays the compatibility column (ADR-022 stage-2 retires it), this is
    // the harness-agnostic name a non-Claude harness (mt#4936) also writes.
    record.harnessConversationId = harnessSessionId;
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
 * A freshly-spawned record with NO events yet (before the transport's first
 * observed event, e.g. its `system`/`init` signal) counts as mid-turn: its
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
// Transport selection (mt#4934/mt#4935) — dispatches by `transportId`
// (`DriverTransport.id`). Only one transport implementation exists in this
// codebase today; an unrecognized id degrades to it with a warning rather
// than throwing — a caller passing a not-yet-landed id (e.g. the ACP
// sibling, mt#4936) should still get a driven session, not a crashed spawn.
// ---------------------------------------------------------------------------

type DriverTransportFactory = (overrides: {
  command?: string;
  spawnFn?: SpawnFn;
}) => DriverTransport;

const DEFAULT_DRIVER_TRANSPORT_FACTORY: DriverTransportFactory = (overrides) =>
  new ClaudeStreamJsonTransport(overrides);

/** Every `DriverTransport` this build knows how to construct, by `.id`. */
const DRIVER_TRANSPORT_FACTORIES: Readonly<Record<string, DriverTransportFactory>> = {
  [DEFAULT_TRANSPORT_ID]: DEFAULT_DRIVER_TRANSPORT_FACTORY,
};

function selectDriverTransport(overrides: {
  transportId?: string;
  command?: string;
  spawnFn?: SpawnFn;
}): DriverTransport {
  const transportId = overrides.transportId ?? DEFAULT_TRANSPORT_ID;
  const factory = DRIVER_TRANSPORT_FACTORIES[transportId];
  if (!factory) {
    log.warn(
      `[driven-session] unknown transport_id "${transportId}" — falling back to ` +
        `"${DEFAULT_TRANSPORT_ID}"`
    );
    return DEFAULT_DRIVER_TRANSPORT_FACTORY({
      command: overrides.command,
      spawnFn: overrides.spawnFn,
    });
  }
  return factory({ command: overrides.command, spawnFn: overrides.spawnFn });
}

/**
 * Fold one normalized {@link DriverTransportEvent} into supervisor state —
 * the successor to the pre-split `wireChildProcess`'s bookkeeping half.
 * Every branch below reproduces the ORIGINAL per-line processing order
 * exactly: link/cost bookkeeping happens first (when applicable), and
 * `appendEvent` with the event's raw payload always happens last, so the
 * WebSocket event sequence and persisted rows this produces are unaffected
 * by which transport emitted the event.
 */
function handleTransportEvent(
  record: DrivenSessionRecord,
  registry: DrivenSessionRegistry,
  event: DriverTransportEvent,
  opts: Pick<
    StartDrivenSessionOptions,
    "onHarnessSessionLinked" | "onResultSummary" | "onStateChange"
  >
): void {
  if (event.kind === "unrecoverable") {
    record.status = "unrecoverable";
    record.unrecoverableReason = event.reason;
    log.error(`[driven-session] spawn failed for ${record.localId} — ${event.reason}`);
    appendEvent(record, { type: "minsky_unrecoverable", reason: event.reason });
    notifyStateChange(record, opts.onStateChange);
    return;
  }

  if (event.kind === "processError") {
    record.status = "crashed";
    record.crashError = event.crashError;
    log.error(`[driven-session] spawn error for ${record.localId}: ${event.crashError}`);
    appendEvent(record, { type: "minsky_error", message: record.crashError });
    notifyStateChange(record, opts.onStateChange);
    return;
  }

  if (event.kind === "processExited") {
    record.exitCode = event.code;
    record.exitSignal = event.signal;
    record.status = classifyExit(record, event.code, event.signal);
    if (record.status === "crashed" && !record.crashError && event.crashErrorBase) {
      record.crashError = `${event.crashErrorBase}${
        record.harnessSessionId ? "" : " (no init event was ever observed)"
      }`;
    }
    appendEvent(record, {
      type: "minsky_exit",
      code: event.code,
      signal: event.signal,
      status: record.status,
      ...(record.crashError ? { error: record.crashError } : {}),
    });
    notifyStateChange(record, opts.onStateChange);
    return;
  }

  if (event.kind === "harnessSessionDiscovered" && !record.harnessSessionId) {
    registry.linkHarnessId(record, event.harnessSessionId);
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

  if (event.kind === "turnResult") {
    record.costHistory.push(event.summary);
    if (opts.onResultSummary) {
      try {
        opts.onResultSummary(record, event.summary);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          `[driven-session] onResultSummary observer threw for ${record.localId}: ${message}`
        );
      }
    }
  }

  // Every line-shaped event carries the exact upstream payload for one line —
  // forwarded verbatim, same as the pre-split code's unconditional
  // `appendEvent(record, payload)` at the end of its per-line loop body.
  appendEvent(record, event.raw);
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
  /** Which harness drives this session (mt#4935). Defaults to `DEFAULT_HARNESS_KIND`
   * (`"claude-code"`). */
  harnessKind?: string;
  /** Which `DriverTransport` to spawn through, by `.id` (mt#4935) — consumed by
   * `selectDriverTransport`. Defaults to `DEFAULT_TRANSPORT_ID`. */
  transportId?: string;
  /**
   * The harness's own conversation id, if already known at launch time
   * (mt#4935) — a fresh spawn normally has none yet; it is populated once the
   * child's `init` event links `harnessSessionId` (see
   * `DrivenSessionRegistry.linkHarnessId`). Defaults to `null`.
   */
  harnessConversationId?: string | null;
  /** Credential/identity posture to drive under (mt#4935). Defaults to
   * `DEFAULT_AUTH_MODE` (`"subscription"`). Threaded into the transport's
   * `spawn` call as `DriverTransportStartOptions.authMode`. */
  authMode?: DriverAuthMode;
  /**
   * Observer invoked once, when the transport's `harnessSessionDiscovered`
   * event links the harness session id (mt#2752 spawn-time identity
   * registration). The CALLER owns any domain-side effect (e.g. the
   * `driven_spawn` link write in ../driven-session-launch.ts) — keeping this
   * module free of domain imports per the docblock invariant. Errors are
   * caught and logged; a throwing observer never disturbs the event loop.
   */
  onHarnessSessionLinked?: (record: DrivenSessionRecord) => void;
  /**
   * Observer invoked once per turn, when a `turnResult` event yields a
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
   * from `cwd` by the transport, which is what production wants. Pass `null`
   * to spawn with NO MCP config at all (the pre-mt#3377 behavior); pass a
   * string to override the server set. Tests pass `null` so argv assertions
   * stay independent of the host machine's binary path.
   */
  mcpConfig?: string | null;
  /**
   * Which MCP servers to provision, by name (mt#4239). Omitted → the
   * transport's own default set.
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
 * Spawn a driven session and wire its output into the registry.
 * Returns synchronously (does NOT block on the transport's first observed
 * event) — the caller (POST /api/driven-session) can hand the operator a
 * session id immediately; the `init` signal (and everything else) is
 * buffered into `record.eventLog` and replayed to the WS channel on connect.
 */
export function startDrivenSession(opts: StartDrivenSessionOptions): StartDrivenSessionResult {
  const permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const registry = opts.registry ?? drivenSessionRegistry;
  const localId = opts.localId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const installOpts = { replacePrevious: opts.replacePrevious ?? false };
  const harnessKind = opts.harnessKind ?? DEFAULT_HARNESS_KIND;
  const transportId = opts.transportId ?? DEFAULT_TRANSPORT_ID;
  const authMode = opts.authMode ?? DEFAULT_AUTH_MODE;
  const transport = selectDriverTransport({
    transportId,
    command: opts.command,
    spawnFn: opts.spawnFn,
  });

  const spawnResult = transport.spawn({
    cwd: opts.cwd,
    permissionMode,
    authMode,
    model: opts.model,
    mcpConfig: opts.mcpConfig,
    mcpServerNames: opts.mcpServerNames,
    env: opts.env,
  });

  if (!spawnResult.ok) {
    const record = buildReconnectingDrivenSessionRecord({
      localId,
      harnessSessionId: null,
      harnessKind,
      transportId,
      harnessConversationId: opts.harnessConversationId ?? null,
      authMode,
      cwd: opts.cwd,
      permissionMode,
      taskId: opts.taskId ?? null,
      minskySessionId: opts.minskySessionId ?? null,
      projectId: opts.projectId ?? null,
      status: "unrecoverable",
      unrecoverableReason: spawnResult.reason,
      driverGeneration: 0,
      startedAt,
      transport,
    });
    registry.install(record, installOpts);
    notifyStateChange(record, opts.onStateChange);
    return { record };
  }

  const record: DrivenSessionRecord = {
    localId,
    cwd: opts.cwd,
    permissionMode,
    argv: spawnResult.argv,
    startedAt,
    taskId: opts.taskId ?? null,
    minskySessionId: opts.minskySessionId ?? null,
    projectId: opts.projectId ?? null,
    harnessKind,
    transportId,
    harnessConversationId: opts.harnessConversationId ?? null,
    authMode,
    status: "spawned",
    unrecoverableReason: null,
    harnessSessionId: null,
    pid: spawnResult.proc.pid,
    exitCode: null,
    exitSignal: null,
    crashError: null,
    stopRequested: false,
    driverGeneration: 0,
    proc: spawnResult.proc,
    transport,
    eventLog: [],
    // A fresh spawn STARTS the conversation — there is no prior history.
    needsHistoryReplay: false,
    costHistory: [],
    subscribers: new Set(),
  };
  registry.install(record, installOpts);
  notifyStateChange(record, opts.onStateChange);
  transport.attach(spawnResult.proc, opts.cwd, (event) =>
    handleTransportEvent(record, registry, event, opts)
  );

  return { record };
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
  /** Carried forward from the record being resumed (mt#4935). Defaults to
   * `DEFAULT_HARNESS_KIND` in {@link resumeDrivenSession}. */
  harnessKind?: string;
  /** Carried forward from the record being resumed (mt#4935) — which transport
   * to respawn through. Defaults to `DEFAULT_TRANSPORT_ID`. */
  transportId?: string;
  /** Carried forward from the record being resumed (mt#4935). Defaults to
   * `DEFAULT_AUTH_MODE`. */
  authMode?: DriverAuthMode;
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
  const registry = opts.registry ?? drivenSessionRegistry;
  const harnessKind = previous.harnessKind ?? DEFAULT_HARNESS_KIND;
  const transportId = previous.transportId ?? DEFAULT_TRANSPORT_ID;
  const authMode = previous.authMode ?? DEFAULT_AUTH_MODE;
  const transport = selectDriverTransport({
    transportId,
    command: opts.command,
    spawnFn: opts.spawnFn,
  });

  const spawnResult = transport.spawnResume({
    cwd: previous.cwd,
    permissionMode: previous.permissionMode,
    authMode,
    harnessSessionId: previous.harnessSessionId,
    model: previous.model ?? undefined,
    mcpConfig: opts.mcpConfig,
    mcpServerNames: opts.mcpServerNames,
    env: opts.env,
    localId: previous.localId,
    driverGeneration: previous.driverGeneration,
  });

  if (!spawnResult.ok) {
    // mt#3397 — same cwd preflight as startDrivenSession, and the path the
    // originating incident actually took: a workspace deleted out from under a
    // live conversation left every resume attempt crashing with an ENOENT that
    // named `claude`. `registry.replace` (not `register`) so the old record's
    // subscribers get the swap signal and redial onto the terminal state; the
    // generation is NOT incremented, because no new session driver was created.
    const record = buildReconnectingDrivenSessionRecord({
      localId: previous.localId,
      harnessSessionId: previous.harnessSessionId,
      harnessKind,
      transportId,
      harnessConversationId: previous.harnessSessionId,
      authMode,
      cwd: previous.cwd,
      permissionMode: previous.permissionMode,
      taskId: previous.taskId,
      minskySessionId: previous.minskySessionId,
      projectId: previous.projectId ?? null,
      status: "unrecoverable",
      unrecoverableReason: spawnResult.reason,
      driverGeneration: previous.driverGeneration,
      startedAt: previous.startedAt,
      transport,
    });
    registry.replace(previous.localId, record);
    notifyStateChange(record, opts.onStateChange);
    return { record };
  }

  const record: DrivenSessionRecord = {
    localId: previous.localId,
    cwd: previous.cwd,
    permissionMode: previous.permissionMode,
    argv: spawnResult.argv,
    startedAt: previous.startedAt,
    taskId: previous.taskId,
    minskySessionId: previous.minskySessionId,
    projectId: previous.projectId ?? null,
    harnessKind,
    transportId,
    // A resume already knows the harness's own conversation id — it IS
    // `harnessSessionId`, required to resume at all — so this is set here
    // directly rather than waiting for a `harnessSessionDiscovered` event
    // that will never fire for a resume (mt#4935).
    harnessConversationId: previous.harnessSessionId,
    authMode,
    status: "spawned",
    unrecoverableReason: null,
    harnessSessionId: previous.harnessSessionId,
    pid: spawnResult.proc.pid,
    exitCode: null,
    exitSignal: null,
    crashError: null,
    stopRequested: false,
    driverGeneration: previous.driverGeneration + 1,
    proc: spawnResult.proc,
    transport,
    eventLog: [],
    // Attached-from-disk or resumed: prior history is on disk, never in this
    // record's log (mt#3453).
    needsHistoryReplay: true,
    costHistory: [],
    subscribers: new Set(),
  };

  registry.replace(previous.localId, record);
  notifyStateChange(record, opts.onStateChange);
  transport.attach(spawnResult.proc, previous.cwd, (event) =>
    handleTransportEvent(record, registry, event, opts)
  );

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
  /** Which harness this record belongs to (mt#4935). Defaults to
   * `DEFAULT_HARNESS_KIND` in the builder — the two external callers (a
   * persisted row, an attach-from-disk) both predate any non-Claude harness. */
  harnessKind?: string;
  /** Which transport this record would resume through, by `.id` (mt#4935).
   * Defaults to `DEFAULT_TRANSPORT_ID`. */
  transportId?: string;
  /** The harness's own conversation id (mt#4935). Defaults to `harnessSessionId`
   * — the only harness this builder has ever served. */
  harnessConversationId?: string | null;
  /** Credential/identity posture (mt#4935). Defaults to `DEFAULT_AUTH_MODE`. */
  authMode?: DriverAuthMode;
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
  /**
   * The transport this record would resume through (mt#4934 PR #3594 R1).
   * Optional: the boot-time reconciliation caller (../driven-session-launch.ts,
   * loading a persisted row with no live spawn attempt) has no transport to
   * report, so this defaults to {@link selectDriverTransport}'s default
   * inside the builder. Functionally inert either way — every status this
   * builder ever produces is excluded from {@link hasLiveSessionDriver}, so
   * nothing ever calls `record.transport` on a placeholder built this way
   * until an actual {@link resumeDrivenSession} REPLACES it with a record
   * that selects for real.
   */
  transport?: DriverTransport;
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
    harnessKind: input.harnessKind ?? DEFAULT_HARNESS_KIND,
    transportId: input.transportId ?? DEFAULT_TRANSPORT_ID,
    harnessConversationId: input.harnessConversationId ?? input.harnessSessionId,
    authMode: input.authMode ?? DEFAULT_AUTH_MODE,
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
    transport: input.transport ?? selectDriverTransport({ transportId: input.transportId }),
    eventLog: [],
    // Rehydrated at boot: its predecessor's log died with that process (mt#3453).
    needsHistoryReplay: true,
    costHistory: [],
    subscribers: new Set(),
  };
}

/**
 * Forward operator input to the child through the selected transport. Best
 * effort — the exact wire shape is owned by the transport (mt#2750 spec
 * Context: "each input line is a complete JSON user-message object"); adjust
 * ONLY the transport if a live-verification pass finds the real binary
 * expects a different shape.
 *
 * On a successful delivery the text is ALSO appended to the record's event log
 * as a synthetic {@link DRIVEN_OPERATOR_INPUT_EVENT_TYPE} frame (mt#3372). The
 * child never echoes stdin back: the Agent SDK's documented streaming-OUTPUT
 * taxonomy is system / assistant / result / stream_event, and a direct probe of
 * the installed binary (2026-07-30) confirmed no frame carries the message that
 * was sent in. Without this append the operator's own turns are invisible in
 * the driven conversation view — the ONLY `user`-typed frames on the channel
 * are harness-origin ones (tool results, injected skill bodies), so the view
 * showed everything except what the operator actually wrote.
 *
 * The frame is deliberately its OWN type rather than a forged upstream `user`
 * payload, so operator-authored content stays structurally distinguishable
 * from harness-origin `user` frames (mt#3374 keys on that distinction rather
 * than re-deriving it from the text).
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
 * outright, since both are behavior changes rather than bookkeeping (unchanged
 * by mt#4934's split — this is a description of mt#3372's/mt#3235's
 * pre-existing behavior, preserved verbatim):
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
  const delivered = record.transport.sendUserTurn(record.proc, text, opts.images ?? []);
  if (!delivered) return false;
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
 * Graceful stop: delegates the actual mechanics (close stdin, SIGTERM
 * fallback after `graceMs`) to `record.transport` — the SAME transport
 * instance this record was spawned/resumed through (mt#4934 PR #3594 R1),
 * never a different one. This function's own job is the record-level guard:
 * a no-op against an already-terminal record (idempotent), and marking
 * `stopRequested` so a subsequent exit classifies as `"exited"`, not
 * `"crashed"` (see `classifyExit`).
 */
export function stopDrivenSession(
  record: DrivenSessionRecord,
  opts: { graceMs?: number } = {}
): void {
  if (isTerminalStatus(record.status)) return;
  record.stopRequested = true;
  record.transport.stop(record.proc, opts);
}
