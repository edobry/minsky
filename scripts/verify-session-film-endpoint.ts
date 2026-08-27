#!/usr/bin/env bun
/**
 * Live-verify the session-film event endpoint against a real ingested
 * conversation (mt#3184 — the sandbox this task was implemented in has no
 * DB access, so this script is the main agent's post-PR verification step).
 *
 * Gates cleanly (exit 0, SKIP) when no Postgres connection is available,
 * matching the other DB-backed scripts in this directory (see
 * `scripts/export-gource-log.ts`'s precedent).
 *
 * Usage:
 *   bun scripts/verify-session-film-endpoint.ts [conversationId] [--port N]
 *   bun scripts/verify-session-film-endpoint.ts [conversationId] [--base-url http://host:port]
 *
 * With no `conversationId`, walks the most-recently-ingested conversations
 * (up to MAX_CANDIDATES) until one yields events — a listed conversation can
 * legitimately have none, so a single empty candidate is not a verdict on the
 * endpoint. Everything goes through the events endpoint's own DB path, NOT a
 * raw query, so this exercises the exact same code the cockpit route uses.
 *
 * A run only SKIPs when the daemon is unreachable or the corpus is genuinely
 * empty. With a non-empty corpus and no readable film it FAILS — reporting
 * "nothing to verify" there is what let this script verify nothing from
 * mt#3268 until mt#4188 (its selector keyed on `scrubGateOk`, a field ADR-040
 * removed from the row, so `find` matched nothing on every run).
 *
 * What it asserts:
 *   1. GET /api/cockpit/session-film/sessions returns a non-empty list.
 *   2. GET /api/cockpit/session-film/events?conversationId=<id> returns 200
 *      with a non-empty `events` array for at least one listed conversation.
 *   3. The returned events are ORDERED (non-decreasing `tStart`, allowing
 *      ties within a parallel batch).
 *   4. Every event has the expected SemanticEvent shape (schemaVersion,
 *      actor.kind, verb, target.realm/id, adapterVersion).
 *
 * This script does NOT start a server itself — point it at an already-running
 * cockpit daemon (`bun src/cli.ts cockpit start`). `--port N` (default 3737,
 * matching the daemon's own default — see `src/commands/cockpit/start-
 * command.ts`'s `DEFAULT_PORT`) builds `http://127.0.0.1:<port>`; `--base-url
 * <url>` overrides the whole base URL (host/protocol included) and takes
 * precedence over `--port` when both are given. A plain CLI flag is used
 * instead of a `MINSKY_*` env var so this override needs no entry in the
 * `no-unregistered-minsky-env-var`-enforced environment-mappings registry
 * (mt#3188).
 */

import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
interface SessionRow {
  agentSessionId: string;
  label: string;
  /**
   * Sort key for candidate selection. This used to be `scrubGateOk`, which
   * ADR-040 / mt#3268 removed from the route's row along with the gate itself
   * ("`scrubGateOk`, the picker's disabled rows and refusal copy … all go").
   * The selector kept testing it, so `find` returned undefined on every row and
   * the script SKIPped every no-argument run while the endpoint was healthy —
   * it verified nothing from mt#3268 until mt#4188. Key selection on a field
   * the route actually returns.
   */
  ingestedAt: string | null;
}

/**
 * How many recent conversations to try before giving up. A conversation can be
 * listed and still yield no events (pre-adapter ingest, windowed-out lines), so
 * one candidate is not a verdict on the endpoint — mirrors
 * `verify-session-film-panes.ts`'s MAX_CANDIDATES for the same reason.
 */
const MAX_CANDIDATES = 6;

interface SemanticEventShape {
  schemaVersion: string;
  tStart: string;
  actor: { kind: string };
  verb: string;
  target: { realm: string; id: string };
  adapterVersion: string;
}

/** Matches the cockpit daemon's own default (`DEFAULT_PORT` in `src/commands/cockpit/start-command.ts`). */
const DEFAULT_PORT = 3737;

const USAGE =
  "Usage: bun scripts/verify-session-film-endpoint.ts [conversationId] [--port N] [--base-url http://host:port]";

/** Prints a usage error + the usage line, then exits with code 2 (distinct from the assertion-failure exit code 1). */
function usageError(message: string): never {
  console.error(`USAGE ERROR: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): {
  conversationId: string | undefined;
  port: number;
  baseUrl: string | undefined;
} {
  let conversationId: string | undefined;
  let port = DEFAULT_PORT;
  let baseUrl: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const next = argv[i + 1];
      if (!next) usageError("--port requires a value.");
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        usageError(`--port must be an integer between 1 and 65535, got "${next}".`);
      }
      port = parsed;
      i++;
    } else if (arg === "--base-url") {
      const next = argv[i + 1];
      if (!next) usageError("--base-url requires a value.");
      try {
        const parsedUrl = new URL(next);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          usageError(`--base-url must use http:// or https://, got "${next}".`);
        }
      } catch {
        usageError(`--base-url is not a valid URL: "${next}".`);
      }
      baseUrl = next;
      i++;
    } else if (arg && !arg.startsWith("--")) {
      conversationId = arg;
    }
  }
  return { conversationId, port, baseUrl };
}

type VerifyOutcome =
  | { kind: "pass"; count: number; ingestedAt: string | null }
  | { kind: "no-events" }
  | { kind: "fail"; reason: string };

/**
 * Assert the events endpoint's contract for ONE conversation.
 *
 * Returns an outcome rather than exiting, so the caller can distinguish the two
 * cases that used to be conflated: `no-events` is a property of THAT
 * conversation (it can be listed and still have nothing the adapter emitted),
 * so the caller tries the next candidate; `fail` is a property of the ENDPOINT
 * and stops the run.
 */
async function verifyConversation(base: string, row: SessionRow): Promise<VerifyOutcome> {
  const res = await fetch(
    `${base}/api/cockpit/session-film/events?conversationId=${encodeURIComponent(row.agentSessionId)}`
  );
  if (!res.ok) {
    return { kind: "fail", reason: `/events returned HTTP ${res.status}: ${await res.text()}` };
  }

  const body = (await res.json()) as { events: SemanticEventShape[]; ingestedAt: string | null };
  const events = body.events;
  if (events.length === 0) return { kind: "no-events" };

  let prevT = -Infinity;
  for (const [i, event] of events.entries()) {
    if (typeof event.schemaVersion !== "string" || typeof event.verb !== "string") {
      return {
        kind: "fail",
        reason: `event[${i}] missing expected SemanticEvent fields: ${JSON.stringify(event)}`,
      };
    }
    if (
      !event.target ||
      typeof event.target.realm !== "string" ||
      typeof event.target.id !== "string"
    ) {
      return {
        kind: "fail",
        reason: `event[${i}] missing target.realm/id: ${JSON.stringify(event)}`,
      };
    }
    const t = Date.parse(event.tStart);
    if (Number.isNaN(t)) {
      return { kind: "fail", reason: `event[${i}] has an unparsable tStart: ${event.tStart}` };
    }
    if (t < prevT) {
      return {
        kind: "fail",
        reason: `events are not ordered — event[${i}].tStart (${event.tStart}) precedes a prior event's tStart.`,
      };
    }
    prevT = t;
  }

  return { kind: "pass", count: events.length, ingestedAt: body.ingestedAt };
}

async function main(): Promise<void> {
  const { conversationId: explicitId, port, baseUrl } = parseArgs(process.argv.slice(2));
  const base = baseUrl ?? `http://127.0.0.1:${port}`;

  console.error(`Probing ${base}/api/cockpit/session-film/sessions ...`);
  let sessionsRes: Response;
  try {
    sessionsRes = await fetch(`${base}/api/cockpit/session-film/sessions`);
  } catch (err) {
    console.error(`SKIP: could not reach cockpit daemon at ${base} (${String(err)}).`);
    process.exit(0);
  }

  if (!sessionsRes.ok) {
    console.error(`FAIL: /sessions returned HTTP ${sessionsRes.status}`);
    process.exit(1);
  }

  const sessionsBody = (await sessionsRes.json()) as { sessions: SessionRow[] };
  if (sessionsBody.sessions.length === 0) {
    console.error("SKIP: no ingested sessions found (empty picker list) — nothing to verify.");
    process.exit(0);
  }

  let candidates: SessionRow[];
  if (explicitId) {
    const requested = sessionsBody.sessions.find((s) => s.agentSessionId === explicitId);
    if (!requested) {
      // Previously this fell through to the auto-selector and verified some
      // OTHER conversation — a pass reported for something nobody asked about.
      console.error(
        `FAIL: conversationId=${explicitId} was requested but /sessions does not list it ` +
          `(${sessionsBody.sessions.length} listed).`
      );
      process.exit(1);
    }
    candidates = [requested];
  } else {
    candidates = [...sessionsBody.sessions]
      .sort((a, b) => String(b.ingestedAt ?? "").localeCompare(String(a.ingestedAt ?? "")))
      .slice(0, MAX_CANDIDATES);
  }

  const emptied: string[] = [];
  for (const row of candidates) {
    console.error(`Verifying conversationId=${row.agentSessionId} ("${row.label}") ...`);
    const outcome = await verifyConversation(base, row);

    if (outcome.kind === "pass") {
      console.error(
        `PASS: ${outcome.count} ordered SemanticEvent(s) returned for ` +
          `conversationId=${row.agentSessionId} (ingestedAt=${outcome.ingestedAt ?? "null"}).`
      );
      return;
    }
    if (outcome.kind === "fail") {
      console.error(`FAIL: ${outcome.reason}`);
      process.exit(1);
    }

    emptied.push(row.agentSessionId);
    console.error(`  no events for ${row.agentSessionId} — trying the next candidate`);
  }

  // Deliberately FAIL, not SKIP: /sessions listed a non-empty corpus, so
  // "nothing to verify" is not an honest description of this state.
  console.error(
    `FAIL: none of the ${candidates.length} candidate conversation(s) returned any events ` +
      `(tried ${emptied.join(", ")}), though /sessions listed ${sessionsBody.sessions.length}.`
  );
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(getLoggableErrorSummary(err));
    process.exit(1);
  });
}
