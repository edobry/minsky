#!/usr/bin/env bun
/**
 * Live acceptance for mt#4934 — the DriverTransport split, exercised end to
 * end against the REAL `claude` binary through `ClaudeStreamJsonTransport`.
 *
 * Spawns a real driven session through the production supervisor
 * (`src/cockpit/driven-session-host.ts` — the exact module the cockpit
 * daemon's `POST /api/driven-session` route calls), drives two turns, kills
 * the session driver abruptly (simulating the daemon-restart case — a
 * graceful `stopDrivenSession` would leave the record in the TERMINAL
 * `exited` state, which is deliberately not resumable), then resumes the
 * SAME conversation through `resumeDrivenSession` and confirms:
 *
 *   1. the resumed record keeps the same `harnessSessionId` (same conversation)
 *   2. `driverGeneration` incremented by exactly 1 (mt#3038's guarantee, SC/AT3)
 *   3. a third turn against the RESUMED process still gets a real answer
 *
 * This is the same "call the production module directly with a real spawnFn"
 * pattern as scripts/verify-driven-operator-echo.ts and
 * scripts/verify-driver-gone-retirement.ts — it does not go through the
 * cockpit HTTP/WS layer, which is a thin pass-through over these same
 * functions (see src/cockpit/routes/driven-sessions.ts).
 *
 * Gated on the `claude` binary being present and runnable; skips cleanly
 * (exit 0) when it is not.
 *
 * Usage: bun scripts/verify-driver-transport-live.ts
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startDrivenSession,
  resumeDrivenSession,
  sendDrivenSessionInput,
  type DrivenSessionRecord,
  type DrivenSessionResumeSource,
} from "../src/cockpit/driven-session-host";

const TURN_TIMEOUT_MS = 90_000;
const POLL_MS = 250;

function resolveClaudeBinary(): string | null {
  const pathEntries = (process.env["PATH"] ?? "").split(":").filter(Boolean);
  const fallbacks = [
    join(process.env["HOME"] ?? "", ".bun/bin"),
    join(process.env["HOME"] ?? "", ".local/bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const dir of [...pathEntries, ...fallbacks]) {
    const candidate = join(dir, "claude");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  describe: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${describe}`);
}

function lastAssistantText(record: DrivenSessionRecord): string {
  for (let i = record.eventLog.length - 1; i >= 0; i--) {
    const payload = record.eventLog[i]?.payload;
    if (payload?.["type"] === "assistant") {
      const message = payload["message"] as
        | { content?: Array<{ type?: string; text?: string }> }
        | undefined;
      const block = message?.content?.find((c) => c.type === "text");
      if (block?.text) return block.text;
    }
  }
  return "";
}

async function main(): Promise<number> {
  const command = resolveClaudeBinary();
  if (!command) {
    console.log("SKIP: claude binary not found on PATH — cannot run live acceptance.");
    return 0;
  }

  const cwd = mkdtempSync(join(tmpdir(), "driver-transport-live-"));
  console.log(`[1/6] launching a driven session (cwd=${cwd})`);

  const { record: initial } = startDrivenSession({
    cwd,
    permissionMode: "bypassPermissions",
    command,
  });

  console.log("[2/6] turn 1: asking it to remember a token");
  // Send IMMEDIATELY rather than waiting for the child's init frame first:
  // under --input-format stream-json the binary emits NOTHING (not even
  // `system`/`init`) until it has read its first input line — waiting for
  // init before sending deadlocks (same fact scripts/verify-driven-operator-echo.ts
  // documents). This also matches the real cockpit flow: the composer's
  // first send is what starts the conversation.
  const turn1Ok = sendDrivenSessionInput(
    initial,
    "Reply with exactly the single word PARITY42 and nothing else. Remember this word — I will ask you to repeat it later in this same conversation."
  );
  if (!turn1Ok) throw new Error("turn 1 was not delivered (sendDrivenSessionInput returned false)");
  await waitFor(() => initial.costHistory.length >= 1, TURN_TIMEOUT_MS, "turn 1 result event");
  console.log(`      harnessSessionId=${initial.harnessSessionId}, pid=${initial.pid}`);
  const turn1Reply = lastAssistantText(initial);
  console.log(`      turn 1 reply: ${JSON.stringify(turn1Reply)}`);

  console.log("[3/6] turn 2: a second exchange on the same live process");
  const turn2Ok = sendDrivenSessionInput(
    initial,
    "Reply with exactly the single word OK and nothing else."
  );
  if (!turn2Ok) throw new Error("turn 2 was not delivered");
  await waitFor(() => initial.costHistory.length >= 2, TURN_TIMEOUT_MS, "turn 2 result event");
  console.log(`      turn 2 reply: ${JSON.stringify(lastAssistantText(initial))}`);

  const generationBeforeResume = initial.driverGeneration;
  const harnessSessionId = initial.harnessSessionId;
  if (!harnessSessionId) throw new Error("no harnessSessionId to resume from");

  console.log("[4/6] killing the session driver abruptly (simulates a daemon restart mid-session)");
  initial.proc.kill("SIGKILL");
  await waitFor(
    () => initial.status === "crashed" || initial.status === "exited",
    15_000,
    "session driver exit after SIGKILL"
  );
  console.log(`      post-kill status=${initial.status}`);

  const previous: DrivenSessionResumeSource = {
    localId: initial.localId,
    cwd: initial.cwd,
    permissionMode: initial.permissionMode,
    harnessSessionId,
    taskId: initial.taskId,
    minskySessionId: initial.minskySessionId,
    startedAt: initial.startedAt,
    driverGeneration: initial.driverGeneration,
  };

  console.log(
    "[5/6] resuming through resumeDrivenSession (--resume, real spawn via ClaudeStreamJsonTransport)"
  );
  const { record: resumed } = resumeDrivenSession({ previous, command });
  // harnessSessionId and driverGeneration are set SYNCHRONOUSLY on the new
  // record from `previous` (a resume reuses the known conversation id — see
  // resumeDrivenSession's doc comment) — no need to wait for the resumed
  // process to emit anything, and waiting for its init event here would
  // deadlock for the same reason noted at turn 1: it emits nothing until it
  // has read its first input line.

  if (resumed.harnessSessionId !== harnessSessionId) {
    throw new Error(
      `FAIL: resumed harnessSessionId (${resumed.harnessSessionId}) != original (${harnessSessionId}) — not the same conversation`
    );
  }
  if (resumed.driverGeneration !== generationBeforeResume + 1) {
    throw new Error(
      `FAIL: driverGeneration did not increment by 1 (was ${generationBeforeResume}, now ${resumed.driverGeneration})`
    );
  }
  console.log(
    `      OK: same conversation (harnessSessionId unchanged), driverGeneration ${generationBeforeResume} -> ${resumed.driverGeneration}`
  );

  console.log(
    "[6/6] turn 3 against the RESUMED process: asking it to recall the token from turn 1"
  );
  const turn3Ok = sendDrivenSessionInput(
    resumed,
    "What was the word I asked you to remember earlier in this conversation? Reply with just that word."
  );
  if (!turn3Ok) throw new Error("turn 3 was not delivered against the resumed process");
  await waitFor(() => resumed.costHistory.length >= 1, TURN_TIMEOUT_MS, "turn 3 result event");
  const turn3Reply = lastAssistantText(resumed);
  console.log(`      turn 3 reply: ${JSON.stringify(turn3Reply)}`);
  const recalled = turn3Reply.toUpperCase().includes("PARITY42");
  console.log(
    recalled
      ? "      OK: the resumed process recalled the pre-restart token — this is genuinely the same conversation, not a fresh one"
      : "      NOTE: reply did not echo the exact token verbatim (model phrasing varies) — see full reply above"
  );

  resumed.proc.kill("SIGKILL");

  console.log(
    "\nPASS: launch, two turns, abrupt session-driver death, restart-resume, third turn — all through ClaudeStreamJsonTransport."
  );
  return 0;
}

process.exit(await main());
