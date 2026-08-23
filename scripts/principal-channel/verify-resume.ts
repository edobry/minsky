#!/usr/bin/env bun
/**
 * Live verification that the channel conversation SURVIVES a restart (mt#3243).
 *
 * Sibling of `verify-conversation.ts`, which proves a real `claude` child
 * answers at all. This proves the thing unit tests structurally cannot: that
 * the persistence observers actually write a row, and that a NEW session driver with
 * no in-memory state finds that row and resumes the SAME conversation.
 *
 * Why a unit test is not enough here. The unit tests inject `orchestrateResume`
 * and a fake `onStateChange`, so they prove the session driver ROUTES the outcomes
 * correctly — not that the production default reaches a real database and comes
 * back. That gap is exactly mt#3254's lesson (a seam-tested binding was dead for
 * five weeks while rendering healthy zeros), and this change's failure mode is
 * the same shape: a resume that silently never finds anything is indistinguishable
 * from "no history yet".
 *
 * What it does:
 *   1. Session driver A tells the conversation a fact and waits for acknowledgement.
 *   2. A is dropped WITHOUT stopping the child — the daemon-restart shape (the
 *      registry dies; the transcript on disk does not).
 *   3. Session driver B is built fresh, with its own empty registry — no in-memory
 *      handle, exactly like a daemon that just booted.
 *   4. B is asked about the fact. Recalling it proves B resumed A's conversation
 *      rather than starting a blank one.
 *
 * Uses a probe-specific `localId` so it never collides with the running
 * channel's own durable row.
 *
 * Usage (from the repo root):
 *
 *   bun scripts/principal-channel/verify-resume.ts [--cwd <path>]
 *
 * Exit codes: 0 = the fact survived the restart, 1 = failure (reason printed).
 */

// Must come first: the configuration bootstrap below pulls in tsyringe, which
// throws at import time without this polyfill.
import "reflect-metadata";
import { createDrivenSessionDriver } from "../../src/cockpit/principal-channel-driver";
import { DrivenSessionRegistry } from "../../src/cockpit/driven-session-host";
import { safeTruncate } from "../../src/utils/safe-truncate";

// The daemon initializes configuration at boot; a standalone script must do it
// explicitly, or `getContextInspectorDb()` resolves null and the persistence
// observers skip the write — which makes this probe report a resume failure
// that is really a bootstrap failure. (Same shape as
// scripts/verify-agents-activity-bound.ts:28-33.)
//
// `workingDirectory` is deliberately `process.cwd()` — the REPO root — and NOT
// the `--cwd` passed to the session driver (PR #2352 R1 raised this). They are
// different things: `--cwd` is where the `claude` CHILD runs, which for this
// probe is a throwaway scratch directory; configuration resolution needs the
// project/user config that lives at the repo and home level. Pointing config
// loading at the scratch directory would find no config, leave the database
// unresolvable, and reintroduce exactly the silent no-write failure this
// bootstrap exists to prevent.
const { initializeConfiguration, CustomConfigFactory } = await import(
  "@minsky/domain/configuration"
);
await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

/** Distinctive enough that recalling it cannot be a lucky guess. */
const SECRET = "the launch code is tangerine-47";
const TELL = `Remember this for later: ${SECRET}. Reply with exactly OK and nothing else. Do not use any tools.`;
const ASK = "What is the launch code I gave you? Reply with just the code. Do not use any tools.";

/** Never the real channel's row. */
const PROBE_LOCAL_ID = "principal-channel-resume-probe";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const cwd = argValue("--cwd") ?? process.cwd();
  const startedAt = Date.now();

  // UNIQUE PER RUN. A fixed id makes the probe non-idempotent in the most
  // confusing way possible: run 2's first session driver resumes run 1's
  // conversation, so step 1 answers with run 1's secret and every later
  // assertion is meaningless. (Observed exactly that — which is itself the
  // clearest demonstration that resume works.)
  const probeLocalId = `${PROBE_LOCAL_ID}-${startedAt}`;

  const build = (label: string) =>
    createDrivenSessionDriver({
      cwd,
      localId: probeLocalId,
      // A fresh registry per session driver IS the restart: the in-memory handle is
      // what a daemon restart destroys.
      registry: new DrivenSessionRegistry(),
      respondToAsk: async () => `${label}: ask path not exercised by this probe`,
    });

  console.log(`[1/3] telling the conversation a fact (cwd=${cwd}, localId=${probeLocalId})`);
  const before = build("A");
  const ack = await before.converse(TELL);
  console.log(`      answered: ${safeTruncate(ack.trim(), 80, "head")}`);

  console.log("[2/3] dropping the session driver WITHOUT stopping the child (the restart shape)");
  // Deliberately no stop() — a daemon restart does not gracefully close the
  // conversation, it just stops existing. The next session driver has to cope.

  console.log(
    "[3/3] building a NEW session driver with an empty registry and asking about the fact"
  );
  const after = build("B");
  const recalled = await after.converse(ASK);
  console.log(`      answered (full): ${recalled.trim()}`);

  const elapsedMs = Date.now() - startedAt;
  if (!recalled.toLowerCase().includes("tangerine-47")) {
    fail(
      `the resumed conversation did NOT recall the fact after ${elapsedMs}ms — ` +
        `it started blank instead of resuming. Answer was: ${safeTruncate(recalled.trim(), 300, "head")}`
    );
  }

  console.log(`PASS: the fact survived the restart (${elapsedMs}ms)`);
  console.log(
    `      (probe row ${probeLocalId} left in driven_sessions; harmless, unique per run)`
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
