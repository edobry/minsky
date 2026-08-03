/**
 * Adapter-level coverage for the severity → principal page dispatch (mt#3595).
 *
 * `principal-page.test.ts` covers the decision in isolation. What it cannot
 * cover — because it never goes through `createAsk` — are the two properties
 * that matter at the seam:
 *
 *   1. A page failure does not fail ask creation.
 *   2. A test run never reaches the live Telegram channel.
 *
 * (2) is the mt#3557 / mt#3538 hazard class. `notifyPrincipal` falls back to
 * reading the Pulumi stack, so an un-injected call from `createAsk` would spawn
 * `pulumi` and message the principal for real — and `createAsk` sits on far
 * more test paths than the `principal.notify` command those tasks addressed.
 */

import { describe, expect, it } from "bun:test";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import type { PrincipalPageDeps } from "@minsky/domain/ask/principal-page";
import { createAsk } from "./asks";

const INCIDENT_QUESTION = "Production is down and only you can push the revert.";

function makeParams(overrides: Record<string, unknown> = {}) {
  return {
    kind: "authorization.approve" as const,
    title: "Production outage",
    question: INCIDENT_QUESTION,
    severity: "incident" as const,
    forceImmediate: true,
    ...overrides,
  };
}

describe("createAsk severity page dispatch (mt#3595)", () => {
  it("creates the ask even when the page delivery fails", async () => {
    const repo = new FakeAskRepository();
    const failures: string[] = [];
    const deps: PrincipalPageDeps = {
      async send() {
        return { delivered: false, error: "transport exploded" };
      },
      async recordFailure(_ask, error) {
        failures.push(error);
      },
      now: () => new Date("2026-08-03T20:00:00.000Z"),
    };

    const ask = await createAsk(repo, makeParams(), {}, deps);

    // The ask is the decision record; losing it to a notification failure
    // would be strictly worse than losing the notification.
    expect(ask.id).toBeTruthy();
    expect(repo.all).toHaveLength(1);
    expect(failures).toEqual(["transport exploded"]);
  });

  it("creates the ask even when the page dispatch throws outright", async () => {
    const repo = new FakeAskRepository();
    const deps: PrincipalPageDeps = {
      async send() {
        throw new Error("unexpected");
      },
      async recordFailure() {
        throw new Error("recording also broke");
      },
      now: () => new Date("2026-08-03T20:00:00.000Z"),
    };

    const ask = await createAsk(repo, makeParams(), {}, deps);

    expect(ask.id).toBeTruthy();
    expect(repo.all).toHaveLength(1);
  });

  it("does not reach the live channel when no deps are injected", async () => {
    // The regression guard. If this ever starts hitting the network, it will
    // spawn `pulumi` and message the principal — the exact failure mt#3557 and
    // mt#3538 were filed for. `tests/setup.ts` sets NODE_ENV=test, which is
    // what the production deps check.
    expect(process.env.NODE_ENV).toBe("test");

    const repo = new FakeAskRepository();
    const ask = await createAsk(repo, makeParams());

    expect(ask.id).toBeTruthy();
    expect(repo.all).toHaveLength(1);

    // The claim IS burned even though nothing was delivered, because the claim
    // is taken BEFORE the send (see claimPrincipalPage's docblock: a crash
    // between send and write would otherwise re-notify). The consequence, worth
    // stating because it is easy to misread as a bug: a failed delivery marks
    // the ask paged permanently and is surfaced only through the actionable
    // `ask.page_failed` event — there is no retry. That is the documented
    // trade, not an accident.
    expect(repo.all[0]?.principalPagedAt).toBeTruthy();
  });

  it("leaves a non-severity ask completely untouched by the dispatch", async () => {
    const repo = new FakeAskRepository();
    let sendCalled = false;
    const deps: PrincipalPageDeps = {
      async send() {
        sendCalled = true;
        return { delivered: true };
      },
      async recordFailure() {},
      now: () => new Date("2026-08-03T20:00:00.000Z"),
    };

    await createAsk(repo, makeParams({ severity: undefined }), {}, deps);

    expect(sendCalled).toBe(false);
    expect(repo.all[0]?.principalPagedAt).toBeUndefined();
  });
});
