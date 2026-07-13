/**
 * Ask Wait-For-Response Subcommand (mt#2266)
 *
 * Blocks until an Ask reaches a response-bearing terminal state
 * (`responded` / `closed`) or a timeout elapses, then returns the response
 * payload. The agent-side analogue of `session_pr_wait-for-review`: the
 * missing primitive that lets an agent file an ask, gate on it, and resume
 * when the operator answers — without busy-polling `asks_list`.
 *
 * Gating semantics (mt#2266 planning decision): caller-managed. This tool
 * does the WAIT only — it does not mutate task status. Task↔ask linkage is
 * the ask's `parentTaskId` field (set at create time). This mirrors
 * `session_pr_wait-for-review`, which also blocks-and-returns without
 * touching task status.
 *
 * Three outcomes (discriminated union, parity with wait-for-review's
 * matched:true | matched:false shape):
 *   - `{ resolved: true, ... }` — state reached `responded`/`closed`; the
 *     response payload is returned.
 *   - `{ resolved: false, terminal: true, ... }` — state reached
 *     `cancelled`/`expired` (terminal WITHOUT a response). The wait returns
 *     immediately rather than blocking to timeout — the ask can never reach
 *     `responded`, so continuing to wait is pointless.
 *   - `{ resolved: false, terminal: false, ... }` — timeout elapsed while the
 *     ask was still pre-response (`detected`/`classified`/`routed`/
 *     `suspended`). The caller can re-wait or act on the still-pending state.
 *
 * Depends on the production advancement loop (mt#2265) for the wait to
 * terminate non-trivially: an ask must actually be able to reach `responded`
 * in production. Before mt#2265, asks never advanced past `detected`.
 */

import { ResourceNotFoundError, MinskyError, getErrorMessage } from "../errors/index";
import { log } from "@minsky/shared/logger";
import type { Ask, AskState } from "./types";
import { isTerminal } from "./state-machine";
import type { AskRepository } from "./repository";

/**
 * States that mean "the ask has a response the agent can act on."
 * Both carry the `response` field per the `Ask.response` contract in types.ts.
 */
const RESPONSE_BEARING_STATES: ReadonlySet<AskState> = new Set<AskState>(["responded", "closed"]);

export interface AskWaitForResponseDependencies {
  repo: AskRepository;
  /** Test seam: override the clock. Defaults to Date.now. */
  now?: () => number;
  /** Test seam: override the delay between polls. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AskWaitForResponseParams {
  /** Ask id (UUID) to wait on. */
  id: string;
  /** Max seconds to wait (default 600; clamped to [1, 1800]). */
  timeoutSeconds?: number;
  /** Polling interval in seconds (default 15; clamped to [5, 60]). */
  intervalSeconds?: number;
}

export interface AskWaitForResponseResolved {
  resolved: true;
  /** The ask in its response-bearing state (`responded` / `closed`). */
  ask: Ask;
  /** The resolved response payload (always present in these states). */
  response: NonNullable<Ask["response"]>;
  state: AskState;
  elapsedMs: number;
  pollCount: number;
}

export interface AskWaitForResponseTerminal {
  resolved: false;
  /** Terminal-without-response: state is `cancelled` or `expired`. */
  terminal: true;
  /** The terminal state reached. */
  lastState: AskState;
  elapsedMs: number;
  pollCount: number;
}

export interface AskWaitForResponseTimeout {
  resolved: false;
  terminal: false;
  /** The pre-response state at the final poll (detected/classified/routed/suspended). */
  lastState: AskState;
  elapsedMs: number;
  pollCount: number;
}

export type AskWaitForResponseResult =
  | AskWaitForResponseResolved
  | AskWaitForResponseTerminal
  | AskWaitForResponseTimeout;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Block until the ask reaches a response-bearing state, a non-response
 * terminal state, or the timeout elapses.
 *
 * Contract (parity with `sessionPrWaitForReview`):
 * - Clamps: timeout default 600s / [1, 1800]; interval default 15s / [5, 60].
 * - Polls `repo.getById(id)` each tick.
 * - Returns `{ resolved: true }` on `responded`/`closed` with the response.
 * - Returns `{ resolved: false, terminal: true }` immediately on
 *   `cancelled`/`expired` — does not block to timeout.
 * - Returns `{ resolved: false, terminal: false }` on timeout while still
 *   pre-response — does not throw.
 * - Throws `ResourceNotFoundError` when the ask does not exist, `MinskyError`
 *   for unexpected failures.
 * - Guarantees at least one poll even on a sub-interval timeout budget.
 */
export async function askWaitForResponse(
  params: AskWaitForResponseParams,
  deps: AskWaitForResponseDependencies
): Promise<AskWaitForResponseResult> {
  const { repo } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (!params.id || params.id.trim() === "") {
    throw new MinskyError("asks.wait-for-response: id is required and must not be empty");
  }

  const timeoutMs = clamp(params.timeoutSeconds ?? 600, 1, 1800) * 1000;
  const intervalMs = clamp(params.intervalSeconds ?? 15, 5, 60) * 1000;

  const start = now();
  const deadline = start + timeoutMs;
  let pollCount = 0;
  let lastState: AskState = "detected";

  try {
    while (true) {
      // After the first poll the sleep may have brought us to/past the
      // deadline; re-check before polling again so we never overshoot. The
      // `pollCount > 0` guard guarantees at least one poll on any budget.
      if (pollCount > 0 && now() >= deadline) {
        return { resolved: false, terminal: false, lastState, elapsedMs: now() - start, pollCount };
      }

      pollCount += 1;
      const ask = await repo.getById(params.id);
      if (!ask) {
        throw new ResourceNotFoundError(`Ask not found: ${params.id}`);
      }
      lastState = ask.state;

      if (RESPONSE_BEARING_STATES.has(ask.state)) {
        if (!ask.response) {
          // Defensive: the contract says responded/closed carry a response.
          // A missing response on these states is a data-integrity issue —
          // surface it rather than returning resolved with an empty payload.
          throw new MinskyError(
            `asks.wait-for-response: Ask ${params.id} is in state "${ask.state}" but has no response payload (data integrity issue)`
          );
        }
        return {
          resolved: true,
          ask,
          response: ask.response,
          state: ask.state,
          elapsedMs: now() - start,
          pollCount,
        };
      }

      // cancelled / expired — terminal without a response. Stop immediately;
      // the ask can never reach `responded`.
      if (isTerminal(ask.state)) {
        return {
          resolved: false,
          terminal: true,
          lastState: ask.state,
          elapsedMs: now() - start,
          pollCount,
        };
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        return { resolved: false, terminal: false, lastState, elapsedMs: now() - start, pollCount };
      }

      const sleepMs = Math.min(intervalMs, remaining);
      log.debug(
        `asks.wait-for-response: Ask ${params.id} poll ${pollCount} state=${ask.state}; ` +
          `sleeping ${Math.round(sleepMs / 1000)}s (${Math.round(remaining / 1000)}s remaining)`
      );
      await sleep(sleepMs);
    }
  } catch (error) {
    if (error instanceof ResourceNotFoundError || error instanceof MinskyError) {
      throw error;
    }
    throw new MinskyError(`Failed to wait for Ask response: ${getErrorMessage(error)}`);
  }
}
