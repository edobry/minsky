/**
 * Local `lsof -d cwd` cross-check for session runtime-attachment (mt#2284).
 *
 * Self-registration (attachment.ts) is the primary mechanism; this module is
 * the local-only OS-scan FALLBACK/CROSS-CHECK named in the spec — it detects
 * live processes whose current working directory is inside a Minsky session
 * workspace, terminal-emulator-agnostically (no iTerm/AppleScript dependency;
 * `lsof -d cwd` reflects OS process facts only).
 *
 * Empirically validated method (see task spec "Key code seams"): `lsof -d cwd`
 * filtered to `~/.local/state/minsky/sessions/<id>` reliably shows live
 * processes whose cwd is in a session workspace.
 */

/** A live OS process whose cwd resolves inside a session workspace. */
export interface LiveSessionProcess {
  pid: number;
  sessionId: string;
  cwd: string;
}

/** Injectable lsof runner — returns raw `lsof -d cwd -Fpn` stdout. Enables testing without a real OS scan. */
export type LsofRunner = () => Promise<string>;

/**
 * Default runner: shells out to `lsof -d cwd -Fpn` via `Bun.spawnSync`
 * (project convention — `node:child_process` is restricted, see
 * `bun_over_node.mdc`).
 *
 * `-F pn` requests field-mode output: a `p<pid>` line, an `f<fd>` line, and an
 * `n<name>` line per matching file descriptor. Never throws — lsof exits
 * non-zero when it finds nothing to report on some platforms; that is not an
 * error for our purposes (just "no live cwd-attached processes").
 */
export async function defaultLsofRunner(): Promise<string> {
  try {
    const result = Bun.spawnSync(["lsof", "-d", "cwd", "-Fpn"]);
    return result.stdout.toString();
  } catch {
    return "";
  }
}

/**
 * Parse `lsof -d cwd -Fpn` field-mode output into live session processes.
 *
 * Each process's cwd fd appears as a 3-line block: `p<pid>`, `f<fd>`, `n<path>`.
 * A path is a session-workspace hit when it is `sessionsDir` itself or nested
 * under it (e.g. `<sessionsDir>/<sessionId>/infra` — a subdirectory cwd still
 * belongs to that session). The session id is the first path segment after
 * `sessionsDir`.
 */
export function parseLsofCwdOutput(raw: string, sessionsDir: string): LiveSessionProcess[] {
  const normalizedRoot = sessionsDir.endsWith("/") ? sessionsDir : `${sessionsDir}/`;
  const lines = raw.split("\n");

  const results: LiveSessionProcess[] = [];
  let currentPid: number | undefined;

  for (const line of lines) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isNaN(parsed) ? undefined : parsed;
    } else if (line.startsWith("n") && currentPid !== undefined) {
      const path = line.slice(1);
      if (path.startsWith(normalizedRoot)) {
        const rest = path.slice(normalizedRoot.length);
        const sessionId = rest.split("/")[0];
        if (sessionId) {
          results.push({ pid: currentPid, sessionId, cwd: path });
        }
      }
    }
  }

  return results;
}

/**
 * Detect live processes attached to any Minsky session workspace via `lsof -d cwd`.
 * Local-host only (v0) — no remote/mesh detection.
 */
export async function detectLiveSessionProcesses(
  sessionsDir: string,
  runner: LsofRunner = defaultLsofRunner
): Promise<LiveSessionProcess[]> {
  const raw = await runner();
  return parseLsofCwdOutput(raw, sessionsDir);
}
