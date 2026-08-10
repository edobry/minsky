import { describe, test, expect } from "bun:test";
import path from "path";
import { getSessionsDir } from "@minsky/shared/paths";
import { resolveRunningCockpit, type ResolveDeps } from "./url-command";
import type { CockpitState } from "../../cockpit/lifecycle";

const SESSION_ID = "48492ab1-1fe4-4199-854a-eb4e5b150a51";
const SESSION_CWD = path.join(getSessionsDir(), SESSION_ID);
const MAIN_CWD = "/Users/someone/Projects/minsky";

function stateFor(workspaceId: string, pid: number, port: number): CockpitState {
  return {
    pid,
    port,
    url: `http://localhost:${port}`,
    workspaceId,
    workspacePath: workspaceId === "main" ? MAIN_CWD : path.join(getSessionsDir(), workspaceId),
    startedAt: "2026-08-05T22:17:16.552Z",
  };
}

/** Deps that serve the given state files and treat the listed pids as alive. */
function deps(states: Record<string, CockpitState>, alivePids: number[]): ResolveDeps {
  return {
    readState: (key) => states[key] ?? null,
    isAlive: (pid) => alivePids.includes(pid),
  };
}

describe("resolveRunningCockpit (mt#3800)", () => {
  test("prefers a live cockpit started in this workspace", () => {
    const own = stateFor(SESSION_ID, 111, 3901);
    const main = stateFor("main", 222, 3737);
    const resolved = resolveRunningCockpit(
      SESSION_CWD,
      deps({ [SESSION_ID]: own, main }, [111, 222])
    );
    expect(resolved).toEqual({ state: own, source: "workspace" });
  });

  test("falls back to the main cockpit when a session workspace has none", () => {
    const main = stateFor("main", 222, 3737);
    const resolved = resolveRunningCockpit(SESSION_CWD, deps({ main }, [222]));
    expect(resolved).toEqual({ state: main, source: "main" });
  });

  test("treats a stale state file (dead pid) as no cockpit, not as a URL", () => {
    // A killed cockpit leaves its state file behind; handing out its URL would
    // point the operator at a port nothing is listening on.
    const dead = stateFor(SESSION_ID, 111, 3901);
    const main = stateFor("main", 222, 3737);
    const resolved = resolveRunningCockpit(SESSION_CWD, deps({ [SESSION_ID]: dead, main }, [222]));
    expect(resolved).toEqual({ state: main, source: "main" });
  });

  test("returns null in the main workspace when its own cockpit is dead", () => {
    const dead = stateFor("main", 222, 3737);
    expect(resolveRunningCockpit(MAIN_CWD, deps({ main: dead }, []))).toBeNull();
  });

  test("returns null when no state file exists anywhere", () => {
    expect(resolveRunningCockpit(SESSION_CWD, deps({}, []))).toBeNull();
  });
});
