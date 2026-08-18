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

/*
 * `restartDaemon` was here until mt#4232, and is deliberately NOT replaced by a
 * launchd-flavoured equivalent.
 *
 * It opened with the same `existsSync(plistPath)` throw as `stopDaemon` above,
 * which made `minsky cockpit restart` unusable under the tray-supervised setup
 * ADR-014 calls the default — the whole defect mt#4232 fixes. Restart now lives
 * in `./daemon-restart.ts` and is supervision-INDEPENDENT: it signals the
 * serving pid, which both supervisors already respond to by respawning.
 *
 * Its single caller (`src/commands/cockpit/restart-command.ts`) was rewired in
 * the same change, so nothing imports it. Leaving it exported would re-offer the
 * launchd-only path to the next caller, which is how the asymmetry arose in the
 * first place: `status` was rebuilt to model both supervisors after the
 * 2026-08-04 outage and these two were simply never revisited.
 *
 * `stopDaemon` above SURVIVES, and that asymmetry is intentional — `launchctl
 * unload` is the only stop launchd honours, since its plist's
 * `KeepAlive SuccessfulExit:false` would undo a signal ~60s later.
 */

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
  /**
   * The serving process, under EITHER supervisor (mt#4232).
   *
   * Was null for anything launchd did not hold, because launchctl was the only
   * PID source here and `/api/health` carried none — the earmark this comment
   * used to record, deferring the field to "the health surface's own task".
   * That task was mt#4232: the payload now carries `pid`, so the external case
   * reads it from health instead of reporting a blank.
   *
   * Still null when nothing answers and no agent is loaded, which is the honest
   * reading rather than a gap.
   */
  pid: number | null;
  port: number;
  uptime: string | null;
  commit: string | null;
  url: string | null;
  /** The path checked for the launchd agent — reported so `installed: false` is falsifiable. */
  plistPath: string;
  /**
   * How the answering daemon is supervised; null when nothing answers.
   *
   * Additive to this struct, which `cockpit status --json` prints verbatim:
   * every previously-emitted field keeps its name, type, and meaning, so a
   * consumer reading the old shape is unaffected.
   */
  supervisor: DaemonSupervisor | null;
}

/** The three observations `resolveDaemonStatus` decides from. */
export interface DaemonStatusProbes {
  plistExists(plistPath: string): boolean;
  /** PID launchd reports for our label, or null when the agent is not loaded. */
  launchctlPid(): number | null;
  /**
   * Health fields when the port answers, or null when it does not.
   *
   * `pid` is optional because it is only present on a daemon running mt#4232 or
   * later — and the daemon you are asking about is very often the STALE one you
   * are about to restart, which is exactly the case that predates the field.
   */
  health(
    port: number
  ): Promise<{ uptime: string | null; commit: string | null; pid?: number | null } | null>;
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
    // launchd's PID wins when it has one — it is the supervisor's own record.
    // Otherwise fall back to the daemon's self-reported `pid` (mt#4232), which
    // is what makes the tray-supervised case report a process instead of a
    // blank. `?? null` keeps the field's type honest for a daemon too old to
    // carry it.
    pid: pid ?? health.pid ?? null,
    // launchd is credited only when it is actually holding the process. A
    // loaded agent with no PID beside a port that answers means something else
    // won the bind, which ADR-014's single-owner invariant permits.
    //
    // Note this still keys on launchctl's PID, NOT on the merged field above:
    // health's pid is present under BOTH supervisors, so deciding from it would
    // credit launchd for every serving daemon.
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
      return { uptime: readUptime(health), commit: readCommit(health), pid: readPid(health) };
    } catch {
      // Nothing answering on the port.
      return null;
    }
  },
};

/**
 * `/api/health` reports `uptimeSec` as a NUMBER (routes/health.ts). Reading a
 * string `uptime` — which the payload has never carried — meant this field was
 * silently null on every healthy daemon, next to a `commit` that populated
 * correctly. The string form is still accepted in case a future payload adds
 * one, so the reader is not re-broken by the reverse mismatch.
 */
export function readUptime(health: Record<string, unknown>): string | null {
  if (typeof health["uptime"] === "string") return health["uptime"];
  const seconds = health["uptimeSec"];
  return typeof seconds === "number" && Number.isFinite(seconds) ? formatUptime(seconds) : null;
}

function readCommit(health: Record<string, unknown>): string | null {
  return typeof health["commit"] === "string" ? health["commit"] : null;
}

/**
 * The serving process's pid from `/api/health` (mt#4232), or null.
 *
 * Null covers two DIFFERENT states that this reader deliberately does not try
 * to tell apart, because no caller can act on the difference: a daemon whose
 * build predates the field, and a payload where it is present but unusable.
 * Both mean "no pid available from health" — callers that need one anyway fall
 * back to resolving it from the port.
 *
 * `Number.isInteger` rather than `typeof === "number"`: NaN and Infinity are
 * both numbers and neither is a pid, and `process.kill` on one throws rather
 * than returning an error we could report.
 */
export function readPid(health: Record<string, unknown>): number | null {
  const pid = health["pid"];
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Seconds to a compact "2d 3h 4m" / "5m" form; sub-minute reads as "<1m". */
export function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(" ") : "<1m";
}

/**
 * Check the status of the cockpit daemon.
 */
export async function getDaemonStatus(
  port: number = DEFAULT_DAEMON_PORT,
  probes: DaemonStatusProbes = realProbes
): Promise<DaemonStatus> {
  return resolveDaemonStatus(port, getPlistPath(), probes);
}
