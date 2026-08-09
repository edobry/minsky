/**
 * launchd plist management for the cockpit daemon (mt#2140).
 *
 * Generates, installs, and uninstalls a macOS LaunchAgent plist that keeps
 * `minsky cockpit start --no-dev-chromium` running as a headless daemon.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export const LAUNCHD_LABEL = "com.minsky.cockpit";
export const DEFAULT_DAEMON_PORT = 3737;

function getLaunchAgentsDir(): string {
  const home = process.env["HOME"];
  if (!home) throw new Error("HOME environment variable not set");
  return path.join(home, "Library", "LaunchAgents");
}

export function getPlistPath(): string {
  return path.join(getLaunchAgentsDir(), `${LAUNCHD_LABEL}.plist`);
}

function getLogDir(): string {
  const home = process.env["HOME"];
  if (!home) throw new Error("HOME environment variable not set");
  return path.join(home, ".local", "state", "minsky", "logs");
}

function resolveBunBinary(): string {
  try {
    const result = String(execSync("which bun", { encoding: "utf-8" })).trim();
    if (result) return result;
  } catch {
    // fall through
  }
  throw new Error("Cannot find bun on PATH. Ensure bun is installed.");
}

export interface PlistOptions {
  port?: number;
  /** Absolute path to the minsky repo root. Required — launchd starts with / as cwd. */
  repoPath: string;
}

/**
 * Generate the launchd plist XML for the cockpit daemon.
 */
export function generatePlist(options: PlistOptions): string {
  const port = options.port ?? DEFAULT_DAEMON_PORT;
  const logDir = getLogDir();
  const stdoutLog = path.join(logDir, "cockpit-stdout.log");
  const stderrLog = path.join(logDir, "cockpit-stderr.log");

  const bunBin = resolveBunBinary();

  // Use bun to run the repo's CLI entry point directly. WorkingDirectory
  // is set to repoPath so src/cli.ts resolves correctly. This avoids
  // relying on a globally installed `minsky` binary.
  // "--watch" is a dev affordance (source-file hot-reload) and must NOT be
  // used in a long-running supervised daemon. KeepAlive is the supervisor here;
  // --watch + KeepAlive is the crash-loop amplifier that caused the 49,650-run
  // incident (gh#1761). The tray's run_supervisor() also no longer uses --watch
  // for the same reason.
  const programArgs: string[] = [
    bunBin,
    "run",
    "src/cli.ts",
    "cockpit",
    "start",
    "--no-dev-chromium",
    "--port",
    String(port),
  ];

  const argsXml = programArgs.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");

  // Environment variables — inherit PATH so bun/node are findable,
  // and pass through HOME for config resolution.
  const envEntries: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? "",
  };
  if (process.env["SUPABASE_URL"]) {
    envEntries["SUPABASE_URL"] = process.env["SUPABASE_URL"];
  }
  if (process.env["SUPABASE_ANON_KEY"]) {
    envEntries["SUPABASE_ANON_KEY"] = process.env["SUPABASE_ANON_KEY"];
  }

  const envXml = Object.entries(envEntries)
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>

  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutLog)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrLog)}</string>

  <key>WorkingDirectory</key>
  <string>${escapeXml(options.repoPath)}</string>

  <key>ThrottleInterval</key>
  <integer>60</integer>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Install the cockpit daemon plist and load it via launchctl.
 */
export function installDaemon(options: PlistOptions): {
  plistPath: string;
  port: number;
} {
  const plistPath = getPlistPath();
  const port = options.port ?? DEFAULT_DAEMON_PORT;

  // Ensure log directory exists. Load-bearing existsSync guard (mt#3186 PR #2301 review,
  // R1): `installDaemon` has no enclosing try/catch, and `logDir` is never touched by any
  // other fs call in this function (it's only interpolated as a string into the plist XML
  // by `generatePlist` — launchd itself opens the log files later, out of process). An
  // unconditional recursive mkdirSync would throw uncaught (ENOTDIR/EACCES) in cases the
  // guarded version doesn't reach, unlike the sibling cleanup task's other 11 sites where
  // the target directory is touched again downstream by an already-uncaught operation.
  const logDir = getLogDir();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Ensure LaunchAgents directory exists. Load-bearing for the same reason as logDir above.
  const launchAgentsDir = getLaunchAgentsDir();
  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  // Unload existing plist if present (idempotent)
  if (fs.existsSync(plistPath)) {
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
    } catch {
      // May not be loaded — fine
    }
  }

  // Write the plist
  const plistContent = generatePlist(options);
  fs.writeFileSync(plistPath, plistContent, "utf-8");

  // Load via launchctl
  execSync(`launchctl load "${plistPath}"`);

  return { plistPath, port };
}

/**
 * Uninstall the cockpit daemon plist and stop the running daemon.
 */
export function uninstallDaemon(): void {
  const plistPath = getPlistPath();

  if (!fs.existsSync(plistPath)) {
    throw new Error(`No cockpit daemon installed (${plistPath} not found)`);
  }

  // Unload (stops the daemon)
  try {
    execSync(`launchctl unload "${plistPath}"`);
  } catch {
    // May already be unloaded
  }

  // Remove the plist file
  fs.unlinkSync(plistPath);
}

/**
 * Stop the cockpit daemon without removing the plist.
 * Polls the health endpoint to verify the process actually stopped.
 * Throws if the daemon is still running after the timeout.
 */
export async function stopDaemon(port: number = DEFAULT_DAEMON_PORT): Promise<void> {
  const plistPath = getPlistPath();

  if (!fs.existsSync(plistPath)) {
    throw new Error(`No cockpit daemon installed (${plistPath} not found)`);
  }

  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch {
    // May already be unloaded
  }

  // Wait until the health endpoint stops responding (up to 3s)
  const stopped = await waitForDown(port);
  if (!stopped) {
    throw new Error(
      `Daemon on port ${port} is still responding after launchctl unload. ` +
        `It may be running outside launchd — check with \`lsof -i :${port}\`.`
    );
  }
}

/**
 * Restart the cockpit daemon (unload + reload the existing plist).
 * Waits for the process to stop before reloading.
 */
export async function restartDaemon(port: number = DEFAULT_DAEMON_PORT): Promise<void> {
  const plistPath = getPlistPath();

  if (!fs.existsSync(plistPath)) {
    throw new Error(`No cockpit daemon installed (${plistPath} not found)`);
  }

  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch {
    // May not be loaded
  }

  await waitForDown(port);
  execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" });
}

async function waitForDown(port: number, attempts = 6): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const resp = await fetch(`http://localhost:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (!resp.ok) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * Which lifecycle owns the daemon that is currently answering.
 *
 * ADR-014 makes the tray app the canonical supervisor and keeps launchd as an
 * opt-in headless mode, so "not launchd" is a supported configuration rather
 * than a broken install — which is why this is a separate field from
 * `installed` instead of being inferred from it.
 */
export type DaemonSupervisor = "launchd" | "external";

export interface DaemonStatus {
  /** A launchd agent is installed. Independent of whether anything is serving. */
  installed: boolean;
  running: boolean;
  pid: number | null;
  port: number;
  uptime: string | null;
  commit: string | null;
  url: string | null;
  plistPath: string;
  /** How the answering daemon is supervised; null when nothing answers. */
  supervisor: DaemonSupervisor | null;
}

/** The three observations `resolveDaemonStatus` decides from. */
export interface DaemonStatusProbes {
  plistExists(plistPath: string): boolean;
  /** PID launchd reports for our label, or null when the agent is not loaded. */
  launchctlPid(): number | null;
  /** Health fields when the port answers, or null when it does not. */
  health(port: number): Promise<{ uptime: string | null; commit: string | null } | null>;
}

/**
 * Decide the daemon's status from three observations.
 *
 * Separated from the IO below so the decision is testable without patching
 * `fs`, `execSync`, or `fetch` in place (ADR-036).
 *
 * The load-bearing ordering: the health probe runs REGARDLESS of whether a
 * plist exists. Gating it on plist existence made a tray-supervised or
 * hand-started daemon report as "not installed" while it was serving — the
 * split-ownership symptom ADR-014 exists to end, and the state that blocked
 * remediation during the 2026-08-04 outage (mt#3682).
 */
export async function resolveDaemonStatus(
  port: number,
  plistPath: string,
  probes: DaemonStatusProbes
): Promise<DaemonStatus> {
  const installed = probes.plistExists(plistPath);
  // Only meaningful with an agent installed; without one there is no label to
  // ask launchd about.
  const pid = installed ? probes.launchctlPid() : null;

  const base: DaemonStatus = {
    installed,
    running: false,
    pid,
    port,
    uptime: null,
    commit: null,
    url: `http://localhost:${port}`,
    plistPath,
    supervisor: null,
  };

  const health = await probes.health(port);
  if (!health) return base;

  return {
    ...base,
    running: true,
    uptime: health.uptime,
    commit: health.commit,
    // launchd is credited only when it is actually holding the process. A
    // loaded agent with no PID beside a port that answers means something else
    // won the bind, which ADR-014's single-owner invariant permits.
    supervisor: pid !== null ? "launchd" : "external",
  };
}

const realProbes: DaemonStatusProbes = {
  plistExists: (plistPath) => fs.existsSync(plistPath),
  launchctlPid: () => {
    try {
      const output = String(
        execSync(`launchctl list ${LAUNCHD_LABEL}`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
      );
      const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
      return pidMatch && pidMatch[1] ? parseInt(pidMatch[1], 10) : null;
    } catch {
      // Agent not loaded, or launchctl unavailable.
      return null;
    }
  },
  health: async (port) => {
    try {
      const resp = await fetch(`http://localhost:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) return null;
      const health = (await resp.json()) as Record<string, unknown>;
      return {
        uptime: typeof health["uptime"] === "string" ? health["uptime"] : null,
        commit: typeof health["commit"] === "string" ? health["commit"] : null,
      };
    } catch {
      // Nothing answering on the port.
      return null;
    }
  },
};

/**
 * Check the status of the cockpit daemon.
 */
export async function getDaemonStatus(
  port: number = DEFAULT_DAEMON_PORT,
  probes: DaemonStatusProbes = realProbes
): Promise<DaemonStatus> {
  return resolveDaemonStatus(port, getPlistPath(), probes);
}
