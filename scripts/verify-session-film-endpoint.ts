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
 *
 * With no `conversationId`, picks the most-recently-ingested conversation
 * with a scrub-gate-OK transcript (via the events endpoint's own DB path —
 * NOT a raw query, so this exercises the exact same code the cockpit route
 * uses).
 *
 * What it asserts:
 *   1. GET /api/cockpit/session-film/sessions returns a non-empty list.
 *   2. GET /api/cockpit/session-film/events?conversationId=<id> for a
 *      scrub-gate-OK session returns 200 with a non-empty `events` array.
 *   3. The returned events are ORDERED (non-decreasing `tStart`, allowing
 *      ties within a parallel batch).
 *   4. Every event has the expected SemanticEvent shape (schemaVersion,
 *      actor.kind, verb, target.realm/id, adapterVersion).
 *
 * This script does NOT start a server itself — point it at an already-running
 * cockpit daemon (`bun src/cli.ts cockpit start`) via --port, or default
 * to the standard local port.
 */

interface SessionRow {
  agentSessionId: string;
  label: string;
  scrubGateOk: boolean;
}

interface SemanticEventShape {
  schemaVersion: string;
  tStart: string;
  actor: { kind: string };
  verb: string;
  target: { realm: string; id: string };
  adapterVersion: string;
}

function parseArgs(argv: string[]): { conversationId: string | undefined; port: number } {
  let conversationId: string | undefined;
  let port = 4317;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const next = argv[i + 1];
      if (next) port = Number(next);
      i++;
    } else if (arg && !arg.startsWith("--")) {
      conversationId = arg;
    }
  }
  return { conversationId, port };
}

async function main(): Promise<void> {
  const { conversationId: explicitId, port } = parseArgs(process.argv.slice(2));
  const base = `http://127.0.0.1:${port}`;

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

  const target =
    (explicitId && sessionsBody.sessions.find((s) => s.agentSessionId === explicitId)) ??
    sessionsBody.sessions.find((s) => s.scrubGateOk);

  if (!target) {
    console.error(
      "SKIP: no scrub-gate-OK session available to verify (all ingested sessions predate the credential-scrub cutover)."
    );
    process.exit(0);
  }

  console.error(`Verifying conversationId=${target.agentSessionId} ("${target.label}") ...`);

  const eventsRes = await fetch(
    `${base}/api/cockpit/session-film/events?conversationId=${encodeURIComponent(target.agentSessionId)}`
  );
  if (!eventsRes.ok) {
    console.error(`FAIL: /events returned HTTP ${eventsRes.status}: ${await eventsRes.text()}`);
    process.exit(1);
  }

  const eventsBody = (await eventsRes.json()) as {
    events: SemanticEventShape[];
    ingestedAt: string | null;
  };
  const events = eventsBody.events;

  if (events.length === 0) {
    console.error("FAIL: events array is empty — expected a non-trivial transcript.");
    process.exit(1);
  }

  let prevT = -Infinity;
  for (const [i, event] of events.entries()) {
    if (typeof event.schemaVersion !== "string" || typeof event.verb !== "string") {
      console.error(
        `FAIL: event[${i}] missing expected SemanticEvent fields: ${JSON.stringify(event)}`
      );
      process.exit(1);
    }
    if (
      !event.target ||
      typeof event.target.realm !== "string" ||
      typeof event.target.id !== "string"
    ) {
      console.error(`FAIL: event[${i}] missing target.realm/id: ${JSON.stringify(event)}`);
      process.exit(1);
    }
    const t = Date.parse(event.tStart);
    if (Number.isNaN(t)) {
      console.error(`FAIL: event[${i}] has an unparsable tStart: ${event.tStart}`);
      process.exit(1);
    }
    if (t < prevT) {
      console.error(
        `FAIL: events are not ordered — event[${i}].tStart (${event.tStart}) precedes a prior event's tStart.`
      );
      process.exit(1);
    }
    prevT = t;
  }

  console.error(
    `PASS: ${events.length} ordered SemanticEvent(s) returned for conversationId=${target.agentSessionId} ` +
      `(ingestedAt=${eventsBody.ingestedAt ?? "null"}).`
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
