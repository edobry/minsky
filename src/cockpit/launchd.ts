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

/**
 * Resolve the minsky binary path. Prefers the bun-linked binary in the
 * project's node_modules/.bin, falling back to `which minsky`.
 */
function resolveMinskyBinary(): string {
  try {
    const result = String(execSync("which minsky", { encoding: "utf-8" })).trim();
    if (result) return result;
  } catch {
    // fall through
  }
  // Fallback: use bun to run the CLI entry point directly
  try {
    const bunPath = String(execSync("which bun", { encoding: "utf-8" })).trim();
    if (bunPath) return bunPath;
  } catch {
    // fall through
  }
  throw new Error(
    "Cannot find minsky or bun on PATH. " +
      "Ensure minsky is installed globally or bun is available."
  );
}

export interface PlistOptions {
  port?: number;
  /** Absolute path to the minsky repo root (for `--repo` flag). */
  repoPath?: string;
}

/**
 * Generate the launchd plist XML for the cockpit daemon.
 */
export function generatePlist(options: PlistOptions = {}): string {
  const port = options.port ?? DEFAULT_DAEMON_PORT;
  const logDir = getLogDir();
  const stdoutLog = path.join(logDir, "cockpit-stdout.log");
  const stderrLog = path.join(logDir, "cockpit-stderr.log");

  const minskyBin = resolveMinskyBinary();

  // Build the program arguments array.
  // If minsky is a bun script, we need `bun run minsky`; if it's a
  // standalone binary, just `minsky`. Detect by checking if the resolved
  // binary IS bun itself.
  const isBun = path.basename(minskyBin) === "bun";
  const programArgs: string[] = isBun
    ? [minskyBin, "run", "minsky", "cockpit", "start", "--no-dev-chromium", "--port", String(port)]
    : [minskyBin, "cockpit", "start", "--no-dev-chromium", "--port", String(port)];

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
  <string>${escapeXml(options.repoPath ?? process.cwd())}</string>

  <key>ThrottleInterval</key>
  <integer>5</integer>
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
export function installDaemon(options: PlistOptions = {}): {
  plistPath: string;
  port: number;
} {
  const plistPath = getPlistPath();
  const port = options.port ?? DEFAULT_DAEMON_PORT;

  // Ensure log directory exists
  const logDir = getLogDir();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Ensure LaunchAgents directory exists
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

export interface DaemonStatus {
  installed: boolean;
  running: boolean;
  pid: number | null;
  port: number;
  uptime: string | null;
  url: string | null;
  plistPath: string;
}

/**
 * Check the status of the cockpit daemon.
 */
export async function getDaemonStatus(port: number = DEFAULT_DAEMON_PORT): Promise<DaemonStatus> {
  const plistPath = getPlistPath();
  const installed = fs.existsSync(plistPath);

  const base: DaemonStatus = {
    installed,
    running: false,
    pid: null,
    port,
    uptime: null,
    url: `http://localhost:${port}`,
    plistPath,
  };

  if (!installed) return base;

  // Check launchctl for the service status
  let pid: number | null = null;
  try {
    const output = String(
      execSync(`launchctl list ${LAUNCHD_LABEL}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
    );
    const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch && pidMatch[1]) {
      pid = parseInt(pidMatch[1], 10);
    }
  } catch {
    // Service not loaded or not found
  }

  // Probe health endpoint for running status + uptime
  try {
    const resp = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const health = (await resp.json()) as Record<string, unknown>;
      return {
        ...base,
        running: true,
        pid,
        uptime: typeof health["uptime"] === "string" ? health["uptime"] : null,
      };
    }
  } catch {
    // Not responding
  }

  return { ...base, pid };
}
