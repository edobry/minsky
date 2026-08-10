#!/usr/bin/env bun
/**
 * mt#3900 verification artifact: does the SessionStart WRITER and the proxy
 * READER agree on the harness pid, on this machine?
 *
 * This is the property whose failure is silent. If the two disagree, the reader
 * looks up a pid nobody wrote, finds nothing, falls back to the stale env value
 * — and that is precisely the defect, with no error emitted anywhere. Unit
 * tests pin the RULE against a synthetic process tree; only a live run can say
 * whether the rule finds a real `claude` ancestor from a real hook.
 *
 * Drives the actual compiled hook with a real SessionStart payload on stdin,
 * then reads the mapping back through the proxy's own reader.
 *
 * Usage:  bun scripts/verify-conversation-pid-mapping.ts
 * Exit:   0 = writer and reader agree (or SKIP: no harness ancestor here),
 *         1 = they disagree, or the write did not land.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  getConversationPidMapPath,
  readConversationMapping,
  resolveHarnessPid,
} from "../packages/shared/src/conversation-pid-map";

const HOOK_PATH = new URL("../.claude/hooks/session-start.ts", import.meta.url).pathname;

// A UUID that cannot collide with a real conversation, so a stale file from a
// previous run can never be mistaken for this run's write.
const PROBE_CONVERSATION_ID = "00000000-dead-4bee-8000-00000000c0de";

async function main(): Promise<void> {
  const harnessPid = resolveHarnessPid();

  if (harnessPid === null) {
    // No `claude` ancestor: this is a bare shell, CI, or a non-Claude-Code
    // parent. The mechanism correctly declines to guess, so there is nothing
    // to verify — not a failure.
    console.log("SKIP: no harness (claude) ancestor found from this process");
    process.exit(0);
  }

  console.log(`resolved harness pid: ${harnessPid}`);

  const mapPath = getConversationPidMapPath(harnessPid);

  // Capture the RAW bytes, not the parsed id (PR #2764 R1). This script
  // overwrites the operator's live mapping to run its probe, so it has to put
  // back exactly what was there — `updatedAt` and `harnessStartedAt` included.
  // Restoring a re-serialized parse would silently rewrite those fields, and
  // restoring only the id would drop them entirely.
  const preExistingRaw = existsSync(mapPath) ? String(readFileSync(mapPath, "utf8")) : null;
  console.log(
    `pre-existing mapping: ${preExistingRaw ? readConversationMapping(harnessPid) : "(none)"}`
  );

  // Drive the REAL hook exactly as the harness does: JSON payload on stdin.
  const payload = JSON.stringify({
    session_id: PROBE_CONVERSATION_ID,
    source: "clear",
    hook_event_name: "SessionStart",
    cwd: process.cwd(),
  });

  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: new TextEncoder().encode(payload),
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  console.log(`hook exit code: ${exitCode}`);

  // Read it back through the PROXY's reader, not by parsing the file here —
  // the point is that the two sides agree, so both sides must be exercised.
  const readBack = readConversationMapping(harnessPid);
  console.log(`reader saw: ${readBack ?? "(none)"}`);

  // Restore whatever was there before, so running this does not leave a probe
  // id attributed to the operator's live conversation. BOTH branches matter:
  // an earlier revision only handled the "nothing was there" case and silently
  // left the probe id in place when a real mapping existed — which would have
  // mis-attributed the operator's own next tool call (PR #2764 R1).
  try {
    if (preExistingRaw === null) {
      rmSync(mapPath);
    } else {
      writeFileSync(mapPath, preExistingRaw, "utf8");
    }
  } catch {
    // intentional-swallow: best-effort restore. Report it rather than throw,
    // since the measurement above is already complete.
    console.log(`WARN: could not restore ${mapPath}`);
  }

  if (readBack !== PROBE_CONVERSATION_ID) {
    console.log(
      `FAIL: reader did not see the hook's write (expected ${PROBE_CONVERSATION_ID}, got ${readBack ?? "none"})`
    );
    process.exit(1);
  }

  console.log("PASS: the SessionStart writer and the proxy reader agree on the harness pid");
}

await main();
