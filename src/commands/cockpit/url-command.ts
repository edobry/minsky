import { Command } from "commander";
import {
  MAIN_WORKSPACE_KEY,
  readCockpitState,
  resolveWorkspaceKey,
  type CockpitState,
} from "../../cockpit/lifecycle";
import { isProcessAlive } from "../../cockpit/port-recovery";

/**
 * Which state file the resolved cockpit came from.
 *
 * `workspace` — a cockpit started in this workspace. `main` — the fallback for a
 * session workspace with no cockpit of its own, which is the common case: the
 * operator runs one cockpit out of the main checkout and works in sessions.
 */
export type CockpitUrlSource = "workspace" | "main";

export interface ResolvedCockpit {
  state: CockpitState;
  source: CockpitUrlSource;
}

export interface ResolveDeps {
  readState: (workspaceKey: string) => CockpitState | null;
  isAlive: (pid: number) => boolean;
}

const DEFAULT_DEPS: ResolveDeps = {
  readState: readCockpitState,
  isAlive: isProcessAlive,
};

/**
 * Resolve the RUNNING cockpit serving `cwd`, or null when there is none.
 *
 * Deliberately distinct from `cockpit status`, which reports the launchd DAEMON:
 * a tray-supervised cockpit serving on 3737 makes `status` print "not installed",
 * so `status` cannot answer "what URL do I open?" (mt#3800).
 *
 * A state file is written at start and removed at stop, but a killed process
 * leaves it behind — so liveness is checked rather than assumed, and a stale file
 * is treated exactly like a missing one.
 */
export function resolveRunningCockpit(
  cwd: string,
  deps: ResolveDeps = DEFAULT_DEPS
): ResolvedCockpit | null {
  const workspaceKey = resolveWorkspaceKey(cwd);
  const live = (key: string): CockpitState | null => {
    const state = deps.readState(key);
    return state && deps.isAlive(state.pid) ? state : null;
  };

  const own = live(workspaceKey);
  if (own) return { state: own, source: "workspace" };

  if (workspaceKey === MAIN_WORKSPACE_KEY) return null;
  const main = live(MAIN_WORKSPACE_KEY);
  return main ? { state: main, source: "main" } : null;
}

export function createUrlCommand(): Command {
  const cmd = new Command("url");
  cmd.description("Print the base URL of the running cockpit serving this workspace");
  cmd
    .option("--json", "Output the full cockpit state as JSON")
    .action((options: { json?: boolean }) => {
      const resolved = resolveRunningCockpit(process.cwd());

      if (!resolved) {
        console.error("No running cockpit found for this workspace.");
        console.error("  Start one with `minsky cockpit start`.");
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify({ ...resolved.state, source: resolved.source }, null, 2));
        return;
      }

      console.log(resolved.state.url);
    });
  return cmd;
}
