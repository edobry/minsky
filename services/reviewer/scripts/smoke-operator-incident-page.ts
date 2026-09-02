#!/usr/bin/env bun
/**
 * Live smoke for the reviewer's operator-incident paging tier (mt#2719).
 *
 * ## What this proves that the unit tests cannot
 *
 * Every unit test injects the page deps, so they prove the DECISION and the
 * message and never that the reviewer's own composition reaches a real channel.
 * The defect mt#2719 fixed was exactly of that shape — an emit path that looked
 * correct at every layer and reached no transport — so "the tests pass" is the
 * weakest possible evidence here.
 *
 * `scripts/verify-ask-principal-page.ts` (mt#3595) already covers
 * ask → decision → claim → Telegram. What it does NOT cover, and what this adds,
 * is the REVIEWER's composition on top of it: `DomainAskEmitter` →
 * `repo.create` → `dispatchPrincipalPage`. That seam is the one that did not
 * exist before mt#2719.
 *
 * ## Two modes, and why the default is the safe one
 *
 * **Dry (default).** Resolves the REAL principal channel (no send), then drives
 * the REAL `DomainAskEmitter` against an in-memory repository with page deps
 * whose `send` records instead of transmitting. That exercises every import,
 * every construction and the whole decision path — including the dispatch call
 * whose absence was the bug — and stops one HTTP request short of the phone.
 *
 * **`--execute`.** The real thing: a real ask row and a real notification to the
 * principal's phone. It is opt-in because it spends attention — the substrate
 * caps pages at 3 per 24h (`principal-page.ts` `PAGE_RATE_LIMIT_MAX`), so a
 * casual run burns a third of the day's budget, and an unlabelled synthetic
 * incident is precisely what a paging channel must never send. The ask it builds
 * says TEST in its title, which is the first line of the notification body.
 *
 * Usage — run from a checkout whose `infra/` holds the stack config (the MAIN
 * workspace; `Pulumi.<stack>.yaml` is gitignored and absent from session clones),
 * or with TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID set:
 *
 *   bun services/reviewer/scripts/smoke-operator-incident-page.ts
 *   bun services/reviewer/scripts/smoke-operator-incident-page.ts --execute
 *
 * Exit 0 = pass (or a clean SKIP when credentials are absent, which is not a
 * failure of this code). Exit 1 = a real failure.
 */

// MUST precede anything that can reach tsyringe (mt#3680) — `@minsky/domain`'s
// repository module does, and without this the script dies at import time with
// "tsyringe requires a reflect polyfill". Same first-import convention the
// scripts/ tree already uses.
import "reflect-metadata";

import { FakeAskRepository } from "@minsky/domain/ask/repository";
import {
  resolvePrincipalChannel,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import type { PageMessage, PrincipalPageDeps } from "@minsky/domain/ask/principal-page";
import {
  DomainAskEmitter,
  GITHUB_APP_SETTINGS_URL,
  type OperatorIncidentContext,
} from "../src/ask-emitter";

const EXECUTE = process.argv.includes("--execute");

/** A clearly-labelled synthetic incident. The title is the notification's lead. */
const CTX: OperatorIncidentContext = {
  source: "github_auth",
  consecutiveFailures: 3,
  threshold: 3,
  observedBy: "smoke-operator-incident-page",
  lastError: "TEST — synthetic, no real auth failure occurred",
  remediationUrl: GITHUB_APP_SETTINGS_URL,
};

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // 1. Can this process reach the channel at all? Reported separately from the
  //    emit, because "not configured" and "configured but the emit is broken"
  //    call for completely different responses and look identical downstream.
  const resolution = await resolvePrincipalChannel(createRealPrincipalChannelDeps());
  if (!resolution.configured) {
    console.log(`SKIP: principal channel not configured — ${resolution.reason}`);
    console.log("      (not a failure of this code; set TELEGRAM_* or run from a stack checkout)");
    process.exit(0);
  }
  console.log(`channel resolved: configured via ${resolution.config.source}`);

  if (!EXECUTE) {
    const sent: PageMessage[] = [];
    const recordingDeps: PrincipalPageDeps = {
      async send(message) {
        sent.push(message);
        return { delivered: true };
      },
      async recordFailure(_ask, error) {
        fail(`page path recorded a failure: ${error}`);
      },
      now: () => new Date(),
    };

    const repo = new FakeAskRepository();
    const emitter = new DomainAskEmitter(() => Promise.resolve(repo), recordingDeps);
    const outcome = await emitter.emitOperatorIncidentAlert(CTX);

    if (outcome !== "created") fail(`expected outcome "created", got "${outcome}"`);

    const [ask] = repo.all;
    if (!ask) fail("no ask was persisted");
    if (ask.severity !== "incident") fail(`ask.severity is "${ask.severity}", expected "incident"`);
    if (ask.routingTarget !== "operator") fail(`ask.routingTarget is "${ask.routingTarget}"`);

    // THE assertion. Before mt#2719 the two checks above would both have passed
    // and this one would not have: the marker was set and nothing paged.
    if (sent.length !== 1) fail(`expected exactly 1 page, got ${sent.length}`);
    if (!sent[0]?.message.includes(GITHUB_APP_SETTINGS_URL)) {
      fail("the page body does not carry the remediation URL");
    }

    console.log("PASS (dry): emitter → repo.create → dispatchPrincipalPage → send reached");
    console.log(`  ask.severity=${ask.severity} routingTarget=${ask.routingTarget}`);
    console.log(`  page title: ${sent[0]?.title}`);
    console.log("  re-run with --execute to send a real notification and persist a real ask");
    return;
  }

  console.log("--execute: this WILL create a real ask and notify the principal's phone.");
  const repo = new FakeAskRepository();
  // Production page deps (omitted third arg) — the real transport.
  const emitter = new DomainAskEmitter(() => Promise.resolve(repo));
  const outcome = await emitter.emitOperatorIncidentAlert({
    ...CTX,
    lastError: "TEST — synthetic incident from smoke-operator-incident-page, ignore",
  });

  if (outcome !== "created") fail(`expected outcome "created", got "${outcome}"`);
  const [ask] = repo.all;
  if (!ask?.principalPagedAt) {
    fail("the ask was created but no page was claimed — the dispatch did not run");
  }
  console.log(`PASS (execute): ask ${ask.id} created and paged at ${ask.principalPagedAt}`);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
