#!/usr/bin/env bun
/**
 * Live verification for the ask → principal notification path (mt#3595).
 *
 * Unit tests inject the delivery seam, so they prove the DECISION and the
 * message, never that a notification actually arrives. This exercises the real
 * composition — severity ask → decision → claim → notifyPrincipal → phone —
 * against the live Telegram channel.
 *
 * It deliberately drives `pagePrincipalForAsk` with the SAME production deps
 * the adapter builds, rather than calling `notifyPrincipal` directly. Calling
 * the transport directly would prove only that Telegram works, which is
 * already known; the thing under test is everything between the ask and the
 * transport.
 *
 * SENDS A REAL MESSAGE to the principal's phone. The ask it builds is labelled
 * as a test in its title, which is the first line of the notification body —
 * an unlabelled synthetic incident is the exact failure mode a paging system
 * must not have.
 *
 * Usage (from a checkout whose infra/ holds the stack config — the main
 * workspace, since Pulumi.<stack>.yaml is gitignored and absent from session
 * clones):
 *
 *   bun scripts/verify-ask-principal-page.ts
 *
 * Exit 0 = delivered. Exit 1 = a real failure. Exit 0 with SKIP = credentials
 * absent, which is not a failure of this code.
 */

import { pagePrincipalForAsk, type PrincipalPageDeps } from "@minsky/domain/ask/principal-page";
import {
  notifyPrincipal,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import type { Ask } from "@minsky/domain/ask/types";

/** A severity-marked, operator-routed ask — the only shape that notifies. */
function makeVerificationAsk(): Ask {
  return {
    id: "00000000-0000-4000-8000-00000000f595",
    shortId: "verify",
    kind: "authorization.approve",
    classifierVersion: "v1.0.0",
    state: "suspended",
    requestor: "minsky.agent:verify-script",
    routingTarget: "operator",
    severity: "incident",
    title: "TEST — verifying the ask notification path (mt#3595), no action needed",
    question:
      "This is a scripted verification that a severity-marked ask reaches your phone by itself. " +
      "Nothing is wrong and nothing is being asked of you.",
    createdAt: new Date().toISOString(),
    metadata: {},
  } as Ask;
}

/**
 * In-memory claim/count. The DB half is covered by unit tests against both
 * repository implementations; what cannot be faked — and what this script
 * exists for — is the transport.
 */
function makeRepo(ask: Ask) {
  let paged: string | undefined;
  return {
    async claimPrincipalPage(_id: string, at: Date) {
      if (paged) return { claimed: false, ask: { ...ask, principalPagedAt: paged } };
      paged = at.toISOString();
      return { claimed: true, ask: { ...ask, principalPagedAt: paged } };
    },
    async countPrincipalPagesSince() {
      return 0;
    },
  };
}

async function main(): Promise<number> {
  const ask = makeVerificationAsk();
  const repo = makeRepo(ask);

  let sendError: string | undefined;
  const deps: PrincipalPageDeps = {
    async send(message) {
      const result = await notifyPrincipal({
        message: message.message,
        title: message.title,
        deps: createRealPrincipalChannelDeps(),
      });
      return result.delivered
        ? { delivered: true }
        : { delivered: false, error: `${result.reason}: ${result.detail}` };
    },
    async recordFailure(_a, error) {
      sendError = error;
    },
    now: () => new Date(),
  };

  const outcome = await pagePrincipalForAsk(ask, repo, deps);

  if (outcome.sent) {
    process.stdout.write("PASS: notification delivered to the principal's channel\n");
    process.stdout.write(`  reason=${outcome.reason}\n`);
    return 0;
  }

  // Missing credentials is an environment fact, not a defect in this path.
  if (sendError?.includes("not-configured")) {
    process.stdout.write(`SKIP: principal channel not configured (${sendError})\n`);
    return 0;
  }

  process.stdout.write(`FAIL: notification not delivered\n`);
  process.stdout.write(`  reason=${outcome.reason}\n`);
  if (sendError) process.stdout.write(`  error=${sendError}\n`);
  return 1;
}

process.exit(await main());
