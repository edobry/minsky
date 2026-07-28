/**
 * Driven-session actuator for the principal channel (mt#3228).
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
 * that make it useful. Deployments wanting the tighter posture set
 * `permissionMode: "default"` and accept that the channel can answer questions
 * but not act. This is a deliberate, configurable choice, not an oversight.
 *
 * ## Concurrency contract: one caller at a time
 *
 * `converse` is NOT safe to call concurrently, and deliberately so (PR #2330
 * R1). A standing conversation is a single sequential turn-taker: every caller
 * subscribes to the same event stream, so two overlapping calls both resolve on
 * whichever `result` arrives first, and the second caller receives the first
 * one's answer.
 *
 * That is not a bug to guard against here — it is what "one conversation"
 * means. Per-caller correlation would require the child to tag results with the
 * input that produced them, which the stream-json protocol does not do. The
 * poller enforces the contract by handling messages strictly sequentially,
 * which is also what the principal means: two messages in a row are two turns
 * in one conversation, in order.
 *
 * A future caller that needs parallelism needs its OWN conversation, not a
 * lock around this one.
 *
 * @see mt#3228 — the bidirectional principal channel
 * @see ./driven-session-host.ts — spawn / input / registry mechanics
 * @see ./principal-channel-poller.ts — what calls this, sequentially
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
import type { ChannelActuator } from "./principal-channel-poller";

/**
 * How long to wait for a turn to finish before answering the principal anyway.
 *
 * Generous, because a real question ("what's blocked, and why?") legitimately
 * takes minutes of tool work. The timeout exists so the principal always gets
 * SOMETHING back — never so it can cut a working turn short at a useful moment.
 */
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

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
const DEFAULT_READY_TIMEOUT_MS = 2 * 60 * 1000;

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

export interface DrivenSessionActuatorOptions {
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
  /** Answer an ask by ref. Injected so the actuator does not import the ask domain. */
  respondToAsk: (askRef: string, text: string) => Promise<string>;
  /** Test seam — mirrors the driven-session routes' own injection points. */
  spawnFn?: SpawnFn;
  command?: string;
}

/**
 * Build the actuator the poller drives.
 *
 * Closes over the standing session rather than exposing it: the poller has no
 * business knowing whether a `claude` process currently exists, only that its
 * text reaches the principal's counterpart and comes back with an answer.
 */
export function createDrivenSessionActuator(opts: DrivenSessionActuatorOptions): ChannelActuator {
  const registry = opts.registry ?? drivenSessionRegistry;
  const turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const readyPollMs = opts.readyPollMs ?? READY_POLL_MS;
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
   * Get the standing conversation, spawning one if needed. Does NOT wait.
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
  const ensureRecord = (): DrivenSessionRecord => {
    const existing = liveRecord();
    if (existing) return existing;

    const { record } = startDrivenSession({
      cwd: opts.cwd,
      permissionMode: opts.permissionMode ?? "bypassPermissions",
      ...(opts.model === undefined ? {} : { model: opts.model }),
      taskId: null,
      minskySessionId: null,
      registry,
      ...(opts.spawnFn === undefined ? {} : { spawnFn: opts.spawnFn }),
      ...(opts.command === undefined ? {} : { command: opts.command }),
    });
    standingLocalId = record.localId;
    log.info("[principal-channel] starting the standing channel conversation", {
      localId: record.localId,
      cwd: opts.cwd,
    });
    return record;
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
    async converse(text: string, replyToText?: string): Promise<string> {
      const record = ensureRecord();
      // Subscribe BEFORE writing: a fast turn could otherwise emit its result
      // between the write and the subscribe, and the reply would be lost.
      const turn = awaitTurnResult(record, turnTimeoutMs);
      if (!sendDrivenSessionInput(record, composeTurnInput(text, replyToText))) {
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
 * Resolve with the assistant's text for the next completed turn.
 *
 * The stream-json `result` event is the turn's terminal marker and carries the
 * final text; intermediate `assistant` events are partial and would produce a
 * flood of phone notifications if forwarded. One message per turn is the right
 * granularity for a chat channel.
 */
function awaitTurnResult(record: DrivenSessionRecord, timeoutMs: number): PendingTurn {
  let settle: ((value: string) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const subscriber = {
    onEvent(event: DrivenSessionEvent): void {
      if (event.payload["type"] !== "result") return;
      finish(resultText(event.payload));
    },
    onSwap(): void {
      // The record was replaced by an actuator swap (a resume-respawn). The
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
