/**
 * `minsky session ps` (alias `session attached`) report builder (mt#2284).
 *
 * Joins the STORED attachment set (self-registered via the MCP write path) with
 * a LOCAL `lsof -d cwd` cross-check, and reports the two classes of discrepancy
 * called out in the spec's acceptance tests:
 *
 * - **stored-but-not-live**: a self-registered attachment whose pid is not (or
 *   is no longer) a live process with that cwd — e.g. a hard-killed harness.
 * - **live-but-not-stored**: a live process with cwd inside a session workspace
 *   that never self-registered — e.g. a shell hand-`cd`'d into the workspace.
 */

import type { PresenceClaimRepository } from "../presence/index";
import { listAllSessionAttachments, type SessionAttachment } from "./attachment";
import {
  detectLiveSessionProcesses,
  type LiveSessionProcess,
  type LsofRunner,
} from "./attachment-lsof";

export interface SessionPsEntry {
  sessionId: string;
  /** Stored (self-registered) attachments for this session. */
  attachments: SessionAttachment[];
  /** Live processes detected via the lsof cross-check for this session. */
  liveProcesses: LiveSessionProcess[];
  /** Stored attachments whose pid was not found among the live cross-check. */
  storedNotLive: SessionAttachment[];
  /** Live processes found via lsof with no matching stored attachment. */
  liveNotStored: LiveSessionProcess[];
}

/**
 * Build the full `session ps` report: every session with either a stored
 * attachment or a live cwd-matched process, joined and discrepancy-annotated.
 */
export async function buildSessionPsReport(
  repo: PresenceClaimRepository,
  sessionsDir: string,
  lsofRunner?: LsofRunner
): Promise<SessionPsEntry[]> {
  const [attachments, liveProcesses] = await Promise.all([
    listAllSessionAttachments(repo),
    detectLiveSessionProcesses(sessionsDir, lsofRunner),
  ]);

  const bySessionAttachments = new Map<string, SessionAttachment[]>();
  for (const a of attachments) {
    const list = bySessionAttachments.get(a.sessionId) ?? [];
    list.push(a);
    bySessionAttachments.set(a.sessionId, list);
  }

  const bySessionLive = new Map<string, LiveSessionProcess[]>();
  for (const p of liveProcesses) {
    const list = bySessionLive.get(p.sessionId) ?? [];
    list.push(p);
    bySessionLive.set(p.sessionId, list);
  }

  const allSessionIds = new Set<string>([...bySessionAttachments.keys(), ...bySessionLive.keys()]);

  const entries: SessionPsEntry[] = [];

  for (const sessionId of allSessionIds) {
    const sessionAttachments = bySessionAttachments.get(sessionId) ?? [];
    const sessionLive = bySessionLive.get(sessionId) ?? [];
    const livePids = new Set(sessionLive.map((p) => p.pid));
    const storedPids = new Set(
      sessionAttachments.filter((a) => typeof a.pid === "number").map((a) => a.pid as number)
    );

    // Only flag stored-not-live for attachments that DID record a pid — an
    // attachment with no pid has nothing to cross-check against lsof.
    const storedNotLive = sessionAttachments.filter(
      (a) => typeof a.pid === "number" && !livePids.has(a.pid)
    );
    const liveNotStored = sessionLive.filter((p) => !storedPids.has(p.pid));

    entries.push({
      sessionId,
      attachments: sessionAttachments,
      liveProcesses: sessionLive,
      storedNotLive,
      liveNotStored,
    });
  }

  return entries;
}
