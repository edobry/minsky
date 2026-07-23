#!/usr/bin/env bun
// Verification artifact for mt#3066 — does the unasked-direction scan resolve a
// transcript when given the id PRODUCTION supplies?
//
// This is the check mt#3046 got wrong, and the reason mt#3066 exists. That
// task's verification called `loadTranscript` with a CONVERSATION id chosen by
// hand — the input that makes the function return data — while the hook in
// production passed a WORKSPACE session id read out of the `session_pr_merge`
// payload. The repaired function was proven to work on an input the caller
// never provides, so the scan stayed dead and the fix was reported as landed.
//
// So this script deliberately does NOT let the operator hand it a working id.
// It builds a `session_pr_merge`-shaped `ToolHookInput` — a real workspace
// session id in `tool_input`, the harness conversation id in `session_id` —
// runs the hook's OWN exported `resolveConversationId` + `loadTranscript` over
// it (not a re-implementation of their import sequence), and asserts the
// transcript comes back non-null. The workspace id is present in the payload
// throughout precisely so that a regression to the old lookup key fails here.
//
// Read-only: it performs no writes.
//
// Usage:  bun scripts/verify-unasked-direction-scan-lookup.ts <conversationId> [workspaceId]
//         bun scripts/verify-unasked-direction-scan-lookup.ts   (uses $CLAUDE_SESSION_ID)
// Exit:   0 = pass (or SKIP when no DB / no conversation id), non-zero = fail.
//
// @see mt#3066 — the id-space defect this proves fixed
// @see mt#3046 — the verification gap that let it ship
// @see .minsky/hooks/post-merge-unasked-direction-scan.ts — the code under test

import {
  loadTranscript,
  resolveConversationId,
  resolveSessionContext,
} from "../.minsky/hooks/post-merge-unasked-direction-scan";
import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";
import type { ToolHookInput } from "../.minsky/hooks/types";

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

const steps: Step[] = [];
let failed = false;

function record(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  if (!ok) failed = true;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}\n`);
}

function skip(reason: string): never {
  process.stdout.write(`SKIP: ${reason}\n`);
  process.exit(0);
}

// Gate on the REAL bootstrap, not on env vars. Minsky's Postgres DSN lives in
// `~/.config/minsky/config.yaml`, so an env-var-only gate (`DATABASE_URL` etc.)
// SKIPs unconditionally on a correctly-configured machine — a check that always
// skips is the same false-green shape this task is about.
const bootstrap = await ensureHookDomainBootstrap();
if (!bootstrap.ok) {
  skip(`domain bootstrap unavailable: ${bootstrap.error}`);
}

const conversationId = process.argv[2] ?? process.env.CLAUDE_SESSION_ID;
if (!conversationId) {
  skip("no conversation id given (pass one as argv[2] or set CLAUDE_SESSION_ID)");
}

// A workspace-shaped id that must NEVER be used as the lookup key. Any value
// works — the point is that it is present in the payload, where the pre-mt#3066
// code read it from.
const workspaceId = process.argv[3] ?? "00000000-0000-0000-0000-000000000000";

const payload: ToolHookInput = {
  session_id: conversationId,
  cwd: process.cwd(),
  hook_event_name: "PostToolUse",
  tool_name: "mcp__minsky__session_pr_merge",
  tool_input: { sessionId: workspaceId, task: "mt#3066" },
  tool_result: { session: { sessionId: workspaceId, taskId: "mt#3066" } },
} as ToolHookInput;

// 1. The hook still resolves the workspace context (findings key / analyzer label).
const ctx = resolveSessionContext(payload);
record(
  "resolveSessionContext returns the workspace session id",
  ctx?.sessionId === workspaceId,
  `sessionId=${ctx?.sessionId ?? "null"} taskId=${ctx?.taskId ?? "none"}`
);

// 2. The transcript key comes from the harness field, not the payload.
const resolved = resolveConversationId(payload);
record(
  "resolveConversationId returns the harness conversation id, not the workspace id",
  resolved === conversationId && resolved !== workspaceId,
  `conversationId=${resolved ?? "null"} (workspace id in payload: ${workspaceId})`
);

// 3. The lookup that was dead: it must resolve for the id production supplies.
const transcript = resolved ? await loadTranscript(resolved) : null;
record(
  "loadTranscript resolves a stored transcript for that conversation id",
  Array.isArray(transcript) && transcript.length > 0,
  transcript === null
    ? "null — the conversation is not ingested yet, or the lookup is still broken"
    : `${transcript.length} message(s)`
);

// 4. The negative control: the OLD key must NOT resolve. If a workspace id ever
//    starts resolving, the premise of this fix changed and the check should be
//    re-derived rather than silently passing.
const oldKeyResult = await loadTranscript(workspaceId as never);
record(
  "the pre-fix lookup key (workspace session id) still does NOT resolve",
  oldKeyResult === null,
  oldKeyResult === null
    ? "null, as expected — confirms the two id spaces are still distinct"
    : `unexpectedly returned ${Array.isArray(oldKeyResult) ? oldKeyResult.length : "?"} message(s)`
);

process.stdout.write(`\n${steps.filter((s) => s.ok).length}/${steps.length} checks passed\n`);
process.exit(failed ? 1 : 0);
