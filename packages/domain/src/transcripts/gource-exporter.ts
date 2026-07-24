/**
 * Gource custom-log exporter (mt#3157, Phase 0 affect probe).
 *
 * Serializes a `SemanticEvent[]` stream (from `event-adapter.ts`) to Gource's
 * custom log format — one line per path-touching event:
 *
 *   timestamp|username|type|file
 *
 * where `type` is `A` (added), `M` (modified), or `D` (deleted), and
 * `timestamp` is Unix seconds. See the Gource manpage (`gource.1`) / wiki
 * (https://github.com/acaudwell/Gource/wiki) for the full format spec.
 *
 * ## Documented invocation
 *
 * Generate a log file with `scripts/export-gource-log.ts`, then render it:
 *
 *   bun scripts/export-gource-log.ts <conversationId> --out session.gource.log
 *   gource --log-format custom session.gource.log
 *
 * ## Verb → Gource-action mapping (RFC revision 3, Amendment 3)
 *
 *   - `read`, `search` → `M` (referenced, not mutated).
 *   - `write`, `create` → `A` on first touch of a given path within this
 *     export, `M` thereafter.
 *   - `delete` → `D`.
 *   - `clone` → `A`, synthetic directory-grain (a new agent workspace).
 *   - Every other verb (`execute`, `spawn`, and the conversational verbs
 *     `wait`/`speak`/`think`/`ask`/`respond`) is EXCLUDED — no stable
 *     file-system-like path to visualize (see `event-schema.ts`'s
 *     `PATH_BEARING_VERBS`). These verbs remain first-class in the semantic
 *     stream; only the Gource projection drops them.
 *
 * Web targets are exported at DOMAIN grain with any query string stripped
 * (Amendment 3) — `event-adapter.ts`'s web target extractors already produce
 * domain-only ids, and `stripQueryString` here is a defensive second pass.
 *
 * ## Credential-scrub gate (RFC SC 3)
 *
 * Export refuses a session ingested before the credential-scrubbing cutover
 * (mt#2763's `credential-scrubber.ts`) unless the caller explicitly asserts
 * the session was verified re-scrubbed. mt#2864's sweep confirmed the live
 * DB was scrubbed to residue=0 on 2026-07-18; this module uses that date as
 * a conservative cutoff on INGESTION date (not a per-row scrub flag — none
 * exists on `agent_transcripts`) — a session ingested on/after the cutoff
 * passed through the (by then live) ingest-time scrubber; one ingested
 * before it did not, even if it happens to contain no credentials. This is
 * deliberately conservative: the exporter's whole purpose is a shareable
 * artifact, so a false "refused" is far cheaper than a false "clear."
 *
 * @see event-schema.ts — the SemanticEvent shape / PATH_BEARING_VERBS
 * @see event-adapter.ts — the producer of the event stream this consumes
 * @see credential-scrubber.ts — the ingest-time scrubber this gate assumes
 */

import {
  isPathBearingVerb,
  type EventActor,
  type EventTarget,
  type EventVerb,
  type SemanticEvent,
} from "./event-schema";

// ── Credential-scrub gate ─────────────────────────────────────────────────────

/**
 * Conservative cutoff: the mt#2864 sweep date the live DB was confirmed
 * scrubbed to residue=0. A session ingested before this date is refused
 * unless the caller asserts `verifiedRescrubbed`.
 */
export const CREDENTIAL_SCRUB_CUTOFF_ISO = "2026-07-18T00:00:00.000Z" as const;

export class UnscrubbedSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnscrubbedSessionError";
  }
}

/**
 * Throws {@link UnscrubbedSessionError} unless `ingestedAt` is on/after the
 * scrub cutoff, or `verifiedRescrubbed` is explicitly asserted by the caller
 * (e.g. after re-running the ingest pipeline's scrubber over this specific
 * session's stored row).
 */
export function assertScrubGate(
  ingestedAt: Date | string | null | undefined,
  verifiedRescrubbed = false
): void {
  if (verifiedRescrubbed) return;

  if (!ingestedAt) {
    throw new UnscrubbedSessionError(
      "Export refused: session has no ingestedAt timestamp, so it cannot be verified as " +
        "ingested after the credential-scrubbing cutover (mt#2763/mt#2864). Pass " +
        "verifiedRescrubbed=true only after confirming this specific session was re-scrubbed."
    );
  }

  const ts = typeof ingestedAt === "string" ? new Date(ingestedAt) : ingestedAt;
  const cutoff = new Date(CREDENTIAL_SCRUB_CUTOFF_ISO);
  if (Number.isNaN(ts.getTime()) || ts.getTime() < cutoff.getTime()) {
    throw new UnscrubbedSessionError(
      `Export refused: session ingested at ${String(ingestedAt)}, before the ` +
        `credential-scrubbing cutoff (${CREDENTIAL_SCRUB_CUTOFF_ISO}, mt#2864 sweep confirmed ` +
        "residue=0). This session's stored transcript may contain unscrubbed credentials. Pass " +
        "verifiedRescrubbed=true only after confirming this specific session was re-scrubbed."
    );
  }
}

// ── Path derivation from a target id ─────────────────────────────────────────

function stripQueryString(path: string): string {
  const qIdx = path.indexOf("?");
  return qIdx >= 0 ? path.slice(0, qIdx) : path;
}

/**
 * Derive a Gource path from a target's synthetic composite id (see
 * `event-schema.ts`'s `EventTarget` doc comment for the id shapes). Returns
 * `null` for a realm/id shape with no meaningful path (defensive — in
 * practice only path-bearing-verb events reach this function).
 */
function pathForTarget(target: EventTarget): string | null {
  const id = target.id;
  if (id.startsWith("file:")) {
    const rest = id.slice("file:".length);
    const sepIdx = rest.indexOf(":");
    const path = sepIdx >= 0 ? rest.slice(sepIdx + 1) : rest;
    return path.length > 0 ? stripQueryString(path) : null;
  }
  if (id.startsWith("web:")) {
    const domain = id.slice("web:".length);
    return domain.length > 0 ? stripQueryString(domain) : null;
  }
  if (id.startsWith("notion:")) {
    return `notion/${id.slice("notion:".length)}`;
  }
  if (id.startsWith("minsky:")) {
    return id.slice("minsky:".length).replace(/:/g, "/");
  }
  if (id.startsWith("agents:")) {
    return `agents/${id.slice("agents:".length)}`;
  }
  if (id.startsWith("shell:")) {
    return `shell/${id.slice("shell:".length)}`;
  }
  return null;
}

function actorLabel(actor: EventActor): string {
  if (actor.kind === "principal") return "principal";
  if (actor.kind === "policy") return `policy:${actor.guardName ?? "unknown"}`;
  return actor.agentSessionId ? `agent:${actor.agentSessionId}` : "agent";
}

// ── Action derivation ─────────────────────────────────────────────────────────

export type GourceAction = "A" | "M" | "D";

function actionForVerb(
  verb: EventVerb,
  path: string,
  touchedPaths: Set<string>
): GourceAction | null {
  switch (verb) {
    case "delete":
      return "D";
    case "clone":
      return "A";
    case "write":
    case "create": {
      const firstTouch = !touchedPaths.has(path);
      touchedPaths.add(path);
      return firstTouch ? "A" : "M";
    }
    case "read":
    case "search":
      return "M";
    default:
      return null;
  }
}

// ── Line building ─────────────────────────────────────────────────────────────

export interface GourceLogLine {
  timestampSec: number;
  actor: string;
  action: GourceAction;
  path: string;
}

/**
 * Convert a semantic event stream into Gource log lines. Filters to
 * path-bearing verbs only (RFC Amendment 3), sorted ascending by timestamp
 * (Gource requires non-decreasing order).
 */
export function eventsToGourceLines(events: readonly SemanticEvent[]): GourceLogLine[] {
  const touchedPaths = new Set<string>();
  const lines: GourceLogLine[] = [];

  for (const event of events) {
    if (!isPathBearingVerb(event.verb)) continue;

    const path = pathForTarget(event.target);
    if (!path) continue;

    const action = actionForVerb(event.verb, path, touchedPaths);
    if (!action) continue;

    const ts = Date.parse(event.tStart);
    if (Number.isNaN(ts)) continue;

    lines.push({
      timestampSec: Math.floor(ts / 1000),
      actor: actorLabel(event.actor),
      action,
      path,
    });
  }

  return lines.sort((a, b) => a.timestampSec - b.timestampSec);
}

/** Render Gource log lines to the pipe-delimited custom log text format. */
export function formatGourceLog(lines: readonly GourceLogLine[]): string {
  if (lines.length === 0) return "";
  return `${lines.map((l) => `${l.timestampSec}|${l.actor}|${l.action}|${l.path}`).join("\n")}\n`;
}

// ── Top-level export (scrub-gated) ────────────────────────────────────────────

export interface ExportGourceLogOptions {
  /** The session's `agent_transcripts.ingested_at` value — drives the scrub gate. */
  ingestedAt: Date | string | null | undefined;
  /** See {@link assertScrubGate}. */
  verifiedRescrubbed?: boolean;
}

/**
 * Full export pipeline: scrub gate, then event→line conversion, then
 * formatting. Throws {@link UnscrubbedSessionError} if the scrub gate fails.
 */
export function exportGourceLog(
  events: readonly SemanticEvent[],
  options: ExportGourceLogOptions
): string {
  assertScrubGate(options.ingestedAt, options.verifiedRescrubbed);
  return formatGourceLog(eventsToGourceLines(events));
}
