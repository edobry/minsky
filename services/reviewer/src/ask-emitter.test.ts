/**
 * Tests for the reviewer Ask emitter (mt#2363 / mt#1596 Phase 1).
 *
 * Hermetic: the AskRepository is faked via the injected repoProvider, so no
 * DB or domain container is required.
 */

import { describe, test, expect, mock } from "bun:test";
import { captureConsoleLogs, findLogEvent } from "./test-helpers/log-capture";
import {
  DomainAskEmitter,
  ASK_CLASSIFIER_VERSION,
  ASK_REQUESTOR,
  type CircuitBreakerAlertContext,
} from "./ask-emitter";
import type { AskRepository, CreateAskInput } from "@minsky/domain/ask/repository";

const CTX: CircuitBreakerAlertContext = {
  owner: "edobry",
  repo: "minsky",
  prNumber: 1602,
  headSha: "abc1234",
  errorClass: "non_retryable_4xx",
  lastStatus: 422,
  consecutiveCount: 2,
  circuitId: "row-1602",
};

/** A minimal AskRepository whose `create` is a spy; other methods throw. */
function fakeRepo(createImpl: (input: CreateAskInput) => Promise<unknown>): {
  repo: AskRepository;
  create: ReturnType<typeof mock>;
} {
  const create = mock(createImpl);
  const repo = { create } as unknown as AskRepository;
  return { repo, create };
}

describe("DomainAskEmitter.emitCircuitBreakerAlert (mt#2363)", () => {
  test("creates an operator-routed coordination.notify Ask with the PR context", async () => {
    const created: CreateAskInput[] = [];
    const { repo, create } = fakeRepo(async (input) => {
      created.push(input);
      return { id: "ask-1", ...input };
    });
    const emitter = new DomainAskEmitter(() => Promise.resolve(repo));

    const { logs, restore } = captureConsoleLogs();
    try {
      await emitter.emitCircuitBreakerAlert(CTX);
    } finally {
      restore();
    }

    expect(create).toHaveBeenCalledTimes(1);
    const input = created[0] as CreateAskInput;
    expect(input.kind).toBe("coordination.notify");
    expect(input.routingTarget).toBe("operator");
    expect(input.classifierVersion).toBe(ASK_CLASSIFIER_VERSION);
    expect(input.requestor).toBe(ASK_REQUESTOR);
    // Context fields surface in the human-readable title/question.
    expect(input.title).toContain("1602");
    expect(input.question).toContain("edobry/minsky");
    expect(input.question).toContain("abc1234");
    expect(input.question).toContain("non_retryable_4xx");
    expect(input.question).toContain("422");
    // Severity + audit cross-reference ride in metadata (no native field).
    expect(input.metadata?.["severity"]).toBe("error");
    expect(input.metadata?.["crossReference"]).toBe("mt#2350");
    expect(input.metadata?.["pr"]).toBe(1602);
    expect(input.metadata?.["headSha"]).toBe("abc1234");
    expect(input.metadata?.["consecutiveCount"]).toBe(2);
    expect(input.metadata?.["circuitId"]).toBe("row-1602");
    // Success is observable in the log.
    expect(findLogEvent(logs, "sweeper.circuit_breaker_ask_created")).not.toBeNull();
  });

  test("fail-open: repo.create rejecting does NOT throw (logs error)", async () => {
    const { repo, create } = fakeRepo(() => Promise.reject(new Error("db down")));
    const emitter = new DomainAskEmitter(() => Promise.resolve(repo));

    const { logs, restore } = captureConsoleLogs();
    let threw = false;
    try {
      await emitter.emitCircuitBreakerAlert(CTX);
    } catch {
      threw = true;
    } finally {
      restore();
    }

    expect(threw).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(findLogEvent(logs, "sweeper.circuit_breaker_ask_failed")).not.toBeNull();
  });

  test("no-repo: provider returns null → no Ask created, warns", async () => {
    const emitter = new DomainAskEmitter(() => Promise.resolve(null));

    const { logs, restore } = captureConsoleLogs();
    let threw = false;
    try {
      await emitter.emitCircuitBreakerAlert(CTX);
    } catch {
      threw = true;
    } finally {
      restore();
    }

    expect(threw).toBe(false);
    expect(findLogEvent(logs, "sweeper.circuit_breaker_ask_skipped_no_repo")).not.toBeNull();
  });

  test("fail-open: a throwing repoProvider does NOT throw", async () => {
    const emitter = new DomainAskEmitter(() => Promise.reject(new Error("container boot failed")));

    const { logs, restore } = captureConsoleLogs();
    let threw = false;
    try {
      await emitter.emitCircuitBreakerAlert(CTX);
    } catch {
      threw = true;
    } finally {
      restore();
    }

    expect(threw).toBe(false);
    expect(findLogEvent(logs, "sweeper.circuit_breaker_ask_failed")).not.toBeNull();
  });
});
