/**
 * Driven-session session driver for the principal channel (mt#3228).
 *
 * Carries out the inbound router's decisions against a STANDING driven session
 * — one long-lived `claude` conversation that is the principal's counterpart on
 * their phone.
 *
 * ## Why one standing conversation rather than a session per message
 *
 * Grounding (Clark). "Focus on that one", "no, the other approach", "what about
 * the second one" only resolve against what was just said. A fresh session per
 * message would force the principal to restate context every time — which is
 * exactly the friction that makes a channel go unused. The conversation is the
 * durable entity; the child process is disposable (the same thesis the
 * conversation-first-drive RFC is built on).
 *
 * ## Permission mode is a real security decision
 *
 * A message from the principal's phone becomes a user turn in a local `claude`
 * process. The channel is therefore only as safe as the Telegram account that
 * drives it: anyone who compromises that account inherits whatever the channel
 * session can do.
 *
 * The default here is `bypassPermissions`, matching every other driven session
 * the cockpit spawns — because in headless `-p` mode a permission prompt has
 * nowhere to go, so `default` mode leaves the session unable to run the tools
 * that make it useful.
 *
 * This was AFFIRMED by the principal on 2026-07-26 (ask#6164), which asked
 * whether to keep it or drop to `default`; the answer was keep. So it is a
 * confirmed decision, not a default that happened to survive — worth knowing
 * before anyone "fixes" it as an oversight. The allowlist (chat id AND sender
 * id) is the control that actually bounds the exposure; the permission mode
 * only decides whether the channel can act once past it.
 *
 * Deployments wanting the tighter posture set `permissionMode: "default"` and
 * accept that the channel can answer questions but not act.
 *
 * ## Concurrency contract: one caller at a time PER SESSION DRIVER INSTANCE
 *
 * `converse` is NOT safe to call concurrently on the SAME session driver instance,
 * and deliberately so (PR #2330 R1). A standing conversation is a single
 * sequential turn-taker: every caller subscribes to the same event stream, so
 * two overlapping calls both resolve on whichever `result` arrives first, and
 * the second caller receives the first one's answer.
 *
 * That is not a bug to guard against here — it is what "one conversation"
 * means. Per-caller correlation would require the child to tag results with the
 * input that produced them, which the stream-json protocol does not do. The
 * poller enforces the contract by handling messages for the SAME conversation
 * strictly sequentially, which is also what the principal means: two messages
 * in a row in the same topic are two turns in one conversation, in order.
 *
 * ## Generalizing to one conversation per topic (mt#3505, parent mt#3500)
 *
 * Phase 1 of threaded mode needs many conversations, not one — a topic per
 * principal-initiated thought — while preserving the invariant above for EACH
 * one. This factory already parametrizes over `{@link
 * DrivenSessionDriverOptions.localId}` (originally added so a live probe
 * would not collide with the running channel's own row), so no change to
 * `ensureRecord`/`converse` was needed to support this: the launch-time
 * composition root (`./principal-channel-launch.ts`) calls this factory once
 * per Telegram topic, caches each returned session driver in a
 * {@link createTopicDriverRegistry} keyed by that topic's `localId`, and the
 * poller resolves the right cached instance per inbound message. Each
 * instance's `standingLocalId`/in-flight guard is independent, so the
 * "one caller at a time" contract above holds PER TOPIC while different
 * topics run fully concurrently — serialize per-conversation, not globally.
 *
 * A future caller that needs parallelism WITHIN one conversation still needs
 * its own conversation, not a lock around this one — that has not changed.
 *
 * @see mt#3228 — the bidirectional principal channel
 * @see mt#3505 — Phase 1 (principal-initiated topics), the generalization above
 * @see ./driven-session-host.ts — spawn / input / registry mechanics
 * @see ./principal-channel-poller.ts — what calls this, serialized per topic
 * @see ./principal-channel-launch.ts — builds and caches one session driver per topic
 */

import { log } from "@minsky/shared/logger";
import {
  drivenSessionRegistry,
  isTerminalStatus,
  sendDrivenSessionInput,
  startDrivenSession,
  stopDrivenSession,
  type DrivenSessionEvent,
  type DrivenSessionRecord,
  type DrivenSessionRegistry,
  type PermissionMode,
  type SpawnFn,
} from "./driven-session-host";
import { drivenSessionMcpServerNames } from "./driven-session-mcp-servers";
import {
  createDrivenInitObserver,
  createDrivenResultObserver,
  createDrivenSessionPersistObserver,
  orchestrateDrivenSessionResume,
} from "./driven-session-launch";
import type { ChannelDriver, ConverseOptions } from "./principal-channel-poller";

/**
 * The channel's standing conversation always occupies THIS row (mt#3243).
 *
 * `driven_sessions` is keyed on `localId` and the store upserts on it, so a
 * fixed id gives the channel exactly one row for its whole life — and, more
 * importantly, gives the session driver a way to find that row again after a daemon
 * restart has wiped its in-memory handle. Without a stable key there is nothing
 * to look up: the alternatives all cost a migration (a new event type, a new
 * column) or a fragile cwd-matching heuristic. See the task's Design decision.
 *
 * Not a UUID, deliberately: this is a well-known constant, and reading it in a
 * row or a log should say what it is.
 */
export const PRINCIPAL_CHANNEL_LOCAL_ID = "principal-channel-standing";

/**
 * How long to wait for a turn to finish before answering the principal anyway.
 *
 * Generous, because a real question ("what's blocked, and why?") legitimately
 * takes minutes of tool work. The timeout exists so the principal always gets
 * SOMETHING back — never so it can cut a working turn short at a useful moment.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long a freshly spawned conversation gets to become ready (mt#3234).
 *
 * Startup in a real project directory is not instant: SessionStart hooks run
 * first, then the child brings up its MCP servers (in the observed incident:
 * chrome-devtools, the minsky MCP proxy, a dockerized github server). Two
 * minutes is generous against that — a healthy spawn is seconds — while
 * cleanly separating it from the failure mode this bounds, where the child sat
 * for twenty minutes and never came up at all.
 */
export const DEFAULT_READY_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Poll interval while waiting for a spawn to become ready.
 *
 * 50ms: readiness is on the critical path of the principal's FIRST message, so
 * the granularity is felt directly, and polling a field in memory is free.
 */
const READY_POLL_MS = 50;

/**
 * Fold a replied-to message into the turn the agent actually sees (mt#3243).
 *
 * Telegram's reply affordance is out-of-band: the protocol carries it as a
 * separate field, so an agent reading only the message body cannot tell
 * "focus on that one" from a non sequitur. Quoting the target inline is what
 * makes the reference resolve — and it resolves on a FRESH conversation too,
 * which matters because the channel's conversation does not always survive
 * (a daemon restart replaces it).
 *
 * Blockquote form because the child is a `claude` process reading markdown:
 * `>` marks the quoted span unambiguously without inventing a delimiter the
 * model has to be taught.
 */
export function composeTurnInput(text: string, replyToText?: string): string {
  if (replyToText === undefined || replyToText.trim().length === 0) return text;
  const quoted = replyToText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `In reply to:\n${quoted}\n\n${text}`;
}

export interface DrivenSessionDriverOptions {
  /** Working directory for the channel conversation. */
  cwd: string;
  /** See the permission-mode discussion in this module's header. */
  permissionMode?: PermissionMode;
  model?: string;
  turnTimeoutMs?: number;
  /** How long a spawn gets to become ready before it is abandoned (mt#3234). */
  readyTimeoutMs?: number;
  /** Readiness poll granularity. Test seam. */
  readyPollMs?: number;
  registry?: DrivenSessionRegistry;
  /** Answer an ask by ref. Injected so the session driver does not import the ask domain. */
  respondToAsk: (askRef: string, text: string) => Promise<string>;
  /** Test seam — mirrors the driven-session routes' own injection points. */
  spawnFn?: SpawnFn;
  command?: string;
  /**
   * Test seam for the restart-recovery lookup — mirrors
   * `driven-session-ws.ts`'s own `orchestrateResume` injection point.
   */
  orchestrateResume?: typeof orchestrateDrivenSessionResume;
  /**
   * Test seam for the persistence observer. Production omits it and gets the
   * real writer; a test supplies a spy rather than reaching a database.
   */
  onStateChange?: (record: DrivenSessionRecord) => void;
  /**
   * Which durable row this conversation occupies. Defaults to
   * {@link PRINCIPAL_CHANNEL_LOCAL_ID}.
   *
   * Overridable so a live probe does not collide with the running channel's
   * own row — they would otherwise share one id, and the probe's conversation
   * would become the one the real channel resumes. A second channel bound to a
   * different chat would need its own id for the same reason.
   */
  localId?: string;
}

/**
 * Build the session driver the poller drives.
 *
 * Closes over the standing session rather than exposing it: the poller has no
 * business knowing whether a `claude` process currently exists, only that its
 * text reaches the principal's counterpart and comes back with an answer.
 */
export function createDrivenSessionDriver(opts: DrivenSessionDriverOptions): ChannelDriver {
  const registry = opts.registry ?? drivenSessionRegistry;
  const turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const readyPollMs = opts.readyPollMs ?? READY_POLL_MS;
  const orchestrateResume = opts.orchestrateResume ?? orchestrateDrivenSessionResume;
  const channelLocalId = opts.localId ?? PRINCIPAL_CHANNEL_LOCAL_ID;
  let standingLocalId: string | null = null;

  const liveRecord = (): DrivenSessionRecord | null => {
    if (!standingLocalId) return null;
    const record = registry.get(standingLocalId);
    if (!record || isTerminalStatus(record.status)) {
      // The conversation ended (crash, operator stop, daemon restart). Drop the
      // handle so the next message transparently starts a new one — the
      // principal should never have to know a process died.
      standingLocalId = null;
      return null;
    }
    return record;
  };

  /**
   * Get the standing conversation — resuming the persisted one when there is
   * one, spawning otherwise. Does NOT wait for readiness.
   *
   * mt#3234 waited for `init` here, before writing input. That is a deadlock:
   * `claude -p --input-format stream-json` does not emit `init` until it has
   * RECEIVED its first input message. Measured through this exact code path —
   * input withheld: hook events at ~1s then nothing, ever; input written
   * immediately: init at 3006ms. The write is what causes readiness, so it
   * cannot be gated on readiness (mt#3238).
   *
   * Readiness is still checked — after the write, in `converse` — which keeps
   * mt#3234's actual purpose: a child that never comes up is detected and
   * abandoned rather than silently swallowing messages forever.
   */
  const ensureRecord = async (): Promise<DrivenSessionRecord> => {
    const existing = liveRecord();
    if (existing) return existing;

    // The conversation is the durable entity; this process is not. After a
    // daemon restart the in-memory handle is gone but the transcript is not,
    // so try to reattach before starting over with no memory.
    const resumed = await orchestrateResume(channelLocalId, { registry });
    if (resumed.outcome === "resumed") {
      standingLocalId = resumed.record.localId;
      log.info(
        channelLocalId === PRINCIPAL_CHANNEL_LOCAL_ID
          ? "[principal-channel] resumed the standing channel conversation"
          : "[principal-channel] resumed a per-topic channel conversation",
        {
          localId: resumed.record.localId,
          harnessSessionId: resumed.record.harnessSessionId,
          driverGeneration: resumed.record.driverGeneration,
        }
      );
      return resumed.record;
    }
    if (resumed.outcome === "locked") {
      // Another process holds the resume lock for this conversation. Spawning
      // anyway would put two `claude --resume` on one transcript, which forks
      // its DAG silently — the exact hazard the lock exists to prevent.
      throw new Error(
        "another process is currently resuming this conversation — send the message again in a moment"
      );
    }
    if (resumed.outcome === "unrecoverable") {
      log.warn("[principal-channel] persisted conversation is unrecoverable; starting fresh", {
        reason: resumed.reason,
      });
    }

    const { record } = startDrivenSession({
      mcpServerNames: drivenSessionMcpServerNames(),
      cwd: opts.cwd,
      permissionMode: opts.permissionMode ?? "bypassPermissions",
      ...(opts.model === undefined ? {} : { model: opts.model }),
      taskId: null,
      minskySessionId: null,
      localId: channelLocalId,
      // Without these the conversation is never written down at all, so a
      // restart has nothing to resume FROM — the defect this task fixes.
      onStateChange: opts.onStateChange ?? createDrivenSessionPersistObserver(),
      // mt#4323: `startDrivenSession`, so this is a fresh conversation for the
      // channel — never a resume, which goes through its own path.
      onHarnessSessionLinked: createDrivenInitObserver({ adoptionReason: "initial" }),
      onResultSummary: createDrivenResultObserver(),
      registry,
      ...(opts.spawnFn === undefined ? {} : { spawnFn: opts.spawnFn }),
      ...(opts.command === undefined ? {} : { command: opts.command }),
    });
    standingLocalId = record.localId;
    // The message this replaced asserted "standing" unconditionally, which
    // became false the moment this factory started being called per topic
    // (mt#3505) — every per-topic conversation logged the exact opposite of
    // what happened. Keyed on the SAME localId already in the payload, so the
    // distinction costs nothing extra to compute (mt#3507).
    log.info(
      channelLocalId === PRINCIPAL_CHANNEL_LOCAL_ID
        ? "[principal-channel] starting the standing channel conversation"
        : "[principal-channel] starting a per-topic channel conversation",
      {
        localId: record.localId,
        cwd: opts.cwd,
      }
    );
    return record;
  };

  /**
   * In-flight guard around {@link ensureRecord}.
   *
   * `ensureRecord` became async when resume landed, and that opened a race the
   * synchronous version could not have: two callers arriving before the first
   * spawn completes BOTH see no live record and BOTH create one — two `claude`
   * processes for a conversation whose entire premise is that there is one.
   * (Caught by the pre-existing "concurrent callers share one conversation"
   * test, which went from 1 spawn to 2.)
   *
   * Sharing the promise keeps the module docblock's contract intact: concurrent
   * callers are not SUPPORTED — they resolve on the same turn's result — but
   * they must not multiply conversations.
   */
  let ensureInFlight: Promise<DrivenSessionRecord> | null = null;

  const ensureRecordOnce = (): Promise<DrivenSessionRecord> => {
    const existing = liveRecord();
    if (existing) return Promise.resolve(existing);
    if (ensureInFlight) return ensureInFlight;
    ensureInFlight = ensureRecord().finally(() => {
      ensureInFlight = null;
    });
    return ensureInFlight;
  };

  const abandonUnreadyRecord = (
    record: DrivenSessionRecord,
    outcome: SessionReadyOutcome
  ): void => {
    // Stop it and drop the handle so the NEXT message spawns fresh rather than
    // writing into a session that will never answer.
    stopDrivenSession(record);
    standingLocalId = null;
    log.error("[principal-channel] conversation never finished starting", {
      localId: record.localId,
      outcome,
      waitedMs: readyTimeoutMs,
      exitCode: record.exitCode,
    });
  };

  /** Names WHICH failure happened — see `SessionReadyOutcome`. */
  const startFailureError = (outcome: SessionReadyOutcome): Error =>
    new Error(
      outcome === "exited"
        ? "the channel conversation exited before it finished starting — send anything to retry"
        : `the channel conversation did not finish starting within ${Math.round(
            readyTimeoutMs / 1000
          )}s — send anything to retry`
    );

  /**
   * Confirm the conversation came up, AFTER its first input was written.
   *
   * Already-ready is the common path and costs nothing. For a fresh spawn this
   * is where mt#3234's detection actually happens: the input has been
   * delivered, so a healthy child reports `init` within seconds; one that never
   * does is abandoned rather than left to swallow every future message.
   */
  const confirmReady = async (record: DrivenSessionRecord): Promise<void> => {
    if (record.harnessSessionId) return;

    const outcome = await awaitSessionReady(record, readyTimeoutMs, readyPollMs);
    if (outcome !== "ready") {
      abandonUnreadyRecord(record, outcome);
      throw startFailureError(outcome);
    }
    log.info("[principal-channel] channel conversation ready", {
      localId: record.localId,
      harnessSessionId: record.harnessSessionId,
    });
  };

  return {
    async converse(text: string, opts: ConverseOptions = {}): Promise<string> {
      const { replyToText, images, onPartial, onBlockEnd } = opts;
      const record = await ensureRecordOnce();
      // Subscribe BEFORE writing: a fast turn could otherwise emit its result
      // between the write and the subscribe, and the reply would be lost.
      const turn = awaitTurnResult(record, turnTimeoutMs, onPartial, onBlockEnd);
      const sent = sendDrivenSessionInput(record, composeTurnInput(text, replyToText), {
        // Shapes match structurally; the seam type is deliberately the host's
        // (mt#3235), so no mapping is needed here.
        ...(images && images.length > 0 ? { images } : {}),
      });
      if (!sent) {
        turn.cancel();
        throw new Error("the channel conversation is not accepting input");
      }

      // Only now — the write above is what makes the child emit `init`.
      try {
        await confirmReady(record);
      } catch (err) {
        turn.cancel();
        throw err;
      }
      return turn.result;
    },

    async interrupt(): Promise<string> {
      const record = liveRecord();
      if (!record) return "Nothing is running.";
      stopDrivenSession(record);
      standingLocalId = null;
      return "Stopped. Send anything to start a new conversation.";
    },

    async reset(): Promise<string> {
      const record = liveRecord();
      if (record) stopDrivenSession(record);
      standingLocalId = null;
      return "Starting fresh — the next message begins a new conversation.";
    },

    async answerAsk(askRef: string, text: string): Promise<string> {
      return opts.respondToAsk(askRef, text);
    },
  };
}

/**
 * Cache of per-topic session drivers, keyed by the topic's `localId` (mt#3505).
 *
 * See this module's "Generalizing to one conversation per topic" docblock
 * section for why a cache is the right shape here rather than constructing a
 * fresh session driver per message: each instance closes over its own
 * `standingLocalId`/in-flight-spawn guard, so a fresh instance per call would
 * lose the "concurrent callers share one conversation" guarantee for any
 * topic that receives more than one message.
 */
export interface TopicDriverRegistry {
  /** The cached session driver for `localId`, or undefined if never created. */
  get(localId: string): ChannelDriver | undefined;
  /** The cached session driver for `localId`, creating and caching one via `factory` on first use. */
  getOrCreate(localId: string, factory: () => ChannelDriver): ChannelDriver;
}

export function createTopicDriverRegistry(): TopicDriverRegistry {
  const cache = new Map<string, ChannelDriver>();
  return {
    get: (localId) => cache.get(localId),
    getOrCreate: (localId, factory) => {
      const existing = cache.get(localId);
      if (existing) return existing;
      const created = factory();
      cache.set(localId, created);
      return created;
    },
  };
}

/**
 * Wait until a spawned conversation can actually act on input.
 *
 * Readiness is `harnessSessionId` being populated — the driven-session host
 * sets it when it observes the child's `init` event, which is the child saying
 * "I am up". Polled rather than subscribed because the host records the id on
 * the record itself, and a poll cannot miss an event that fired between the
 * spawn returning and a subscription being attached.
 *
 * The outcome distinguishes a child that DIED from one that is merely slow
 * (PR #2330 R1): they have different remedies — a crash points at the spawn
 * (binary, cwd, flags), a timeout at startup cost — and collapsing both into
 * "did not finish starting within 120s" sends whoever reads it, on a phone,
 * looking in the wrong place.
 */
export type SessionReadyOutcome = "ready" | "timeout" | "exited";

export async function awaitSessionReady(
  record: DrivenSessionRecord,
  timeoutMs: number,
  pollMs: number = READY_POLL_MS
): Promise<SessionReadyOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (record.harnessSessionId) return "ready";
    // A spawn that died before init has nothing left to wait for.
    if (isTerminalStatus(record.status)) return "exited";
    if (Date.now() >= deadline) return "timeout";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

interface PendingTurn {
  result: Promise<string>;
  cancel(): void;
}

/**
 * Pull assistant TEXT out of one `stream_event` payload, if it carries any.
 *
 * The host spawns `claude` with `--include-partial-messages`, so token-level
 * deltas arrive as `stream_event` frames wrapping the Anthropic streaming
 * sub-events. Only `text_delta` is read here: thinking and tool-call deltas are
 * explicitly out of scope for streamed replies (mt#3542 §Out of scope), and
 * keying on the delta's own shape is what excludes them — a `thinking` delta
 * carries `delta.thinking`, a tool-call delta carries `delta.partial_json`, and
 * neither has `delta.text`.
 *
 * `src/cockpit/web/lib/driven-session-accumulator.ts` is the full parser for
 * this event family (every block kind, index tracking, block lifecycle). This
 * is deliberately NOT that: a chat reply needs the running text and nothing
 * else, and the accumulator's output is a render-shaped block list.
 *
 * **On `index` (PR #2538 R1).** The block index is deliberately not tracked.
 * The caller concatenates in arrival order, which for a text-only view is
 * exactly what a reader sees — the ordering the transport already guarantees.
 * Index tracking earns its keep when blocks INTERLEAVE, and reconstructing that
 * correctly is what the accumulator above exists for; if streaming ever grows
 * past assistant text, use it rather than growing index handling here.
 */
export function partialAssistantText(payload: Record<string, unknown>): string | null {
  if (payload["type"] !== "stream_event") return null;
  const evt = payload["event"];
  if (typeof evt !== "object" || evt === null) return null;
  const frame = evt as Record<string, unknown>;
  if (frame["type"] !== "content_block_delta") return null;
  const delta = frame["delta"];
  if (typeof delta !== "object" || delta === null) return null;
  const record = delta as Record<string, unknown>;
  // Gate on the delta's OWN type, not just on the presence of a `text` field
  // (PR #2538 R1). Keying on the field alone happens to exclude thinking and
  // tool-call deltas today only because neither carries `text` — a coincidence
  // of the current shapes, not a rule the Bot's event schema promises.
  if (record["type"] !== "text_delta") return null;
  const text = record["text"];
  return typeof text === "string" && text.length > 0 ? text : null;
}

/**
 * True when this payload marks the START of a tool-use block (mt#3711).
 *
 * This is the semantic boundary the reply stream splits messages on: the prose
 * before a tool call is a finished thought, and the prose after it is a new
 * one. Splitting there is what makes a streamed turn read like chat rather
 * than like one paragraph that keeps growing.
 *
 * Read from the SAME event family {@link partialAssistantText} reads, and by
 * the same discipline — key on the block's own declared `type`, never on the
 * incidental presence of a field. A `content_block_start` arrives for text and
 * thinking blocks too, and neither ends a prose block: text CONTINUES one, and
 * a thinking block is not shown at all, so sealing on it would emit a message
 * boundary the reader has no way to account for.
 */
export function startsToolUseBlock(payload: Record<string, unknown>): boolean {
  if (payload["type"] !== "stream_event") return false;
  const evt = payload["event"];
  if (typeof evt !== "object" || evt === null) return false;
  const frame = evt as Record<string, unknown>;
  if (frame["type"] !== "content_block_start") return false;
  const block = frame["content_block"];
  if (typeof block !== "object" || block === null) return false;
  return (block as Record<string, unknown>)["type"] === "tool_use";
}

/**
 * Resolve with the assistant's text for the next completed turn.
 *
 * The stream-json `result` event is the turn's terminal marker and carries the
 * final text. Intermediate events are partial, and were originally discarded
 * outright because forwarding them as separate MESSAGES would flood the
 * principal's phone with notifications.
 *
 * That objection was retired in mt#3711: `disable_notification` separates
 * "separate message" from "notification", verified live on this channel. So
 * the caller now renders a turn as one message per prose block —
 * `onPartial` feeds the running text, `onBlockEnd` marks where a tool call
 * interrupted it — with only the first message notifying.
 *
 * The `result` text remains authoritative, and can differ from the streamed
 * deltas: a turn with tool-use rounds emits text before and after each round
 * while `result` carries the final answer. The caller settles on it, but only
 * ADDITIVELY — see `principal-channel-reply-stream.ts`'s `finish`, which may
 * not take back text the principal has already read.
 */
function awaitTurnResult(
  record: DrivenSessionRecord,
  timeoutMs: number,
  onPartial?: (accumulated: string) => void,
  onBlockEnd?: () => void
): PendingTurn {
  let settle: ((value: string) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let accumulated = "";

  const subscriber = {
    onEvent(event: DrivenSessionEvent): void {
      if (event.payload["type"] !== "result") {
        if (settle === null) return;
        if (startsToolUseBlock(event.payload)) {
          // Same best-effort contract as the partial below, and for the same
          // reason: a consumer that throws must not be able to kill the turn
          // whose progress it is reporting.
          try {
            onBlockEnd?.();
          } catch {
            // intentional-swallow: progress reporting is never worth a failed turn.
          }
          return;
        }
        if (onPartial === undefined) return;
        const chunk = partialAssistantText(event.payload);
        if (chunk === null) return;
        accumulated += chunk;
        // Best-effort by contract, exactly like the reaction acks: a streaming
        // consumer that throws must not be able to kill the turn whose progress
        // it is reporting. The host also guards its own dispatch loop, but this
        // subscriber owns the turn's resolution — so it guards here too.
        try {
          onPartial(accumulated);
        } catch {
          // intentional-swallow: progress reporting is never worth a failed turn.
        }
        return;
      }
      finish(resultText(event.payload));
    },
    onSwap(): void {
      // The record was replaced by a session driver swap (a resume-respawn). The
      // turn's output is going to the new record's stream, which this
      // subscription can never see — say so rather than hang until timeout.
      finish("The conversation was restarted mid-turn; ask again.");
    },
  };

  function finish(text: string): void {
    if (!settle) return;
    record.subscribers.delete(subscriber);
    if (timer) clearTimeout(timer);
    const resolve = settle;
    settle = null;
    resolve(text);
  }

  const result = new Promise<string>((resolve) => {
    settle = resolve;
    record.subscribers.add(subscriber);
    timer = setTimeout(() => {
      finish(
        "Still working on that — it is taking longer than expected. " +
          "Send /stop to interrupt, or ask again for an update."
      );
    }, timeoutMs);
  });

  return {
    result,
    cancel(): void {
      finish("");
    },
  };
}

/**
 * Pull the assistant's text out of a terminal `result` event.
 *
 * An errored turn still has something worth relaying — the principal needs to
 * know it failed and why, not receive silence.
 */
export function resultText(payload: Record<string, unknown>): string {
  const text = payload["result"];
  if (typeof text === "string" && text.trim().length > 0) return text;

  const isError = payload["is_error"] === true || payload["subtype"] === "error";
  if (isError) {
    const subtype = typeof payload["subtype"] === "string" ? payload["subtype"] : "unknown";
    return `The turn failed (${subtype}).`;
  }
  return "(the turn produced no text)";
}
