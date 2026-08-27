#!/usr/bin/env bun
/**
 * Live verification of the INBOUND half of the principal channel (mt#3238).
 *
 * Drives the real `createDrivenSessionDriver` against a real `claude` child
 * and requires a real answer back. The sibling `verify-send.ts` does this for
 * the outbound half; this is the half that a unit test provably cannot cover.
 *
 * It exists because a unit test certified a deadlock into production. The fake
 * emitted the child's `init` event on a timer regardless of input; the real
 * binary emits it only AFTER receiving input. So "wait for init, then write"
 * passed every test and hung every real message. Any assertion about the
 * write/readiness ORDERING is only trustworthy against the real binary.
 *
 * Usage (from the repo root — the conversation runs in `cwd`):
 *
 *   bun scripts/principal-channel/verify-conversation.ts [--cwd <path>]
 *
 * Exit codes: 0 = a real answer came back, 1 = failure (reason printed).
 */

import { createDrivenSessionDriver } from "../../src/cockpit/principal-channel-driver";
import { DrivenSessionRegistry } from "../../src/cockpit/driven-session-host";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const PROMPT = "Reply with exactly the word PONG and nothing else. Do not use any tools.";

/**
 * A turn long enough to stream (mt#3542).
 *
 * The PONG prompt is deliberately the shortest possible answer, which makes it
 * the WORST case for observing partials — it can finish inside a single delta.
 * Streaming has to be checked against a turn with enough output to arrive in
 * pieces.
 */
const STREAM_PROMPT =
  "Count slowly from 1 to 40, writing each number as an English word on its own line. " +
  "Do not use any tools.";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const cwd = argValue("--cwd") ?? process.cwd();
  // `--streaming` swaps in a longer prompt and ASSERTS on the partials (mt#3542).
  // Without it the probe still records them, but a one-word answer legitimately
  // arrives in a single delta, so it must not fail on that.
  const streaming = process.argv.includes("--streaming");
  const startedAt = Date.now();

  const sessionDriver = createDrivenSessionDriver({
    cwd,
    registry: new DrivenSessionRegistry(),
    // Not exercised by this probe; the ask path has no bearing on the ordering
    // this verifies.
    respondToAsk: async () => "unused",
  });

  // Streaming timing (mt#3542). A unit test can prove the poller HANDS an
  // `onPartial` to the session driver, but only a real `claude` child can show that
  // partials actually arrive, and how soon — the whole feature is worthless if
  // the first one lands at the same moment the answer does.
  let firstPartialAtMs: number | null = null;
  let partialCount = 0;
  let lastPartialLength = 0;

  let reply: string;
  try {
    reply = await sessionDriver.converse(streaming ? STREAM_PROMPT : PROMPT, {
      onPartial: (accumulated: string) => {
        if (firstPartialAtMs === null) firstPartialAtMs = Date.now() - startedAt;
        partialCount += 1;
        lastPartialLength = accumulated.length;
      },
    });
  } catch (err) {
    console.error(`FAIL after ${Date.now() - startedAt}ms: ${getLoggableErrorSummary(err)}`);
    process.exit(1);
  }

  // Measure a WARM turn too (mt#3542). The first turn pays for spawning the
  // `claude` child and its model round-trip, which production pays ONCE for the
  // standing conversation — not per message. So the cold number describes the
  // channel's very first message after a daemon start; every message after that
  // is the warm one, and that is what AT1's latency target is about.
  let warmFirstPartialAtMs: number | null = null;
  let warmPartials = 0;
  let warmElapsedMs: number | null = null;
  if (streaming) {
    const warmStartedAt = Date.now();
    warmFirstPartialAtMs = null;
    await sessionDriver.converse(STREAM_PROMPT, {
      onPartial: () => {
        if (warmFirstPartialAtMs === null) warmFirstPartialAtMs = Date.now() - warmStartedAt;
        warmPartials += 1;
      },
    });
    warmElapsedMs = Date.now() - warmStartedAt;
  }

  // Stop the child rather than leaving an orphan holding a claude process.
  await sessionDriver.reset();

  if (reply.trim().length === 0) {
    console.error(`FAIL after ${Date.now() - startedAt}ms: the conversation returned no text`);
    process.exit(1);
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        elapsedMs,
        cwd,
        streaming: {
          // Cold: includes spawning the `claude` child. Production pays this
          // once per daemon start, not per message.
          cold: {
            partials: partialCount,
            firstPartialAtMs,
            lastPartialChars: lastPartialLength,
          },
          // Warm: the standing conversation answering a second message — the
          // shape every message after the first one has.
          warm: {
            partials: warmPartials,
            firstPartialAtMs: warmFirstPartialAtMs,
            elapsedMs: warmElapsedMs,
          },
        },
        reply: reply.slice(0, 200),
      },
      null,
      2
    )
  );

  if (streaming) {
    if (partialCount === 0) {
      console.error(
        "FAIL: the turn produced no partials — streamed replies would silently never update."
      );
      process.exit(1);
    }
    // AT1 wants partial content well before the turn ends. Asserting against
    // the turn's OWN duration rather than a fixed threshold keeps this
    // meaningful whether the turn took 6s or 60s.
    if (firstPartialAtMs !== null && firstPartialAtMs >= elapsedMs) {
      console.error(
        `FAIL: the first partial arrived at ${firstPartialAtMs}ms, no sooner than the reply itself (${elapsedMs}ms).`
      );
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`FAIL: ${getLoggableErrorSummary(err)}`);
  process.exit(1);
});
