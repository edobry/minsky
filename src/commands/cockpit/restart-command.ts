import { Command } from "commander";
import { restartDaemon } from "../../cockpit/launchd";

export function createRestartCommand(): Command {
  const cmd = new Command("restart");
  cmd.description("Restart the cockpit daemon (unload + reload the LaunchAgent plist)");
  cmd.action(() => {
    if (process.platform !== "darwin") {
      console.error("cockpit restart is only supported on macOS (uses launchd).");
      process.exit(1);
    }

    try {
      restartDaemon();
      console.log("Cockpit daemon restarted.");
    } catch (err) {
      const e = err as Error;
      console.error(`Failed to restart cockpit daemon: ${e.message}`);
      process.exit(1);
    }
  });
  return cmd;
}
