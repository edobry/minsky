import { Command } from "commander";
import { stopDaemon } from "../../cockpit/launchd";

export function createStopCommand(): Command {
  const cmd = new Command("stop");
  cmd.description("Stop the cockpit daemon (keeps the LaunchAgent plist installed)");
  cmd.action(() => {
    if (process.platform !== "darwin") {
      console.error("cockpit stop is only supported on macOS (uses launchd).");
      process.exit(1);
    }

    try {
      stopDaemon();
      console.log("Cockpit daemon stopped.");
      console.log("The plist is still installed — run `minsky cockpit restart` to start it again.");
    } catch (err) {
      const e = err as Error;
      console.error(`Failed to stop cockpit daemon: ${e.message}`);
      process.exit(1);
    }
  });
  return cmd;
}
