import { Command } from "commander";
import {
  describeOutcome,
  realRestartProbes,
  resolveRestart,
  RESTART_CONFIRM_BUDGET_MS,
} from "../../cockpit/daemon-restart";
import { resolveCockpitPort, COCKPIT_PORT_FLAG_DESCRIPTION } from "./port";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

export function createRestartCommand(): Command {
  const cmd = new Command("restart");
  cmd.description("Restart the cockpit daemon under whichever supervisor is running it");
  // The macOS-only gate this command used to open with is gone with the launchd
  // dependency it existed for (mt#4232): signalling a pid is not launchd, and
  // the failure it guarded against is now reported by the outcome itself rather
  // than pre-judged by platform.
  //
  // No commander default, and the parsing/validation is `resolveCockpitPort`'s
  // (mt#3988): with a default in place an explicit `--port 3737` and an unset
  // flag are indistinguishable, so a configured `cockpit.port` could never
  // apply — and this command would have restarted a port the daemon does not
  // serve while reporting "nothing is serving" (PR #3097 R1).
  cmd.option("--port <port>", COCKPIT_PORT_FLAG_DESCRIPTION.replace("listen on", "restart on"));
  cmd.addHelpText(
    "after",
    `
Restarts by signalling the serving process, then confirming a supervisor
replaced it — the tray and launchd both respawn a daemon that exits, so this
works under either without asking which one is present.

Note the tray records a signalled restart as a CRASH-class exit: a SIGTERMed
process reports no exit code, which is indistinguishable at the syscall level
from a real crash. It respawns normally, but four restarts inside ten minutes
trips the tray's restart-storm alert, and two inside five seconds hit its
respawn throttle. Both are the supervisor working as intended.

Confirmation can take up to ${Math.round(RESTART_CONFIRM_BUDGET_MS / 1000)}s under launchd, whose plist sets
ThrottleInterval 60. Under the tray it is typically a few seconds.`
  );

  cmd.action(async (options: { port?: string }) => {
    let port: number;
    try {
      port = resolveCockpitPort(options.port);
    } catch (error) {
      console.error(getLoggableErrorSummary(error));
      process.exit(1);
    }

    console.log(`Restarting the cockpit daemon on port ${port}...`);

    const outcome = await resolveRestart(port, realRestartProbes);
    const { message, failed } = describeOutcome(outcome, "restart", port);

    if (failed) {
      console.error(message);
      process.exit(1);
    }
    console.log(message);
  });

  return cmd;
}
