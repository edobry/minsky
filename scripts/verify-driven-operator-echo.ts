#!/usr/bin/env bun
/**
 * Live verification for mt#3372 — the operator's own turn reaches the driven
 * session's event log.
 *
 * Spawns a REAL `claude` driven session through the production host module
 * (`src/cockpit/driven-session-host.ts` — no fake spawnFn, no fixture stream),
 * sends one operator message through the same `sendDrivenSessionInput` path the
 * cockpit composer uses, and asserts that:
 *
 *   1. a `minsky_operator_input` frame carrying the operator's text lands in
 *      the record's event log, and
 *   2. it is ordered BEFORE the assistant frames it prompted — the property the
 *      unit tests assert against synthetic frames, checked here against what the
 *      real binary actually emits.
 *
 * Why this exists as a script and not only as a unit test: the whole defect was
 * a wrong belief about what the real binary puts on stdout. Every unit test in
 * this area feeds the reducer frames WE wrote, so none of them can falsify that
 * belief. This one runs the real thing.
 *
 * Gated on the `claude` binary being present and runnable; skips cleanly
 * (exit 0) when it is not, per the §7a artifact contract.
 *
 * Usage: bun scripts/verify-driven-operator-echo.ts
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  startDrivenSession,
  sendDrivenSessionInput,
  stopDrivenSession,
  DrivenSessionRegistry,
  DRIVEN_OPERATOR_INPUT_EVENT_TYPE,
  type DrivenSessionRecord,
} from "../src/cockpit/driven-session-host";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const OPERATOR_TEXT = "reply with the single word ACK and nothing else";
const TURN_TIMEOUT_MS = 90_000;
const POLL_MS = 250;

function resolveClaudeBinary(): string | null {
  // PATH first — a fixed candidate list silently skips any install location we
  // did not think of, which on this script's skip-on-absent contract reads as
  // "no binary" rather than "looked in the wrong places" (PR #2433 R1).
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

function frameTypes(record: DrivenSessionRecord): string[] {
  return record.eventLog.map((e) => String(e.payload["type"]));
}

async function main(): Promise<number> {
  const command = resolveClaudeBinary();
  if (!command) {
    console.log(
      "SKIP: no `claude` binary found on any known path — cannot exercise the live path."
    );
    return 0;
  }

  const cwd = mkdtempSync(join(tmpdir(), "driven-operator-echo-"));
  const registry = new DrivenSessionRegistry();
  const { record } = startDrivenSession({ cwd, command, registry });
  console.log(`spawned driven session ${record.localId} (cwd ${cwd})`);

  try {
    // Send immediately rather than waiting for the child's `init` frame: under
    // `--input-format stream-json` the binary emits nothing until it has read
    // its first input line, so waiting for init before sending deadlocks. This
    // also matches the real cockpit flow, where the composer's first send is
    // what starts the conversation.
    const accepted = sendDrivenSessionInput(record, OPERATOR_TEXT);
    if (!accepted) throw new Error("sendDrivenSessionInput refused the write");

    await waitFor(
      () => record.eventLog.some((e) => e.payload["type"] === "result"),
      TURN_TIMEOUT_MS,
      "the turn's terminal result frame"
    );

    const types = frameTypes(record);
    const echoIndex = types.indexOf(DRIVEN_OPERATOR_INPUT_EVENT_TYPE);
    const assistantIndex = types.indexOf("assistant");
    const echoFrame = record.eventLog[echoIndex]?.payload;

    console.log(`frame sequence: ${types.join(" -> ")}`);

    const failures: string[] = [];
    if (echoIndex === -1) {
      failures.push(`no ${DRIVEN_OPERATOR_INPUT_EVENT_TYPE} frame in the event log`);
    }
    if (echoFrame && echoFrame["text"] !== OPERATOR_TEXT) {
      failures.push(`echo frame text mismatch: ${JSON.stringify(echoFrame["text"])}`);
    }
    if (assistantIndex !== -1 && echoIndex !== -1 && echoIndex > assistantIndex) {
      failures.push(
        `echo frame at ${echoIndex} is ordered AFTER the assistant frame at ${assistantIndex}`
      );
    }
    // The belief this whole task rests on: the binary itself emits no echo.
    // If a future CLI version starts echoing, the view would double-render and
    // this is where we would find out.
    const binaryUserFrames = record.eventLog.filter(
      (e) => e.payload["type"] === "user" && JSON.stringify(e.payload).includes(OPERATOR_TEXT)
    );
    if (binaryUserFrames.length > 0) {
      failures.push(
        `the binary ALSO echoed the input as ${binaryUserFrames.length} \`user\` frame(s) — ` +
          `the host-side echo would now double-render; revisit mt#3372's premise`
      );
    }

    if (failures.length > 0) {
      for (const f of failures) console.error(`FAIL: ${f}`);
      return 1;
    }

    console.log(`PASS: operator turn present at index ${echoIndex}, text verbatim, ordered first.`);
    return 0;
  } finally {
    stopDrivenSession(record, { graceMs: 1000 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`FAIL: ${getLoggableErrorSummary(err)}`);
    process.exit(1);
  });
