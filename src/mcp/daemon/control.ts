/**
 * Non-GUI control surface for the local MCP daemon (mt#4466).
 *
 * ## What was missing, and why it cost an hour
 *
 * `minsky mcp` exposed `start`, `tools`, `call`, `inspect`, `register`, `proxy`
 * — nothing that reads or restarts an ALREADY-RUNNING daemon. The only
 * start/stop/restart affordance was the cockpit tray's GUI menu, so when the
 * daemon degraded, remediation was operator-only by construction: a human at a
 * Mac menu bar. On 2026-08-23 that cost ~50 minutes during which every DB-backed
 * MCP tool timed out for every conversation on the machine, and two `/mcp`
 * reconnects were spent before the two-process topology was understood — `/mcp`
 * respawns the stdio shim, while the long-lived HTTP daemon on 127.0.0.1:48765
 * is the tray's child and is untouched by it (mem#1120 R2).
 *
 * The capability is not new, it was LOST: `__proxy_restart_server`
 * (`src/mcp/stdio-proxy/tools.ts`) gave an agent exactly this in mt#1714, and
 * ended the first occurrence "in seconds" (mem#1120 R1). It became unreachable
 * when `.mcp.json` moved from `mcp proxy` to `mcp shim` (ADR-038), because it
 * lives in the proxy. This module puts it back on the surface that survives the
 * topology — a shared-registry command, which reaches BOTH the CLI and the MCP
 * tool list from one registration.
 *
 * ## Everything here is pure; the I/O is injected
 *
 * `describeDaemon` and `planRestart` are total functions over a snapshot, so
 * every branch — including the ones that matter most, where the daemon is
 * absent, foreign, or wedged — is testable without a daemon, a port, or a
 * process to kill.
 */

import type { HealthProbeOutcome, LocalDaemonDiscoveryRecord } from "./local-daemon";
import { classifyDaemonProbe, type DaemonState } from "../setup/local-http-apply";

/** What `mcp status` observed, before any interpretation. */
export interface DaemonSnapshot {
  /** The discovery record the daemon writes at boot, or null if absent. */
  record: LocalDaemonDiscoveryRecord | null;
  /** The result of probing `/health`, or null when there was no record to probe. */
  probe: HealthProbeOutcome | null;
}

/** `describeDaemon`'s verdict — the shape both commands report. */
export interface DaemonReport {
  /**
   * `"no-record"` is distinct from `"absent"` on purpose. No discovery record
   * means nothing has ever started a local daemon here (or `minsky setup
   * local-http` was never run); `absent` means a record exists and names a
   * daemon that is no longer answering. The remedies differ.
   */
  state: DaemonState | "no-record";
  pid: number | null;
  port: number | null;
  startedAt: string | null;
  uptimeMs: number | null;
  /** Live pool reachability from the health body (mt#4466), when published. */
  db: string | null;
  /** When that reachability was last MEASURED. A stale stamp beside a degraded
   * `db` is the never-settling-query wedge. */
  dbCheckedAt: string | null;
  ready: boolean | null;
  /** One line an operator or agent can act on. */
  detail: string;
  /**
   * What to DO about it, or null when nothing is wrong.
   *
   * This field is SC3's floor: even where the answer is still "a human has to
   * act", the daemon must say so in its own words rather than leaving the next
   * agent to derive the process topology from scratch.
   */
  remedy: string | null;
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readBoolean(body: unknown, key: string): boolean | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

/** Reads `dbCheck.checkedAt` without assuming the sub-object exists. */
function readDbCheckedAt(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const check = (body as Record<string, unknown>)["dbCheck"];
  return readString(check, "checkedAt");
}

/**
 * Interpret a snapshot. Pure and total — every state has a detail and, when
 * something is wrong, a remedy.
 */
export function describeDaemon(snapshot: DaemonSnapshot, nowMs: number): DaemonReport {
  const { record, probe } = snapshot;

  if (!record) {
    return {
      state: "no-record",
      pid: null,
      port: null,
      startedAt: null,
      uptimeMs: null,
      db: null,
      dbCheckedAt: null,
      ready: null,
      detail:
        "no local MCP daemon discovery record found — nothing has started one on this machine",
      remedy:
        "run `minsky setup local-http` to point this workspace at a local daemon, or start one " +
        "directly with `minsky mcp start --local-daemon`",
    };
  }

  const startedAtMs = Date.parse(record.startedAt);
  const uptimeMs = Number.isNaN(startedAtMs) ? null : Math.max(0, nowMs - startedAtMs);
  const base = {
    pid: record.pid,
    port: record.port,
    startedAt: record.startedAt,
    uptimeMs,
  };

  if (!probe) {
    return {
      ...base,
      state: "absent",
      db: null,
      dbCheckedAt: null,
      ready: null,
      detail: `a discovery record names pid ${record.pid} on port ${record.port}, but it was not probed`,
      remedy: null,
    };
  }

  const status = classifyDaemonProbe(probe);
  const body = probe.kind === "body" ? probe.body : null;
  const db = readString(body, "db");
  const dbCheckedAt = readDbCheckedAt(body);
  const ready = readBoolean(body, "ready");
  const healthStatus = readString(body, "status");

  // A wedged pool is the case this whole task exists for, so it gets its own
  // branch rather than being folded into `not-ready`: the remedy is a RESTART,
  // and saying so here is what turns an hour of topology archaeology into one
  // command.
  if (status.state === "not-ready" && db !== null && db !== "ok") {
    return {
      ...base,
      state: status.state,
      db,
      dbCheckedAt,
      ready,
      detail:
        `the daemon is alive and answering, but a query has not gotten through its connection ` +
        `pool since ${dbCheckedAt ?? "an unknown time"} (db: ${db}). The database itself may be ` +
        `fine — the CLI opens its own connection and bypasses this pool entirely.`,
      remedy:
        `restart the daemon: \`minsky mcp restart --execute\`. The tray supervises pid ` +
        `${record.pid} and respawns it. Confirm with \`minsky tasks status get <id>\` via the ` +
        `CLI first — if that is fast while MCP hangs, the pool is the fault, not the database.`,
    };
  }

  if (status.state === "running") {
    return {
      ...base,
      state: status.state,
      db,
      dbCheckedAt,
      ready,
      detail: `a minsky-mcp daemon is serving port ${record.port}${
        db !== null ? ` (db: ${db}, last checked ${dbCheckedAt ?? "never"})` : ""
      }${healthStatus !== null ? `, health: ${healthStatus}` : ""}`,
      remedy: null,
    };
  }

  if (status.state === "absent") {
    return {
      ...base,
      state: status.state,
      db,
      dbCheckedAt,
      ready,
      detail: `the discovery record names pid ${record.pid} on port ${record.port}, but ${status.detail}`,
      remedy:
        "the tray normally respawns it — check that Minsky Cockpit.app is running, or start a " +
        "daemon with `minsky mcp start --local-daemon`",
    };
  }

  // `foreign` and `not-ready`-without-a-db-signal fall through here.
  return {
    ...base,
    state: status.state,
    db,
    dbCheckedAt,
    ready,
    detail: status.detail,
    remedy:
      status.state === "foreign"
        ? `something other than a minsky-mcp daemon holds port ${record.port} — do NOT kill it ` +
          `blindly; identify it first (\`lsof -nP -iTCP:${record.port} -sTCP:LISTEN\`)`
        : "the daemon cannot serve DB-backed work; `minsky mcp restart --execute` is the usual remedy",
  };
}

/** What a restart would do, decided before anything is killed. */
export type RestartPlan =
  | {
      action: "restart";
      pid: number;
      port: number;
      /** Why this is safe to do — carried into the output so it is auditable. */
      rationale: string;
    }
  | { action: "refuse"; reason: string };

/**
 * Decide whether a restart is safe, from the report alone.
 *
 * The refusals are the point. A `foreign` port holder must never be killed by
 * this command — that is the mt#3142 shape (a different application answering
 * on the port), and killing it would be a destructive remedy applied to a
 * misdiagnosis.
 */
export function planRestart(report: DaemonReport): RestartPlan {
  if (report.state === "no-record") {
    return {
      action: "refuse",
      reason:
        "no discovery record — there is no daemon to restart. Start one with " +
        "`minsky mcp start --local-daemon`.",
    };
  }
  if (report.state === "foreign") {
    return {
      action: "refuse",
      reason:
        `port ${report.port} is held by something that is not a minsky-mcp daemon. Refusing to ` +
        `kill it: identify the holder first. (This is the mt#3142 shape — a different app ` +
        `answering on the port — and a kill here would be a destructive remedy for a ` +
        `misdiagnosis.)`,
    };
  }
  if (report.pid === null || report.port === null) {
    return { action: "refuse", reason: "the discovery record carries no usable pid/port" };
  }
  if (report.state === "absent") {
    return {
      action: "refuse",
      reason:
        `nothing is answering on port ${report.port}, so there is nothing to restart. If the ` +
        `tray is running it should already be respawning; if not, start one with ` +
        `\`minsky mcp start --local-daemon\`.`,
    };
  }

  return {
    action: "restart",
    pid: report.pid,
    port: report.port,
    rationale:
      report.state === "not-ready"
        ? `the daemon is answering but cannot serve DB-backed work (db: ${report.db ?? "unknown"})`
        : "restarting a healthy daemon on explicit request",
  };
}

/**
 * The shared-fate note every restart preview carries.
 *
 * Not a warning to be dismissed — a citation. ADR-038 §Question 6 ACCEPTED
 * shared fate for this path on a measurement: all N conversations lose their
 * transport session at once, and mt#3811 measured 6 concurrent clients
 * recovering in 8-14ms with zero surfaced failures once the daemon was back.
 * The residual exposure is the ~5.1s cold-start window, which the shim's 15s
 * connection-refused retry (`RETRY_WINDOW_MS`) now absorbs for calls that land
 * inside it. What does NOT survive is a call already accepted and in flight —
 * that is the real cost, and it is why this is stated rather than assumed.
 */
export const SHARED_FATE_NOTE =
  "Every conversation on this machine shares this daemon (ADR-038). A restart drops all live " +
  "transport sessions at once; each client re-initializes lazily on its next tool call " +
  "(measured 8-14ms at N=6, mt#3811), and the shim retries connection-refused for 15s, which " +
  "covers the ~5.1s cold start. Calls already in flight WILL fail and are not retried.";
