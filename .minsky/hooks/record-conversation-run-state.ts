#!/usr/bin/env bun
// Run-state writer: forward one observed harness event to the cockpit daemon.
//
// Registered under every event in OBSERVED_HOOK_EVENTS (see
// packages/domain/src/conversation-run-state/event-mapping.ts). ONE script for
// all of them — it branches on `hook_event_name` from the payload rather than
// shipping a file per event.
//
// FAIL-OPEN CONTRACT (non-negotiable — mt#3130's risk gate):
//   `.claude/settings.json` and `.claude/hooks/` are git-tracked, so a bug here
//   propagates to every dispatched-subagent workspace in the fleet on merge.
//   This hook must NEVER block, delay, or fail a turn. Every path exits 0,
//   including malformed stdin, a missing token, an unreachable daemon, and a
//   timeout. A conversation whose events don't land degrades to UNKNOWN in the
//   cockpit — which is exactly what that vocabulary value exists for.
//
// WHY HTTP AND NOT A DIRECT DB WRITE:
//   Measured from a cold hook process (what the harness spawns per event):
//   direct-to-Postgres (domain bootstrap + connect) ~695ms vs ~20ms for this
//   POST. `record-subagent-invocation.ts` can afford the former because
//   SubagentStop fires once per subagent; `PreToolUse` fires on every tool call
//   in every conversation fleet-wide, so it cannot.
//
// This hook deliberately imports NOTHING from the domain layer — no persistence
// reach, so no `ensureHookDomainBootstrap` (and no `custom/require-hook-domain-
// bootstrap` obligation). It stays self-contained per .minsky/hooks/SPEC.md's
// invariant that hooks keep working even when the main codebase has type errors.
//
// @see mt#3161 — this file (mt#3130 Phase 1)
// @see src/cockpit/routes/conversation-run-state.ts — the ingest endpoint

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readInput } from "./types";
import type { ClaudeHookInput } from "./types";

/**
 * Total budget for the whole forward. Deliberately far tighter than
 * `record-subagent-invocation.ts`'s 8s: that hook runs once per subagent, this
 * one runs on every tool call, so its worst case is paid by every turn in the
 * fleet. A daemon that cannot answer in this window is treated as down.
 */
export const RUN_STATE_POST_TIMEOUT_MS = 500;

/** Fallback when no cockpit state file names a live port (ADR-014: `:3737`). */
export const DEFAULT_COCKPIT_ORIGIN = "http://127.0.0.1:3737";

/** Env var naming an explicit cockpit origin (tests, non-default ports). */
export const COCKPIT_URL_ENV = "MINSKY_COCKPIT_URL";

/** Env var overriding the Minsky state dir. */
export const STATE_DIR_ENV = "MINSKY_STATE_DIR";

/**
 * The filesystem + environment surface this module reads.
 *
 * Injected rather than reached for directly so the unit tests exercise the real
 * resolution LOGIC against in-memory fakes — no temp dirs, no `process.env`
 * mutation, and therefore no cross-test races. `readFile`/`readDir` throw on a
 * missing path, mirroring the `node:fs` sync API they wrap, because "absent" is
 * a case every caller here already handles.
 */
export interface RunStateIo {
  readFile(filePath: string): string;
  readDir(dirPath: string): string[];
  env: Record<string, string | undefined>;
}

/** The real, process-bound IO surface. */
export const REAL_IO: RunStateIo = {
  readFile: (filePath) => fs.readFileSync(filePath, { encoding: "utf-8" }),
  readDir: (dirPath) => fs.readdirSync(dirPath),
  env: process.env,
};

/** Resolve the Minsky state dir — same precedence as the sibling hook stores. */
export function getStateDir(io: RunStateIo = REAL_IO): string {
  const override = io.env[STATE_DIR_ENV];
  if (override) return override;
  const xdgStateHome =
    io.env["XDG_STATE_HOME"] || path.join(io.env["HOME"] || os.homedir(), ".local/state");
  return path.join(xdgStateHome, "minsky");
}

/**
 * Resolve the cockpit origin to post to.
 *
 * Precedence:
 *   1. `MINSKY_COCKPIT_URL` — explicit override.
 *   2. A cockpit state file's recorded `url`. Files live at
 *      `<stateDir>/cockpit/<workspace-key>.json` (lifecycle.ts); `main` is
 *      preferred because the supervising daemon normally runs from the main
 *      workspace, with any other file accepted as a fallback so a
 *      per-workspace cockpit still receives its own events.
 *   3. {@link DEFAULT_COCKPIT_ORIGIN}.
 *
 * Never throws — an unreadable or malformed state dir falls through to the
 * default, and a wrong guess simply means the POST fails and is dropped.
 */
export function resolveCockpitOrigin(io: RunStateIo = REAL_IO): string {
  const override = io.env[COCKPIT_URL_ENV];
  if (override) return override;

  try {
    const cockpitDir = path.join(getStateDir(io), "cockpit");
    const entries = io.readDir(cockpitDir).filter((f) => f.endsWith(".json"));
    const preferred = entries.includes("main.json")
      ? ["main.json", ...entries.filter((f) => f !== "main.json")]
      : entries;
    for (const entry of preferred) {
      try {
        const parsed = JSON.parse(io.readFile(path.join(cockpitDir, entry))) as {
          url?: unknown;
        };
        if (typeof parsed.url === "string" && parsed.url.length > 0) return parsed.url;
      } catch {
        // Malformed/partially-written state file — try the next one.
      }
    }
  } catch {
    // No state dir at all — fall through.
  }
  return DEFAULT_COCKPIT_ORIGIN;
}

/**
 * Read the cockpit bearer token.
 *
 * The ingest endpoint is NOT exempt from `mutationAuthMiddleware`, so this is
 * required for the POST to be accepted. Returns null when absent or
 * non-canonical — the caller then skips the POST entirely rather than issuing a
 * request that will 401.
 *
 * The token value is never logged, echoed, or interpolated into any output.
 */
export function readCockpitToken(io: RunStateIo = REAL_IO): string | null {
  try {
    const token = io.readFile(path.join(getStateDir(io), "cockpit-token")).trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Per-field ceiling applied to the forwarded payload.
 *
 * Every field `event-mapping.ts` actually reads is a short scalar string
 * (`prompt_id`, `tool_name`, `error_type`, `error_message`, `type`, `trigger`,
 * `reason`), so this ceiling is orders of magnitude above anything consumed
 * while cutting the fields that are not: `tool_response` on a `PostToolUse`
 * routinely runs to megabytes.
 */
export const MAX_PAYLOAD_FIELD_CHARS = 4096;

/**
 * Ceiling for the whole serialized body, held below the daemon's accepted
 * `express.json` limit so a payload of many mid-sized fields cannot sum past it
 * even when no single field trips {@link MAX_PAYLOAD_FIELD_CHARS}.
 */
export const MAX_BODY_CHARS = 64 * 1024;

/** Marker replacing an oversized non-string value; carries the dropped size. */
interface TruncationMarker {
  __truncated: true;
  chars: number;
}

function truncationMarker(chars: number): TruncationMarker {
  return { __truncated: true, chars };
}

/**
 * Bound the payload by SIZE, never by field name.
 *
 * Deliberately generic: `buildIngestBody`'s contract is that the event -> column
 * mapping stays server-side so revising it never requires redistributing hooks
 * across the fleet. An allowlist of the keys `event-mapping.ts` happens to read
 * today would move field selection into the hook and break exactly that
 * property, so this bounds by size and lets the server keep choosing.
 *
 * Oversized strings are truncated in place (keeping the type, so a consumer's
 * `typeof value === "string"` test still passes); oversized non-strings become a
 * {@link TruncationMarker}, which reads as absent to the server's string-typed
 * accessors rather than as a plausible value.
 */
export function boundPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") {
      bounded[key] =
        value.length > MAX_PAYLOAD_FIELD_CHARS
          ? `${value.slice(0, MAX_PAYLOAD_FIELD_CHARS)}…[truncated ${value.length - MAX_PAYLOAD_FIELD_CHARS} chars]`
          : value;
      continue;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value) ?? "";
    } catch {
      // A cyclic or otherwise unserializable value would make the whole body
      // unsendable; drop it to a marker rather than lose the event.
      bounded[key] = truncationMarker(-1);
      continue;
    }
    bounded[key] =
      serialized.length > MAX_PAYLOAD_FIELD_CHARS ? truncationMarker(serialized.length) : value;
  }

  // Second pass: even all-small fields can sum past the body ceiling. Drop the
  // largest remaining fields until the body fits. Consumed fields are short, so
  // they are the last things standing.
  let entries = Object.entries(bounded);
  while (
    entries.length > 0 &&
    JSON.stringify(Object.fromEntries(entries)).length > MAX_BODY_CHARS
  ) {
    let largestIndex = 0;
    let largestSize = -1;
    for (let i = 0; i < entries.length; i++) {
      const size = (JSON.stringify(entries[i]?.[1]) ?? "").length;
      if (size > largestSize) {
        largestSize = size;
        largestIndex = i;
      }
    }
    const [droppedKey] = entries[largestIndex] ?? [];
    entries = entries.filter((_, i) => i !== largestIndex);
    if (droppedKey !== undefined) entries.push([droppedKey, truncationMarker(largestSize)]);
    // The marker is smaller than anything it replaces, so this terminates.
    if (largestSize <= JSON.stringify(truncationMarker(0)).length) break;
  }

  return Object.fromEntries(entries);
}

/**
 * Build the ingest body from a harness payload.
 *
 * `observedAt` is stamped HERE, at observation time, so that queueing or retry
 * latency between the hook and the daemon cannot backdate the liveness
 * heartbeat the absence-detection sweep reads.
 *
 * The payload is forwarded whole but SIZE-BOUNDED (see {@link boundPayload}):
 * the event -> column mapping stays server-side (event-mapping.ts) so revising
 * it never requires recompiling and redistributing hooks across the fleet, and
 * the bound is by size rather than by key so that property survives.
 *
 * Returns null when the payload lacks the two fields that make it addressable.
 */
export function buildIngestBody(
  input: ClaudeHookInput,
  observedAt: Date
): Record<string, unknown> | null {
  if (!input?.session_id || !input?.hook_event_name) return null;
  return {
    conversationId: input.session_id,
    eventName: input.hook_event_name,
    observedAt: observedAt.toISOString(),
    cwd: input.cwd ?? null,
    payload: boundPayload({ ...input } as Record<string, unknown>),
  };
}

/** Post the body, bounded. Resolves to true only on a 2xx. Never throws. */
export async function postRunState(
  origin: string,
  token: string,
  body: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await fetch(`${origin.replace(/\/$/, "")}/api/conversation-run-state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RUN_STATE_POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // A PRESENT daemon that REJECTED us is a different condition from an
      // absent one, and collapsing the two is why an unbounded payload went
      // unnoticed: every large PostToolUse was rejected 413 and dropped as
      // though the daemon were down. Still fail-open — one stderr line, no
      // throw, no retry, turn unaffected — but no longer silent.
      process.stderr.write(
        `record-conversation-run-state: daemon rejected event (HTTP ${res.status})\n`
      );
    }
    return res.ok;
  } catch {
    // Daemon down, timed out, connection refused — all the same to us: drop it.
    // Deliberately NOT logged: an absent daemon is the expected steady state
    // whenever the cockpit isn't running, and a line per tool call would be
    // pure noise.
    return false;
  }
}

if (import.meta.main) {
  try {
    const input = await readInput<ClaudeHookInput>();
    const body = buildIngestBody(input, new Date());
    if (body) {
      const token = readCockpitToken();
      if (token) await postRunState(resolveCockpitOrigin(), token, body);
    }
  } catch {
    // readInput throws on malformed stdin. Swallowed deliberately: a non-zero
    // exit from a hook is exactly what blocks the event it observes.
  }
  process.exit(0);
}
