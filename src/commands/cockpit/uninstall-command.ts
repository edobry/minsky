import { Command } from "commander";
import { uninstallDaemon } from "../../cockpit/launchd";

export function createUninstallCommand(): Command {
  const cmd = new Command("uninstall");
  cmd.description(
    "Uninstall the cockpit daemon (removes the LaunchAgent plist and stops the daemon)"
  );
  cmd.action(() => {
    if (process.platform !== "darwin") {
      console.error("cockpit uninstall is only supported on macOS (uses launchd).");
      process.exit(1);
    }

    try {
      uninstallDaemon();
      console.log("Cockpit daemon uninstalled.");
      console.log("The daemon has been stopped and will no longer start on login.");
    } catch (err) {
      const e = err as Error;
      console.error(`Failed to uninstall cockpit daemon: ${e.message}`);
      process.exit(1);
    }
  });
  return cmd;
}
