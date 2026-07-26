#!/usr/bin/env bun
/**
 * Live verification of the INBOUND half of the principal channel (mt#3238).
 *
 * Drives the real `createDrivenSessionActuator` against a real `claude` child
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

import { createDrivenSessionActuator } from "../../src/cockpit/principal-channel-actuator";
import { DrivenSessionRegistry } from "../../src/cockpit/driven-session-host";

const PROMPT = "Reply with exactly the word PONG and nothing else. Do not use any tools.";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const cwd = argValue("--cwd") ?? process.cwd();
  const startedAt = Date.now();

  const actuator = createDrivenSessionActuator({
    cwd,
    registry: new DrivenSessionRegistry(),
    // Not exercised by this probe; the ask path has no bearing on the ordering
    // this verifies.
    respondToAsk: async () => "unused",
  });

  let reply: string;
  try {
    reply = await actuator.converse(PROMPT);
  } catch (err) {
    console.error(
      `FAIL after ${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  // Stop the child rather than leaving an orphan holding a claude process.
  await actuator.reset();

  if (reply.trim().length === 0) {
    console.error(`FAIL after ${Date.now() - startedAt}ms: the conversation returned no text`);
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      { status: "PASS", elapsedMs: Date.now() - startedAt, cwd, reply: reply.slice(0, 200) },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
