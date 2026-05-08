#!/usr/bin/env bun
/**
 * smoke-mcp-disconnect.ts — Verification script for MCP disconnect tracking (mt#1645)
 *
 * Exercises the DisconnectTracker in-memory API to confirm:
 *   1. recordDisconnect emits a structurally correct event
 *   2. recordReconnect emits a structurally correct event
 *   3. getSummary returns correct 24h counts and escalation signal
 *   4. The persistent event log at ~/.local/state/minsky/mcp-disconnect-log.json
 *      is created and contains valid JSON when a real path is used
 *
 * Usage:
 *   bun scripts/smoke-mcp-disconnect.ts
 *
 * Exit codes:
 *   0 = all assertions passed
 *   1 = one or more assertions failed
 *
 * No external services required; no side effects on the production log file
 * (the script uses a temporary file and cleans up on exit).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { DisconnectTracker } from "../src/mcp/disconnect-tracker";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`         expected: ${JSON.stringify(expected)}`);
    console.error(`         actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// -------------------------------------------------------------------------
// Test setup: temp file for persistence round-trip
// -------------------------------------------------------------------------

const tmpLog = path.join(os.tmpdir(), `smoke-mcp-disconnect-${Date.now()}.json`);

function cleanup(): void {
  try {
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  } catch {
    // ignore cleanup errors
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

// -------------------------------------------------------------------------
// Suite 1: In-memory tracker (no file I/O)
// -------------------------------------------------------------------------

console.log("\nSuite 1: In-memory tracker");

const tracker = DisconnectTracker.resetForTest("minsky", "");

// Record one disconnect
const disconnectEvent = tracker.recordDisconnect("stdin_close");
assert(disconnectEvent.kind === "disconnect", "recordDisconnect kind=disconnect");
assert(disconnectEvent.cause === "stdin_close", "recordDisconnect cause=stdin_close");
assert(disconnectEvent.serverName === "minsky", "recordDisconnect serverName=minsky");
assert(typeof disconnectEvent.timestamp === "string", "recordDisconnect timestamp is string");
assert(disconnectEvent.error === undefined, "recordDisconnect no error when not provided");

// Record a disconnect with an error message
const errEvent = tracker.recordDisconnect("transport_error", "EPIPE");
assert(errEvent.error === "EPIPE", "recordDisconnect includes error message");

// Record a reconnect
const reconnectEvent = tracker.recordReconnect();
assert(reconnectEvent.kind === "reconnect", "recordReconnect kind=reconnect");
assert(reconnectEvent.serverName === "minsky", "recordReconnect serverName=minsky");

// Record a transport error
const transportErrEvent = tracker.recordTransportError("ECONNRESET");
assert(transportErrEvent.kind === "transport_error", "recordTransportError kind=transport_error");
assert(transportErrEvent.error === "ECONNRESET", "recordTransportError includes error");

// Summary verification
const summary = tracker.getSummary();
assert(summary.count24h === 2, "getSummary count24h = 2 disconnects");
assert(summary.reconnects24h === 1, "getSummary reconnects24h = 1");
assert(summary.byKind.disconnect === 2, "byKind.disconnect = 2");
assert(summary.byKind.reconnect === 1, "byKind.reconnect = 1");
assert(summary.byKind.transport_error === 1, "byKind.transport_error = 1");
assert(summary.byServer["minsky"] === 4, "byServer[minsky] = 4 (all events)");
assert(summary.last !== null, "getSummary.last is not null");
assert(summary.last?.kind === "transport_error", "getSummary.last is the most recent event");

// Escalation: 2 session disconnects > threshold of 1 → "session"
assert(summary.escalation === "session", "escalation='session' after 2 session disconnects");

// Session disconnect count
assertEq(tracker.getSessionDisconnectCount(), 2, "getSessionDisconnectCount() = 2");

// -------------------------------------------------------------------------
// Suite 2: Escalation thresholds
// -------------------------------------------------------------------------

console.log("\nSuite 2: Escalation thresholds");

const thresholdTracker = DisconnectTracker.resetForTest("minsky", "");

// Exactly 1 disconnect — below session threshold (>1)
thresholdTracker.recordDisconnect("stdin_close");
assertEq(thresholdTracker.getSummary().escalation, "none", "escalation=none at 1 disconnect");

// 2nd disconnect — exceeds session threshold
thresholdTracker.recordDisconnect("unknown");
assertEq(
  thresholdTracker.getSummary().escalation,
  "session",
  "escalation=session at 2 disconnects"
);

// Simulate >3 in 24h to hit daily threshold
const dailyTracker = DisconnectTracker.resetForTest("minsky", "");
for (let i = 0; i < 4; i++) {
  dailyTracker.recordDisconnect("stdin_close");
}
// Reset session count to 1 so only daily threshold fires
dailyTracker.setSessionDisconnectCountForTest(1);
assertEq(dailyTracker.getSummary().escalation, "daily", "escalation=daily at 4 disconnects/24h");

// -------------------------------------------------------------------------
// Suite 3: Persistence round-trip
// -------------------------------------------------------------------------

console.log("\nSuite 3: Persistence round-trip");

const persistTracker = DisconnectTracker.resetForTest("minsky-hosted", tmpLog);
persistTracker.recordDisconnect("signal");
persistTracker.recordReconnect();

// Verify file was created
assert(fs.existsSync(tmpLog), "event log file created on disk");

// Verify the file is valid JSON
let parsedOk = false;
let parsedEvents: unknown[] = [];
try {
  const raw = fs.readFileSync(tmpLog, { encoding: "utf-8" });
  parsedEvents = JSON.parse(raw as string) as unknown[];
  parsedOk = true;
} catch {
  parsedOk = false;
}
assert(parsedOk, "event log file contains valid JSON");
assert(Array.isArray(parsedEvents) && parsedEvents.length === 2, "event log has 2 entries");

// Load a fresh tracker from the same file — should restore events
const loadedTracker = new DisconnectTracker("minsky-hosted", tmpLog);
assert(loadedTracker.getEvents().length === 2, "loaded tracker restores 2 events from disk");

// -------------------------------------------------------------------------
// Summary
// -------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Smoke test: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All assertions passed.");
  process.exit(0);
}
