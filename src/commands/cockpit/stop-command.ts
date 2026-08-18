import { Command } from "commander";
import { getDaemonStatus, stopDaemon } from "../../cockpit/launchd";
import { describeOutcome, realRestartProbes, resolveStop } from "../../cockpit/daemon-restart";
import { resolveCockpitPort, COCKPIT_PORT_FLAG_DESCRIPTION } from "./port";

export function createStopCommand(): Command {
  const cmd = new Command("stop");
  cmd.description("Stop the cockpit daemon (keeps a LaunchAgent plist installed)");
  // Same reasoning as `restart`: no commander default, validation and the
  // `cockpit.port` precedence both belong to `resolveCockpitPort` (mt#3988).
  cmd.option("--port <port>", COCKPIT_PORT_FLAG_DESCRIPTION.replace("listen on", "stop on"));
  cmd.addHelpText(
    "after",
    `
Unlike \`restart\`, stop genuinely DOES dispatch per supervision mode, because a
signal cannot stop a supervised daemon — that is the supervisor's whole job:

  launchd  -> \`launchctl unload\`, which is the only stop launchd honours; its
              plist carries KeepAlive SuccessfulExit:false, so a signalled
              daemon comes back ~60s later.
  tray     -> signalling stops the process and the tray respawns it. This
              command reports that plainly rather than claiming a stop. Use the
              tray menu's Stop item to actually stop it.
  no supervisor -> signalling stops it, and it stays stopped.`
  );

  cmd.action(async (options: { port?: string }) => {
    let port: number;
    try {
      port = resolveCockpitPort(options.port);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    const status = await getDaemonStatus(port);

    // launchd is the one supervisor whose stop is NOT a signal. `launchctl
    // unload` deregisters the job; SIGTERM would just be undone by KeepAlive.
    if (status.supervisor === "launchd") {
      try {
        await stopDaemon(port);
        console.log("Cockpit daemon stopped (launchd agent unloaded).");
        console.log(
          "The plist is still installed — run `minsky cockpit restart` to start it again."
        );
      } catch (err) {
        console.error(`Failed to stop cockpit daemon: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }

    const outcome = await resolveStop(port, realRestartProbes);
    const { message, failed } = describeOutcome(outcome, "stop", port);

    if (failed) {
      console.error(message);
      process.exit(1);
    }
    console.log(message);
  });

  return cmd;
}
