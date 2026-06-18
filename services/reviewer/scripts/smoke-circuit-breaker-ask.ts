#!/usr/bin/env bun
/**
 * Live verification artifact for mt#2363 / mt#1596 Phase 1.
 *
 * Exercises the full production wiring that surfaces a tripped reviewer
 * circuit breaker on the cockpit `AsksPage`:
 *
 *   bootDomainContainer()                    (mt#2121 domain container)
 *     → makeContainerAskRepoProvider()       (builds DrizzleAskRepository)
 *       → DomainAskEmitter.emitCircuitBreakerAlert()
 *         → repo.create({ kind: "coordination.notify", routingTarget: "operator", ... })
 *
 * It then reads the created Ask back and asserts the contract that
 * `GET /api/asks` depends on: `routingTarget === "operator"` AND the row is
 * non-terminal (state "detected"). Finally it cleans up by transitioning the
 * test Ask to "cancelled" (a terminal state, valid from "detected") so it does
 * NOT linger on the operator surface.
 *
 * This verifies the persistence + routing-target contract end-to-end against a
 * real DB. The remaining live step — the cockpit HTTP `GET /api/asks` render —
 * is verified manually / on deploy (it requires the cockpit server running);
 * this script proves the row it would fetch is created with the correct shape.
 *
 * ## Env gating
 *
 * Requires a DB the domain container can connect to (the same config the
 * reviewer service uses in production). When the container cannot boot or no
 * DB connection is available, the script SKIPS gracefully (exit 0) — so it is
 * safe to run in CI / on a laptop without DB config.
 *
 * Usage:
 *   bun services/reviewer/scripts/smoke-circuit-breaker-ask.ts
 *
 * Exit codes: 0 = pass or skip, 1 = fail.
 */

import "reflect-metadata";
import { bootDomainContainer } from "../src/domain-container";
import {
  DomainAskEmitter,
  makeContainerAskRepoProvider,
  type CircuitBreakerAlertContext,
} from "../src/ask-emitter";

function skip(reason: string): never {
  console.log(JSON.stringify({ result: "SKIP", reason }, null, 2));
  process.exit(0);
}

function fail(reason: string, detail?: unknown): never {
  console.error(JSON.stringify({ result: "FAIL", reason, detail }, null, 2));
  process.exit(1);
}

async function main(): Promise<void> {
  // 1. Boot the domain container exactly like the reviewer service does.
  let container;
  try {
    const domain = await bootDomainContainer();
    container = domain.container;
  } catch (err) {
    skip(
      `domain container did not boot (no DB config?): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 2. Resolve the AskRepository via the production provider.
  const repoProvider = makeContainerAskRepoProvider(container);
  const repo = await repoProvider();
  if (!repo) {
    skip("AskRepository unavailable (no DB connection from the container)");
  }

  // 3. Emit a synthetic circuit-breaker alert. The sentinel circuitId lets us
  //    find + clean up exactly the row this run created.
  const circuitId = `smoke-${Date.now()}`;
  const ctx: CircuitBreakerAlertContext = {
    owner: "edobry",
    repo: "minsky",
    prNumber: 999999,
    headSha: "smoke0000000",
    errorClass: "smoke_non_retryable",
    lastStatus: 422,
    consecutiveCount: 2,
    circuitId,
  };
  const emitter = new DomainAskEmitter(() => Promise.resolve(repo));
  await emitter.emitCircuitBreakerAlert(ctx);

  // 4. Read it back. The Ask is created in state "detected"; find ours by the
  //    sentinel circuitId in metadata.
  const detected = await repo.listByState("detected");
  const created = detected.find((a) => a.metadata?.["circuitId"] === circuitId);
  if (!created) {
    fail("created Ask not found by sentinel circuitId in state=detected", { circuitId });
  }

  // 5. Assert the /api/asks contract: operator-routed + non-terminal kind.
  const problems: string[] = [];
  if (created.kind !== "coordination.notify") problems.push(`kind=${created.kind}`);
  if (created.routingTarget !== "operator") problems.push(`routingTarget=${created.routingTarget}`);
  if (created.state !== "detected") problems.push(`state=${created.state}`);
  if (created.metadata?.["severity"] !== "error") {
    problems.push(`metadata.severity=${String(created.metadata?.["severity"])}`);
  }

  // 6. Clean up: transition to "cancelled" (terminal, valid from "detected") so
  //    the smoke row does not surface on the cockpit.
  let cleanedUp = false;
  try {
    await repo.transition(created.id, "cancelled");
    cleanedUp = true;
  } catch (err) {
    problems.push(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (problems.length > 0) {
    fail("created Ask did not satisfy the /api/asks contract", { askId: created.id, problems });
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        askId: created.id,
        kind: created.kind,
        routingTarget: created.routingTarget,
        state: created.state,
        cleanedUp,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((err) => {
  fail("unexpected error", err instanceof Error ? err.message : String(err));
});
