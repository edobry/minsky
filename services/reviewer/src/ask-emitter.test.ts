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
  GITHUB_APP_SETTINGS_URL,
  buildOperatorIncidentQuestion,
  buildOperatorIncidentTitle,
  providerBillingUrl,
  type CircuitBreakerAlertContext,
  type OperatorIncidentContext,
} from "./ask-emitter";
import {
  FakeAskRepository,
  type AskRepository,
  type CreateAskInput,
} from "@minsky/domain/ask/repository";
import type { PageMessage, PrincipalPageDeps } from "@minsky/domain/ask/principal-page";

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
    let outcome: string;
    try {
      outcome = await emitter.emitCircuitBreakerAlert(CTX);
    } finally {
      restore();
    }

    expect(outcome).toBe("created");
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
    let outcome: string | undefined;
    try {
      outcome = await emitter.emitCircuitBreakerAlert(CTX);
    } catch {
      threw = true;
    } finally {
      restore();
    }

    expect(threw).toBe(false);
    // Transient failure → "failed" so the caller does NOT dedup (reviewer R1).
    expect(outcome).toBe("failed");
    expect(create).toHaveBeenCalledTimes(1);
    expect(findLogEvent(logs, "sweeper.circuit_breaker_ask_failed")).not.toBeNull();
  });

  test("no-repo: provider returns null → no Ask created, warns, returns 'skipped'", async () => {
    const emitter = new DomainAskEmitter(() => Promise.resolve(null));

    const { logs, restore } = captureConsoleLogs();
    let threw = false;
    let outcome: string | undefined;
    try {
      outcome = await emitter.emitCircuitBreakerAlert(CTX);
    } catch {
      threw = true;
    } finally {
      restore();
    }

    expect(threw).toBe(false);
    // No substrate is a permanent condition → "skipped" so the caller dedups
    // (retrying would only spam the log every sweep cycle).
    expect(outcome).toBe("skipped");
    expect(findLogEvent(logs, "sweeper.circuit_breaker_ask_skipped_no_repo")).not.toBeNull();
  });

  test("fail-open: a throwing repoProvider does NOT throw, returns 'failed'", async () => {
    const emitter = new DomainAskEmitter(() => Promise.reject(new Error("container boot failed")));

    const { logs, restore } = captureConsoleLogs();
    let threw = false;
    let outcome: string | undefined;
    try {
      outcome = await emitter.emitCircuitBreakerAlert(CTX);
    } catch {
      threw = true;
    } finally {
      restore();
    }

    expect(threw).toBe(false);
    expect(outcome).toBe("failed");
    expect(findLogEvent(logs, "sweeper.circuit_breaker_ask_failed")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The operator paging tier (mt#2719)
// ---------------------------------------------------------------------------

/**
 * These use the real `FakeAskRepository` rather than the minimal `fakeRepo`
 * above, because the assertion that matters is about a method `fakeRepo` does
 * not have: `claimPrincipalPage`. That is the point — the marker is easy to set
 * and the page is the part that was missing.
 */
function pageRecordingDeps(): PrincipalPageDeps & { sent: PageMessage[] } {
  const sent: PageMessage[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return { delivered: true };
    },
    async recordFailure() {},
    now: () => new Date("2026-09-02T08:00:00.000Z"),
  } as PrincipalPageDeps & { sent: PageMessage[] };
}

const AUTH_CTX: OperatorIncidentContext = {
  source: "github_auth",
  consecutiveFailures: 3,
  threshold: 3,
  observedBy: "merge-state-sweeper",
  lastError: "Bad credentials",
  remediationUrl: GITHUB_APP_SETTINGS_URL,
};

const PROVIDER_CTX: OperatorIncidentContext = {
  source: "provider",
  errorClass: "provider_credits_exhausted",
  errorSummary: "The model provider account is out of credits — operator-only remediation.",
  occurrencesInWindow: 3,
  threshold: 3,
  windowMinutes: 60,
  lastError: "429 You have no credits remaining.",
  remediationUrl: "https://platform.openai.com/settings/organization/billing",
};

describe("DomainAskEmitter.emitOperatorIncidentAlert (mt#2719)", () => {
  test("marks the ask incident-severity, forceImmediate and operator-routed", async () => {
    const repo = new FakeAskRepository();
    const emitter = new DomainAskEmitter(() => Promise.resolve(repo), pageRecordingDeps());

    const outcome = await emitter.emitOperatorIncidentAlert(AUTH_CTX);

    expect(outcome).toBe("created");
    const asks = repo.all;
    expect(asks).toHaveLength(1);
    // All three are required and none implies another: severity decides whether
    // the principal is notified, forceImmediate decides whether the ask waits
    // for a service window, routingTarget decides whether a page has a reader.
    expect(asks[0]?.severity).toBe("incident");
    expect(asks[0]?.routingTarget).toBe("operator");
    expect(asks[0]?.kind).toBe("stuck.unblock");
  });

  test("actually pages — the assertion the whole task turns on", async () => {
    const repo = new FakeAskRepository();
    const deps = pageRecordingDeps();
    const emitter = new DomainAskEmitter(() => Promise.resolve(repo), deps);

    await emitter.emitOperatorIncidentAlert(AUTH_CTX);

    expect(deps.sent).toHaveLength(1);
    expect(await repo.countPrincipalPagesSince(new Date(0))).toBe(1);
  });

  test("carries the remediation URL into the body, for both sources", async () => {
    const repo = new FakeAskRepository();
    const emitter = new DomainAskEmitter(() => Promise.resolve(repo), pageRecordingDeps());

    await emitter.emitOperatorIncidentAlert(AUTH_CTX);
    await emitter.emitOperatorIncidentAlert(PROVIDER_CTX);

    const asks = repo.all;
    expect(asks).toHaveLength(2);
    // SC7: the operator can act from the notification without investigating.
    expect(asks[0]?.question).toContain(GITHUB_APP_SETTINGS_URL);
    expect(asks[1]?.question).toContain(
      "https://platform.openai.com/settings/organization/billing"
    );
  });

  test("no repository → skipped, never a throw", async () => {
    const emitter = new DomainAskEmitter(() => Promise.resolve(null));

    const { logs, restore } = captureConsoleLogs();
    let outcome: string;
    try {
      outcome = await emitter.emitOperatorIncidentAlert(AUTH_CTX);
    } finally {
      restore();
    }

    expect(outcome).toBe("skipped");
    expect(findLogEvent(logs, "operator_incident_ask_skipped_no_repo")).not.toBeNull();
  });

  test("a repository failure is fail-open", async () => {
    const emitter = new DomainAskEmitter(() => Promise.reject(new Error("container down")));

    const { logs, restore } = captureConsoleLogs();
    let threw = false;
    let outcome: string | undefined;
    try {
      outcome = await emitter.emitOperatorIncidentAlert(PROVIDER_CTX);
    } catch {
      threw = true;
    } finally {
      restore();
    }

    expect(threw).toBe(false);
    expect(outcome).toBe("failed");
    expect(findLogEvent(logs, "operator_incident_ask_failed")).not.toBeNull();
  });
});

describe("operator-incident ask body (mt#2719)", () => {
  test("the title names the condition, not the service", () => {
    expect(buildOperatorIncidentTitle(AUTH_CTX)).toContain("GitHub App auth is failing");
    expect(buildOperatorIncidentTitle(PROVIDER_CTX)).toContain("provider_credits_exhausted");
  });

  test("the body says the operator is the only one who can clear it", () => {
    for (const ctx of [AUTH_CTX, PROVIDER_CTX]) {
      const body = buildOperatorIncidentQuestion(ctx);
      expect(body).toContain("Only you can clear this");
      expect(body).toContain(ctx.remediationUrl);
    }
  });

  test("provider billing URLs are per-provider, never another vendor's page", () => {
    expect(providerBillingUrl("openai")).toContain("platform.openai.com");
    expect(providerBillingUrl("anthropic")).toContain("console.anthropic.com");
    // An unknown provider yields guidance, NOT a wrong vendor's billing page —
    // paging someone at the wrong console is worse than paging with no link.
    expect(providerBillingUrl("kimi")).not.toContain("http");
  });
});
