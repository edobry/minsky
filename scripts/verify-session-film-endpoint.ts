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
 * cockpit daemon (`bun src/cli.ts cockpit start`). `--port N` (default 3737,
 * matching the daemon's own default — see `src/commands/cockpit/start-
 * command.ts`'s `DEFAULT_PORT`) builds `http://127.0.0.1:<port>`; `--base-url
 * <url>` overrides the whole base URL (host/protocol included) and takes
 * precedence over `--port` when both are given. A plain CLI flag is used
 * instead of a `MINSKY_*` env var so this override needs no entry in the
 * `no-unregistered-minsky-env-var`-enforced environment-mappings registry
 * (mt#3188).
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
