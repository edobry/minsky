/**
 * `mcp status` / `mcp restart` — the local daemon's non-GUI control surface
 * (mt#4466).
 *
 * Registered under `CommandCategory.MCP`, which is what makes ONE registration
 * serve both audiences this task cares about: the CLI gets `minsky mcp status`
 * / `minsky mcp restart`, and the MCP tool list gets `mcp_status` /
 * `mcp_restart`. That matters because the agent that needs this most is the one
 * whose MCP calls are timing out — it still has the CLI — and the operator who
 * needs it most is the one not sitting at the tray's menu bar.
 *
 * The decision logic lives in `src/mcp/daemon/control.ts` and is pure; this file
 * is the imperative shell that reads the discovery record, probes `/health`, and
 * (only under `--execute`) kills a pid.
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandParameterMap,
} from "../../command-registry";
import {
  readDiscoveryRecord,
  probeHealthIdentity,
  type HealthProbeOutcome,
} from "../../../../mcp/daemon/local-daemon";
import {
  localDaemonHealthUrl,
  LOCAL_DAEMON_CMD_MARKER,
} from "../../../../mcp/setup/local-http-apply";
import {
  describeDaemon,
  planRestart,
  SHARED_FATE_NOTE,
  type DaemonReport,
} from "../../../../mcp/daemon/control";
import { killIfIdentityMatches } from "../../../../cockpit/process-identity";

/** Read the discovery record and probe the daemon it names. */
async function snapshotDaemon(): Promise<DaemonReport> {
  const record = readDiscoveryRecord();
  let probe: HealthProbeOutcome | null = null;
  if (record) {
    probe = await probeHealthIdentity(localDaemonHealthUrl(record.host, record.port));
  }
  return describeDaemon({ record, probe }, Date.now());
}

const statusParams = {} satisfies CommandParameterMap;

export function registerMcpStatusCommand(): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "mcp.status",
      category: CommandCategory.MCP,
      name: "status",
      description:
        "Report the local MCP daemon's liveness, including whether a query can currently get through its connection pool",
      parameters: statusParams,
      requiresSetup: false,
      execute: async () => {
        const report = await snapshotDaemon();
        return {
          success: true,
          ...report,
          // Surfaced explicitly rather than left for the reader to infer from
          // `db`: the whole defect this command answers is that a green-looking
          // daemon can be unable to serve, so the summary line has to say which.
          serving: report.state === "running",
        };
      },
    })
  );
}

const restartParams = {
  execute: {
    schema: z.boolean().default(false),
    description:
      "Actually restart the daemon. Without this the command previews what would happen and changes nothing.",
    required: false,
    defaultValue: false,
  },
} satisfies CommandParameterMap;

export function registerMcpRestartCommand(): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "mcp.restart",
      category: CommandCategory.MCP,
      name: "restart",
      description:
        "Restart the local MCP daemon (the tray respawns it). Previews by default; pass --execute to act.",
      parameters: restartParams,
      requiresSetup: false,
      // PR #3268 R1 asked whether this should carry `mutating: true`. **It
      // deliberately does not**, and the reasoning is worth keeping because the
      // flag looks obviously right from here.
      //
      // `mutating` is not "does this write?" — mt#3924 decided it means the
      // DRIFT GATE should refuse the call on a stale server, and scoped that to
      // irreversible, bulk, or migrating effects rather than to everything that
      // writes (`tool-effect-coverage.test.ts` pins the exact set, so adding one
      // is amending a decision record, not setting a field). A daemon restart is
      // none of those: it is transient and self-healing, since the tray respawns
      // within ~5s and the shim retries connection-refused for 15s.
      //
      // And the gate would fire in exactly the wrong place. A stale daemon is a
      // prime candidate for needing a restart, so refusing `mcp_restart` when
      // stale would refuse the recovery. The blast radius is real — every
      // conversation shares this daemon — but that is what the preview-by-default
      // and the shared-fate note in the output are for, not the drift gate.
      execute: async (params) => {
        const report = await snapshotDaemon();
        const plan = planRestart(report);

        if (plan.action === "refuse") {
          return {
            success: false,
            executed: false,
            state: report.state,
            detail: report.detail,
            reason: plan.reason,
          };
        }

        // Dry-run by default, per `Operational Safety: Dry-Run First`. A restart
        // drops every live transport session on the machine, so the default has
        // to be the one that changes nothing — and the preview is where the
        // shared-fate cost gets stated rather than discovered.
        if (!params.execute) {
          return {
            success: true,
            executed: false,
            dryRun: true,
            state: report.state,
            pid: plan.pid,
            port: plan.port,
            detail: report.detail,
            wouldDo: `send SIGTERM to pid ${plan.pid}; the tray supervisor respawns it`,
            rationale: plan.rationale,
            sharedFate: SHARED_FATE_NOTE,
            hint: "re-run with --execute to perform the restart",
          };
        }

        // `killIfIdentityMatches` re-reads the LIVE command line and refuses if
        // it no longer carries the daemon's marker. That guard is not optional
        // decoration: the pid comes from a file written at boot, and a
        // long-lived daemon means a long window for pid reuse. It is also the
        // only sanctioned kill path in this codebase — never a bare
        // `process.kill`.
        const killed = await killIfIdentityMatches(plan.pid, LOCAL_DAEMON_CMD_MARKER);
        if (!killed) {
          return {
            success: false,
            executed: false,
            state: report.state,
            pid: plan.pid,
            reason:
              `refused to kill pid ${plan.pid}: its live command line no longer carries ` +
              `\`${LOCAL_DAEMON_CMD_MARKER}\`. Either it already exited, or the pid was reused. ` +
              `Re-run \`minsky mcp status\` to see the current state.`,
          };
        }

        return {
          success: true,
          executed: true,
          state: report.state,
          pid: plan.pid,
          port: plan.port,
          rationale: plan.rationale,
          sharedFate: SHARED_FATE_NOTE,
          // Deliberately NOT claiming the daemon is back. This command sends a
          // signal; the tray owns the respawn, and asserting an outcome we have
          // not observed is the failure mode `claim-confidence.mdc` exists for.
          // The follow-up is one call and it is named here.
          verify:
            "SIGTERM sent. The tray respawns it (~5s cold start). Confirm with " +
            "`minsky mcp status` — do not assume it came back.",
        };
      },
    })
  );
}
