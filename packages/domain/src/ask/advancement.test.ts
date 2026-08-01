/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp dirs for hermetic policy-router integration tests (same pattern as router.test.ts) */
/**
 * Tests for ask advancement (mt#2265).
 *
 * Covers the three production gaps the module closes:
 *   1. Async-transport route results are persisted (inbox → suspended/operator;
 *      subagent → routed with target) instead of dropped.
 *   2. Policy-covered asks persist their close.
 *   3. Stale `detected` rows expire instead of routing weeks late.
 *
 * Plus the sweep mechanics: batch cap, oldest-first, error isolation, and
 * concurrent-advancement tolerance.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import {
  advanceDetectedAsk,
  runAskAdvancementSweep,
  routeResultToOutcomeWrite,
  DEFAULT_MAX_DETECTED_AGE_MS,
} from "./advancement";
import { FakeAskRepository } from "./repository";
import type { Ask, AskKind } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KIND_DIRECTION_DECIDE: AskKind = "direction.decide";
const OUTCOME_SUSPENDED_FOR_OPERATOR = "suspended-for-operator";
const OUTCOME_ROUTED_AWAITING_TRANSPORT = "routed-awaiting-transport";

let tmpDir: string;
let repo: FakeAskRepository;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ask-advancement-test-"));
  repo = new FakeAskRepository();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function createDetectedAsk(
  kind: AskKind,
  overrides: { createdAt?: string; title?: string } = {}
): Promise<Ask> {
  const ask = await repo.create({
    kind,
    classifierVersion: "v1",
    requestor: "test-agent:proc:abc123",
    title: overrides.title ?? "advancement test ask",
    question: "Please resolve this",
    serviceStrategy: "asap",
    windowMissedCount: 0,
    forceImmediate: false,
  });
  if (overrides.createdAt) {
    repo._seedAtState({ ...ask, createdAt: overrides.createdAt });
    const reread = await repo.getById(ask.id);
    if (!reread) throw new Error("fixture re-read failed");
    return reread;
  }
  return ask;
}

const ROUTER_OPTS = () => ({ workspaceRoot: tmpDir });

// ---------------------------------------------------------------------------
// advanceDetectedAsk — outcome persistence
// ---------------------------------------------------------------------------

describe("advanceDetectedAsk", () => {
  it("persists an inbox-routed ask as suspended with routingTarget operator", async () => {
    // direction.decide is uncovered by policy (empty workspace) → inbox/operator
    const ask = await createDetectedAsk(KIND_DIRECTION_DECIDE);

    const outcome = await advanceDetectedAsk(repo, ask, ROUTER_OPTS());

    expect(outcome.kind).toBe(OUTCOME_SUSPENDED_FOR_OPERATOR);
    const persisted = await repo.getById(ask.id);
    expect(persisted?.state).toBe("suspended");
    expect(persisted?.routingTarget).toBe("operator");
    expect(persisted?.routedAt).toBeDefined();
    expect(persisted?.suspendedAt).toBeDefined();
  });

  it("persists a subagent-routed ask as routed with the target recorded", async () => {
    // capability.escalate routes to the subagent transport (no delivery loop yet)
    const ask = await createDetectedAsk("capability.escalate");

    const outcome = await advanceDetectedAsk(repo, ask, ROUTER_OPTS());

    expect(outcome.kind).toBe(OUTCOME_ROUTED_AWAITING_TRANSPORT);
    const persisted = await repo.getById(ask.id);
    expect(persisted?.state).toBe("routed");
    expect(persisted?.routingTarget).toBe("subagent");
    expect(persisted?.routedAt).toBeDefined();
  });

  it("honors a creator-specified operator target over the kind default (mt#3491)", async () => {
    // The reviewer's circuit-breaker emitter creates a `coordination.notify`
    // with an explicit `routingTarget: "operator"`, because a tripped breaker
    // is something the PRINCIPAL must see. The ADR-008 matrix binds that kind
    // to "peer"/mesh, and before mt#3491 the advancement sweep recomputed the
    // target from kind — discarding "operator" and stranding the row in
    // `routed`/peer, which `GET /api/asks` does not list. Four real alerts
    // (PRs #1950, #2009, #2056, #2057) were lost that way.
    const ask = await repo.create({
      kind: "coordination.notify",
      classifierVersion: "v1",
      requestor: "reviewer-service",
      title: "Reviewer submission circuit-breaker tripped — PR #1950",
      question: "The reviewer circuit breaker opened.",
      serviceStrategy: "asap",
      windowMissedCount: 0,
      forceImmediate: false,
      routingTarget: "operator",
    });

    const outcome = await advanceDetectedAsk(repo, ask, ROUTER_OPTS());

    expect(outcome.kind).toBe(OUTCOME_SUSPENDED_FOR_OPERATOR);
    const persisted = await repo.getById(ask.id);
    // suspended, not routed — otherwise the operator surface never lists it.
    expect(persisted?.state).toBe("suspended");
    expect(persisted?.routingTarget).toBe("operator");
  });

  it("still applies the kind default when the creator specified no target (mt#3491)", async () => {
    // Negative control for the override above: absent an explicit target, the
    // ADR-008 kind→target matrix must still govern, so the override cannot be
    // passing for the trivial reason that every ask now goes to the operator.
    const ask = await createDetectedAsk("coordination.notify");

    const outcome = await advanceDetectedAsk(repo, ask, ROUTER_OPTS());

    expect(outcome.kind).toBe(OUTCOME_ROUTED_AWAITING_TRANSPORT);
    const persisted = await repo.getById(ask.id);
    expect(persisted?.routingTarget).toBe("peer");
  });

  it("persists a policy-covered ask as closed with the citation response", async () => {
    await writeFile(
      join(tmpDir, "CLAUDE.md"),
      "## Approvals\n\nauto-approve formatter commits without asking.\n"
    );
    const ask = await createDetectedAsk("authorization.approve", {
      title: "auto-approve formatter commits",
    });

    const outcome = await advanceDetectedAsk(repo, ask, ROUTER_OPTS());

    expect(outcome.kind).toBe("closed-by-policy");
    const persisted = await repo.getById(ask.id);
    expect(persisted?.state).toBe("closed");
    expect(persisted?.routingTarget).toBe("policy");
    expect(persisted?.response?.responder).toBe("policy");
    expect(persisted?.closedAt).toBeDefined();
  });

  it("expires a detected ask older than maxAgeMs instead of routing it", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const ask = await createDetectedAsk("authorization.approve", { createdAt: eightDaysAgo });

    const outcome = await advanceDetectedAsk(repo, ask, ROUTER_OPTS(), {
      maxAgeMs: DEFAULT_MAX_DETECTED_AGE_MS,
    });

    expect(outcome.kind).toBe("expired-stale");
    const persisted = await repo.getById(ask.id);
    expect(persisted?.state).toBe("expired");
    expect(persisted?.closedAt).toBeDefined();
  });

  it("routes a stale direction.decide ask instead of expiring it (durable principal decision)", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const ask = await createDetectedAsk(KIND_DIRECTION_DECIDE, { createdAt: eightDaysAgo });

    const outcome = await advanceDetectedAsk(repo, ask, ROUTER_OPTS(), {
      maxAgeMs: DEFAULT_MAX_DETECTED_AGE_MS,
    });

    // NOT expired-stale — direction.decide is exempt from staleness expiry
    // (same policy as the triage script's never-bulk-expire exemption).
    expect(outcome.kind).toBe(OUTCOME_SUSPENDED_FOR_OPERATOR);
    const persisted = await repo.getById(ask.id);
    expect(persisted?.state).toBe("suspended");
    expect(persisted?.routingTarget).toBe("operator");
  });

  it("skips asks not in detected state", async () => {
    const ask = await createDetectedAsk(KIND_DIRECTION_DECIDE);
    await repo.transition(ask.id, "classified");
    const reread = await repo.getById(ask.id);
    if (!reread) throw new Error("fixture re-read failed");

    const outcome = await advanceDetectedAsk(repo, reread, ROUTER_OPTS());

    expect(outcome.kind).toBe("skipped");
  });

  it("treats a concurrent advancement as skipped, not an error", async () => {
    const ask = await createDetectedAsk(KIND_DIRECTION_DECIDE);
    // Simulate a concurrent actor advancing the row between list and write.
    await repo.transition(ask.id, "classified");

    // Pass the STALE snapshot (state still "detected") to advanceDetectedAsk.
    const outcome = await advanceDetectedAsk(repo, ask, ROUTER_OPTS());

    expect(outcome.kind).toBe("skipped");
    expect(outcome.detail).toBe("concurrent-advancement");
  });
});

// ---------------------------------------------------------------------------
// runAskAdvancementSweep
// ---------------------------------------------------------------------------

describe("runAskAdvancementSweep", () => {
  it("advances every detected ask in one pass and reports outcomes", async () => {
    await createDetectedAsk(KIND_DIRECTION_DECIDE);
    await createDetectedAsk("capability.escalate");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await createDetectedAsk("quality.review", { createdAt: eightDaysAgo });

    const summary = await runAskAdvancementSweep(repo, ROUTER_OPTS());

    expect(summary.scanned).toBe(3);
    expect(summary.byOutcome[OUTCOME_SUSPENDED_FOR_OPERATOR]).toBe(1);
    expect(summary.byOutcome["routed-awaiting-transport"]).toBe(1);
    expect(summary.byOutcome["expired-stale"]).toBe(1);
    expect(summary.errors.length).toBe(0);

    const remaining = await repo.listByState("detected");
    expect(remaining.length).toBe(0);
  });

  it("caps a pass at batchLimit, oldest first", async () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    const older = new Date(Date.now() - 120_000).toISOString();
    const oldest = await createDetectedAsk(KIND_DIRECTION_DECIDE, { createdAt: older });
    await createDetectedAsk(KIND_DIRECTION_DECIDE, { createdAt: old });
    await createDetectedAsk(KIND_DIRECTION_DECIDE);

    const summary = await runAskAdvancementSweep(repo, ROUTER_OPTS(), { batchLimit: 1 });

    expect(summary.scanned).toBe(1);
    // The oldest row was the one advanced.
    const persisted = await repo.getById(oldest.id);
    expect(persisted?.state).toBe("suspended");
    const remaining = await repo.listByState("detected");
    expect(remaining.length).toBe(2);
  });

  it("is idempotent — a second sweep over an advanced set scans nothing", async () => {
    await createDetectedAsk(KIND_DIRECTION_DECIDE);
    await runAskAdvancementSweep(repo, ROUTER_OPTS());

    const second = await runAskAdvancementSweep(repo, ROUTER_OPTS());

    expect(second.scanned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// routeResultToOutcomeWrite — mapping table
// ---------------------------------------------------------------------------

describe("routeResultToOutcomeWrite", () => {
  it("maps a window-suspended result to a suspended write with the target", async () => {
    const ask = await createDetectedAsk(KIND_DIRECTION_DECIDE);
    const { write, kind } = routeResultToOutcomeWrite({
      ...ask,
      state: "suspended",
      routingTarget: "operator",
      transport: { kind: "inbox" },
      packagedPayload: { question: ask.question },
      suspendedForWindowKey: "ask-hours",
    });

    expect(kind).toBe("suspended-for-window");
    expect(write.state).toBe("suspended");
    expect(write.routingTarget).toBe("operator");
  });

  it("maps an inbox-routed result to suspended-for-operator", async () => {
    const ask = await createDetectedAsk(KIND_DIRECTION_DECIDE);
    const { write, kind } = routeResultToOutcomeWrite({
      ...ask,
      state: "routed",
      routingTarget: "operator",
      transport: { kind: "inbox" },
      packagedPayload: { question: ask.question },
    });

    expect(kind).toBe(OUTCOME_SUSPENDED_FOR_OPERATOR);
    expect(write.state).toBe("suspended");
  });
});
