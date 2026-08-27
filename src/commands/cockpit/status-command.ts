import { Command } from "commander";
import { getDaemonStatus } from "../../cockpit/launchd";
import { resolveCockpitPort, COCKPIT_PORT_FLAG_DESCRIPTION } from "./port";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

export function createStatusCommand(): Command {
  const cmd = new Command("status");
  cmd.description("Check the status of the cockpit daemon");
  cmd
    // mt#3988: no commander default — `resolveCockpitPort` needs to see an
    // unset flag to let `cockpit.port` apply. Checking the status of a
    // different port than the daemon actually serves is the confusion this
    // whole task exists to remove.
    .option("--port <port>", COCKPIT_PORT_FLAG_DESCRIPTION.replace("listen on", "check"))
    .option("--json", "Output status as JSON")
    .action(async (options) => {
      let port: number;
      try {
        port = resolveCockpitPort(options.port);
      } catch (error) {
        console.error(getLoggableErrorSummary(error));
        process.exit(1);
      }

      const status = await getDaemonStatus(port);

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      // "Is a daemon serving?" and "is a launchd agent installed?" are separate
      // questions (ADR-014: the tray is the canonical supervisor, launchd an
      // opt-in headless mode), so they are reported separately rather than the
      // second short-circuiting the first.
      if (status.running) {
        console.log("Cockpit daemon: running");
        if (status.pid) console.log(`  PID:    ${status.pid}`);
        console.log(`  Port:   ${status.port}`);
        console.log(`  URL:    ${status.url}`);
        if (status.commit) console.log(`  Commit: ${status.commit}`);
        if (status.uptime) console.log(`  Uptime: ${status.uptime}`);
        if (status.supervisor === "launchd") {
          console.log(`  Owner:  launchd`);
          console.log(`  Plist:  ${status.plistPath}`);
        } else {
          console.log(`  Owner:  not launchd (the tray app or a manual run)`);
          // Only when the daemon would not name itself (mt#4232). Since
          // `/api/health` gained `pid`, the external case usually DOES report
          // one — printed by the `status.pid` line above — and emitting this
          // unconditionally then contradicted it two lines later. What remains
          // is the genuine gap: a daemon whose build predates that field.
          if (!status.pid) {
            console.log(`  PID:    unknown (this daemon's build predates the health pid field)`);
          }
          if (!status.installed) {
            // Name the path checked, so "no agent found" is falsifiable rather
            // than a bare assertion about the machine's whole configuration.
            console.log(`\n  No launchd agent found at ${status.plistPath}.`);
            console.log(
              "  Under the tray-supervised default that is expected; `minsky cockpit install`"
            );
            console.log("  is only needed for the headless (no-tray) mode.");
          }
        }
        return;
      }

      if (status.installed) {
        console.log("Cockpit daemon: installed but not running");
        if (status.pid) console.log(`  PID:    ${status.pid} (not responding)`);
        console.log(`  Port:   ${status.port}`);
        console.log(`  Plist:  ${status.plistPath}`);
        console.log("\n  The daemon should restart automatically (KeepAlive is enabled).");
        console.log("  Check logs at ~/.local/state/minsky/logs/cockpit-*.log");
        return;
      }

      console.log("Cockpit daemon: not running");
      console.log(`  Port:   ${status.port} (nothing answering)`);
      console.log(`\n  No launchd agent found at ${status.plistPath}.`);
      console.log("  Launch the Minsky Cockpit tray app, or run `minsky cockpit install`");
      console.log("  for the headless mode.");
    });
  return cmd;
}
