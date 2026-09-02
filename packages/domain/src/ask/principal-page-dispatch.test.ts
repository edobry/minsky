/**
 * Tests for the extracted severity-page dispatch (mt#2719).
 *
 * `principal-page.test.ts` already covers the DECISION exhaustively. What is new
 * here — and what mt#2719 exists for — is that the decision is only ever reached
 * by a caller that dispatches. The first test is therefore a NEGATIVE CONTROL on
 * the defect itself: persisting a correctly severity-marked, operator-routed ask
 * pages nobody on its own. That was true of every ask the reviewer service
 * created, and nothing about the row or the types showed it.
 */

import { describe, expect, it } from "bun:test";
import { FakeAskRepository, type CreateAskInput } from "./repository";
import type { PageMessage, PrincipalPageDeps } from "./principal-page";
import { dispatchPrincipalPage } from "./principal-page-dispatch";

const NOW = new Date("2026-09-02T08:00:00.000Z");

/** The exact shape the reviewer's emitter persists for an operator incident. */
function incidentInput(overrides: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    kind: "stuck.unblock",
    classifierVersion: "reviewer-operator-incident/v1",
    requestor: "minsky-reviewer-service",
    routingTarget: "operator",
    severity: "incident",
    forceImmediate: true,
    title: "Reviewer is down — provider_credits_exhausted",
    question: "The reviewer has failed 3 times in the last 60 minutes.",
    ...overrides,
  } as CreateAskInput;
}

/** Records deliveries and failures without touching any transport. */
function makeDeps(
  overrides: Partial<PrincipalPageDeps> = {}
): PrincipalPageDeps & { sent: PageMessage[]; failures: string[] } {
  const sent: PageMessage[] = [];
  const failures: string[] = [];
  return {
    sent,
    failures,
    async send(message) {
      sent.push(message);
      return { delivered: true };
    },
    async recordFailure(_ask, error) {
      failures.push(error);
    },
    now: () => NOW,
    ...overrides,
  } as PrincipalPageDeps & { sent: PageMessage[]; failures: string[] };
}

describe("dispatchPrincipalPage (mt#2719)", () => {
  it("NEGATIVE CONTROL: persisting a severity-marked ask pages nobody by itself", async () => {
    const repo = new FakeAskRepository();
    const ask = await repo.create(incidentInput());

    // The row is exactly right — this is the state the naive implementation
    // would have shipped, and the state that made the defect invisible.
    expect(ask.severity).toBe("incident");
    expect(ask.routingTarget).toBe("operator");
    // ...and nothing paged. `create` does not, and cannot, reach the page path.
    expect(ask.principalPagedAt).toBeUndefined();
    expect(await repo.countPrincipalPagesSince(new Date(0))).toBe(0);
  });

  it("dispatching that same ask is what actually pages", async () => {
    const repo = new FakeAskRepository();
    const ask = await repo.create(incidentInput());
    const deps = makeDeps();

    await dispatchPrincipalPage(repo, ask, deps);

    expect(deps.sent).toHaveLength(1);
    expect(deps.failures).toHaveLength(0);
    expect(await repo.countPrincipalPagesSince(new Date(0))).toBe(1);
  });

  it("does not page an ask that carries no severity marker", async () => {
    const repo = new FakeAskRepository();
    const ask = await repo.create(incidentInput({ severity: undefined }));
    const deps = makeDeps();

    await dispatchPrincipalPage(repo, ask, deps);

    expect(deps.sent).toHaveLength(0);
  });

  it("does not page a severity ask that is not operator-routed", async () => {
    const repo = new FakeAskRepository();
    const ask = await repo.create(incidentInput({ routingTarget: "subagent" }));
    const deps = makeDeps();

    await dispatchPrincipalPage(repo, ask, deps);

    expect(deps.sent).toHaveLength(0);
  });

  it("dispatching twice pages once — the claim is what dedups", async () => {
    const repo = new FakeAskRepository();
    const ask = await repo.create(incidentInput());
    const deps = makeDeps();

    await dispatchPrincipalPage(repo, ask, deps);
    await dispatchPrincipalPage(repo, ask, deps);

    expect(deps.sent).toHaveLength(1);
  });

  it("records a delivery failure rather than throwing", async () => {
    const repo = new FakeAskRepository();
    const ask = await repo.create(incidentInput());
    const deps = makeDeps({
      send: async () => ({ delivered: false, error: "not-configured: no chat id" }),
    });

    await dispatchPrincipalPage(repo, ask, deps);

    expect(deps.failures).toEqual(["not-configured: no chat id"]);
  });

  it("never throws, even when the page path itself blows up", async () => {
    const repo = new FakeAskRepository();
    const ask = await repo.create(incidentInput());
    const deps = makeDeps({
      send: async () => {
        throw new Error("transport exploded");
      },
      recordFailure: async () => {
        throw new Error("and so did the recorder");
      },
    });

    // The contract this asserts is the reason the dispatch swallows at all: the
    // ask IS the decision record, and losing it to a broken notification would
    // be strictly worse than losing the notification.
    expect(dispatchPrincipalPage(repo, ask, deps)).resolves.toBeUndefined();
  });
});
