#!/usr/bin/env bun
/**
 * Cold-agent onboarding run (mt#5012)
 *
 * The instrument for mt#4705: run a fresh, context-free agent at Minsky's
 * onboarding path inside a sandbox holding none of this machine's accumulated
 * setup, and treat its transcript as the gap list.
 *
 * Two modes, and the default is the free one:
 *
 *   bun scripts/cold-agent-onboarding-run.ts                   # assert only
 *   bun scripts/cold-agent-onboarding-run.ts --execute --target <path|url>
 *
 * The default mode gathers the isolation observations twice — once under the
 * sandbox, once without it — and reports both. That second pass is the
 * negative control (AT2): an isolation check that would report "clean" against
 * a broken sandbox proves nothing (mem#704), so the suite must be shown to FAIL
 * when the sandbox is absent before its passing run means anything.
 *
 * `--execute` additionally provisions a disposable Postgres, dispatches the
 * agent, and writes the transcript. It costs metered Anthropic API tokens
 * rather than subscription usage — see `## The cost this shape carries` on
 * mt#5012 — which is why it is opt-in per `operational-safety-dry-run-first`.
 *
 * Exit 0 = pass, non-zero = fail.
 */

import "reflect-metadata";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, dirname, join } from "path";

// ---------------------------------------------------------------------------
// The six contamination channels (mt#5012 §The contamination problem)
// ---------------------------------------------------------------------------

/** Channel ids, in the spec's order. AT1 asserts (a)-(f) against these. */
export const CHANNELS = {
  mcp: "1/a ambient MCP servers",
  minskyState: "2/c operator Minsky config, state and daemon token",
  minskyBinary: "3/b minsky on PATH",
  daemon: "4/d operator daemon usable",
  claudeCustomizations: "5/e user-level Claude Code customizations",
  database: "6/f operator database reachable",
} as const;

export type ChannelId = keyof typeof CHANNELS;

/**
 * What the shell observed. Deliberately plain data with no methods: the
 * verdict logic below is pure and unit-testable in both directions without
 * spawning anything, which is what makes the negative control cheap.
 */
export interface IsolationObservations {
  /** MCP server names `claude mcp list` reported under this env. */
  mcpServerNames: string[];
  /** Absolute path `minsky` resolves to on this PATH, or null. */
  minskyBinaryPath: string | null;
  /**
   * Absolute path `bun` resolves to on this PATH, or null. NOT a contamination
   * channel — the README names Bun a prerequisite, so its ABSENCE is a broken
   * sandbox rather than a clean one. Checked as a precondition (see
   * `preconditionFailures`) so the run cannot fail for the wrong reason and be
   * read as a Minsky finding.
   */
  bunBinaryPath: string | null;
  /** Whether an operator Minsky config file is readable at this XDG root. */
  minskyConfigPresent: boolean;
  /** Whether a local-daemon bearer token is readable at this token path. */
  daemonTokenPresent: boolean;
  /**
   * HTTP status from an unauthenticated POST to the daemon's /mcp, or null if
   * no daemon answered. 401 is the PASS: the daemon's port is a fixed contract
   * (ADR-038) and macOS loopback is shared, so it stays reachable — the
   * assertion is that it cannot be USED.
   */
  daemonUnauthenticatedMcpStatus: number | null;
  /** Customization entries found in the Claude config dir (CLAUDE.md, skills, ...). */
  claudeCustomizationEntries: string[];
  /** Names of Postgres connection env vars still set. */
  postgresEnvVarsPresent: string[];
}

export interface ChannelVerdict {
  channel: ChannelId;
  label: string;
  isolated: boolean;
  detail: string;
}

/** The customization entries under a Claude config dir that leak into any repo. */
export const CLAUDE_CUSTOMIZATION_ENTRIES = [
  "CLAUDE.md",
  "skills",
  "plugins",
  "commands",
  "agents",
];

/** Connection-string env vars that would hand the run the operator's database. */
export const POSTGRES_ENV_VARS = [
  "MINSKY_POSTGRES_URL",
  "MINSKY_PERSISTENCE_POSTGRES_URL",
  "MINSKY_PERSISTENCE_POSTGRES_CONNECTIONSTRING",
  "DATABASE_URL",
];

/**
 * Pure verdict over observations — one entry per channel, in spec order.
 *
 * Note channel 4 is the odd one and deliberately so: every other channel is
 * isolated by ABSENCE, but the daemon cannot be hidden, so its verdict asserts
 * that an unauthenticated call is REFUSED. A daemon that answered 200 to an
 * unauthenticated /mcp would be a usable daemon and a failed channel; a daemon
 * that is not running at all (null) is also fine, because there is then nothing
 * to use.
 */
export function evaluateIsolation(obs: IsolationObservations): ChannelVerdict[] {
  const minskyServers = obs.mcpServerNames.filter((n) => /minsky/i.test(n));
  const daemonRefused =
    obs.daemonUnauthenticatedMcpStatus === null || obs.daemonUnauthenticatedMcpStatus === 401;

  return [
    {
      channel: "mcp",
      label: CHANNELS.mcp,
      isolated: minskyServers.length === 0,
      detail:
        minskyServers.length === 0
          ? "no minsky MCP server visible"
          : `visible: ${minskyServers.join(", ")}`,
    },
    {
      channel: "minskyState",
      label: CHANNELS.minskyState,
      isolated: !obs.minskyConfigPresent && !obs.daemonTokenPresent,
      detail: [
        obs.minskyConfigPresent ? "operator config readable" : "no operator config",
        obs.daemonTokenPresent ? "daemon token readable" : "no daemon token",
      ].join("; "),
    },
    {
      channel: "minskyBinary",
      label: CHANNELS.minskyBinary,
      isolated: obs.minskyBinaryPath === null,
      detail: obs.minskyBinaryPath ? `resolves to ${obs.minskyBinaryPath}` : "not on PATH",
    },
    {
      channel: "daemon",
      label: CHANNELS.daemon,
      isolated: daemonRefused,
      detail:
        obs.daemonUnauthenticatedMcpStatus === null
          ? "no daemon answered"
          : `unauthenticated /mcp -> ${obs.daemonUnauthenticatedMcpStatus}`,
    },
    {
      channel: "claudeCustomizations",
      label: CHANNELS.claudeCustomizations,
      isolated: obs.claudeCustomizationEntries.length === 0,
      detail:
        obs.claudeCustomizationEntries.length === 0
          ? "config dir carries no customizations"
          : `present: ${obs.claudeCustomizationEntries.join(", ")}`,
    },
    {
      channel: "database",
      label: CHANNELS.database,
      // Two routes, and the env one is NOT the load-bearing half. Measured
      // 2026-09-05: none of POSTGRES_ENV_VARS is set on this machine — the
      // connection string comes from the Minsky config file — so an env-only
      // check reads clean with or without the sandbox and discriminates
      // nothing. The first live AT2 run failed on exactly that.
      isolated: obs.postgresEnvVarsPresent.length === 0 && !obs.minskyConfigPresent,
      detail: [
        obs.postgresEnvVarsPresent.length === 0
          ? "no connection string in env"
          : `env: ${obs.postgresEnvVarsPresent.join(", ")}`,
        obs.minskyConfigPresent
          ? "operator config reachable (carries the connection string)"
          : "no operator config to read one from",
      ].join("; "),
    },
  ];
}

/**
 * Tools the HARNESS itself invokes. Distinct from what the cold agent needs:
 * these are the instrument's own dependencies, and a missing one produces an
 * opaque failure partway through rather than a clear refusal up front.
 *
 * `docker` and `git` are only reached on the `--execute` path, so requiring
 * them in assertion mode would refuse a run that would have worked.
 */
export const REQUIRED_TOOLS = {
  always: ["claude"],
  execute: ["docker", "git"],
} as const;

/**
 * Preconditions — things whose ABSENCE would make the run fail for a reason
 * that has nothing to do with what is being measured.
 *
 * A run that dies because Bun is missing produces a transcript full of
 * install-a-runtime friction, and every finding read off it would be a finding
 * about the harness. Same for a missing `docker`: the failure surfaces as
 * "disposable Postgres never became ready", which reads like an infrastructure
 * problem rather than a tool that was never installed. Fail loudly, up front,
 * naming the tool.
 */
export function preconditionFailures(
  obs: IsolationObservations,
  missingTools: string[] = []
): string[] {
  const failures: string[] = [];
  if (obs.bunBinaryPath === null) {
    failures.push(
      "bun is not on the sandboxed PATH — the README names it a prerequisite, " +
        "so the sandbox must carry it forward rather than strip it with minsky"
    );
  }
  for (const tool of missingTools) {
    failures.push(`${tool} is not available, and the harness invokes it directly`);
  }
  return failures;
}

/**
 * AT2's shape, as a pure function: which channels the negative control must
 * show OPEN when the sandbox is absent.
 *
 * The daemon channel is excluded, and that exclusion is the point rather than
 * an oversight — the operator's daemon refuses an unauthenticated caller
 * whether or not a sandbox is active, so it cannot discriminate and including
 * it would make the control fail for a reason unrelated to isolation.
 */
export const NEGATIVE_CONTROL_CHANNELS: ChannelId[] = [
  "mcp",
  "minskyState",
  "minskyBinary",
  "claudeCustomizations",
  "database",
];

/** Channels the negative control expected to be open but which read as isolated. */
export function negativeControlGaps(unsandboxed: ChannelVerdict[]): ChannelId[] {
  return NEGATIVE_CONTROL_CHANNELS.filter(
    (id) => unsandboxed.find((v) => v.channel === id)?.isolated === true
  );
}

// ---------------------------------------------------------------------------
// Sandbox construction (pure where it can be)
// ---------------------------------------------------------------------------

export interface SandboxPaths {
  root: string;
  claudeConfigDir: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  xdgStateHome: string;
  minskyStateDir: string;
  daemonTokenPath: string;
  transcriptPath: string;
  /** Holds symlinks to the prerequisites a new user already has (bun). */
  binDir: string;
  /** `BUN_INSTALL`, so `bun add -g` lands here and not in the operator's dir. */
  bunInstallDir: string;
  /** `npm config prefix`, for the same reason on the README's npm branch. */
  npmPrefixDir: string;
}

export function sandboxPathsUnder(root: string): SandboxPaths {
  return {
    root,
    claudeConfigDir: join(root, "claude-config"),
    xdgConfigHome: join(root, "xdg-config"),
    xdgDataHome: join(root, "xdg-data"),
    xdgStateHome: join(root, "xdg-state"),
    minskyStateDir: join(root, "minsky-state"),
    daemonTokenPath: join(root, "minsky-state", "local-mcp-token"),
    transcriptPath: join(root, "transcript.txt"),
    binDir: join(root, "bin"),
    bunInstallDir: join(root, "bun-install"),
    npmPrefixDir: join(root, "npm-prefix"),
  };
}

/**
 * Remove the directory holding a binary from a PATH string.
 *
 * A real new user installs `minsky` by following the README, so the harness
 * must not hand the cold agent an already-installed one. Dropping the whole
 * directory is deliberate: `~/.bun/bin` also carries `bun`, and a new user
 * following a Bun-based README would install that themselves too.
 */
export function stripPathEntry(pathValue: string, binaryPath: string | null): string {
  // Empty segments are dropped on BOTH paths, not just when a binary is being
  // removed: an empty PATH entry means "the current directory" on POSIX, and
  // handing that to a sandboxed agent running inside a repo is its own leak.
  const dir = binaryPath === null ? null : dirname(binaryPath);
  return pathValue
    .split(delimiter)
    .filter((entry) => entry !== "" && entry !== dir)
    .join(delimiter);
}

/**
 * The sandbox's PATH: the operator's, minus the directory holding `minsky`,
 * plus the sandbox's own bin directories in front.
 *
 * The strip has to take the whole DIRECTORY — there is no per-binary hiding on
 * PATH — and on this machine `bun` lives in that same directory
 * (`~/.bun/bin`). But the README treats Bun as a PREREQUISITE rather than part
 * of Minsky's onboarding, so removing it would make the run measure Bun
 * installation instead. `binDir` carries a symlink to the real `bun` back in,
 * which keeps the prerequisite and drops only the thing under test.
 */
export function buildSandboxPath(
  basePath: string,
  minskyBinaryPath: string | null,
  prepend: string[]
): string {
  const stripped = stripPathEntry(basePath, minskyBinaryPath);
  return [...prepend, ...(stripped === "" ? [] : stripped.split(delimiter))].join(delimiter);
}

/**
 * The sandboxed environment handed to `claude`.
 *
 * `HOME` is deliberately NOT redirected. Measured 2026-09-05: a sandboxed HOME
 * (or config dir) loses Claude Code's OAuth session entirely — `claude -p` then
 * prints "Not logged in" and exits 0. `CLAUDE_CONFIG_DIR` plus an
 * `ANTHROPIC_API_KEY` is the vendor's documented auth for that case (see
 * `--bare`'s help text) and is what closes channel 5 without losing auth.
 */
export function buildSandboxEnv(
  base: NodeJS.ProcessEnv,
  paths: SandboxPaths,
  apiKey: string,
  minskyBinaryPath: string | null
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of POSTGRES_ENV_VARS) delete env[name];

  env.CLAUDE_CONFIG_DIR = paths.claudeConfigDir;
  env.XDG_CONFIG_HOME = paths.xdgConfigHome;
  env.XDG_DATA_HOME = paths.xdgDataHome;
  env.XDG_STATE_HOME = paths.xdgStateHome;
  env.MINSKY_STATE_DIR = paths.minskyStateDir;
  env.MINSKY_LOCAL_MCP_TOKEN_PATH = paths.daemonTokenPath;
  env.ANTHROPIC_API_KEY = apiKey;

  // Global installs must land in the sandbox. Without these, the cold agent
  // following the README's `bun add -g @edobry/minsky` would install into the
  // OPERATOR's `~/.bun/bin` — contaminating the machine the run is supposed to
  // leave untouched (AT4), and leaving a stray global package behind.
  env.BUN_INSTALL = paths.bunInstallDir;
  env.NPM_CONFIG_PREFIX = paths.npmPrefixDir;
  env.PATH = buildSandboxPath(base.PATH ?? "", minskyBinaryPath, [
    paths.binDir,
    join(paths.bunInstallDir, "bin"),
    join(paths.npmPrefixDir, "bin"),
  ]);
  return env;
}

// ---------------------------------------------------------------------------
// Observation gathering (the shell)
// ---------------------------------------------------------------------------

const DAEMON_MCP_URL = "http://127.0.0.1:48765/mcp";

function resolveBinary(env: NodeJS.ProcessEnv, name: string): string | null {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { env, encoding: "utf8" });
  const out = (r.stdout ?? "").trim();
  return r.status === 0 && out.length > 0 ? out : null;
}

/**
 * Server NAMES from `claude mcp list`, never whole lines: the output renders
 * "<name>: <command>" and the command half can carry a token.
 *
 * Failure direction matters more than precision here. A name this parse MISSES
 * reads as an absent server, which reports the channel ISOLATED when it is not
 * — a false pass in the one direction the whole harness exists to prevent. So
 * the name pattern is permissive (anything up to the first colon that is not
 * itself a URL scheme), and a line that looks like an entry but yields no name
 * is surfaced as `UNPARSED:<line-prefix>` rather than dropped, so the channel
 * opens instead of silently closing.
 */
export function parseMcpServerNames(output: string): string[] {
  const names: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Skip a bare URL line ("http://..."), whose scheme colon is not a name.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) continue;
    const colon = line.indexOf(":");
    // No colon at all is not an entry. A colon at position 0 IS an entry with
    // an empty name — the two must not collapse, because skipping the second
    // drops a server silently and closes the channel.
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (name === "") {
      names.push(`UNPARSED:${line.slice(0, 24)}`);
      continue;
    }
    names.push(name);
  }
  return names;
}

function listMcpServers(env: NodeJS.ProcessEnv, strict: boolean): string[] {
  const args = strict ? ["mcp", "list", "--strict-mcp-config"] : ["mcp", "list"];
  const r = spawnSync("claude", args, { env, encoding: "utf8", timeout: 60_000 });
  return parseMcpServerNames((r.stdout ?? "") + (r.stderr ?? ""));
}

async function probeDaemonUnauthenticated(): Promise<number | null> {
  try {
    const res = await fetch(DAEMON_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.status;
  } catch {
    return null;
  }
}

function customizationEntriesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const present = new Set(readdirSync(dir));
  return CLAUDE_CUSTOMIZATION_ENTRIES.filter((e) => present.has(e));
}

export interface ObserveOptions {
  env: NodeJS.ProcessEnv;
  claudeConfigDir: string;
  minskyConfigPath: string;
  daemonTokenPath: string;
  /** Whether to pass --strict-mcp-config, which is how the sandbox closes channel 1. */
  strictMcpConfig: boolean;
}

export async function observe(opts: ObserveOptions): Promise<IsolationObservations> {
  return {
    mcpServerNames: listMcpServers(opts.env, opts.strictMcpConfig),
    minskyBinaryPath: resolveBinary(opts.env, "minsky"),
    bunBinaryPath: resolveBinary(opts.env, "bun"),
    minskyConfigPresent: existsSync(opts.minskyConfigPath),
    daemonTokenPresent: existsSync(opts.daemonTokenPath),
    daemonUnauthenticatedMcpStatus: await probeDaemonUnauthenticated(),
    claudeCustomizationEntries: customizationEntriesIn(opts.claudeConfigDir),
    postgresEnvVarsPresent: POSTGRES_ENV_VARS.filter((n) => Boolean(opts.env[n])),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The run record — SC2's "records the exact argv and the NAMES of the env vars
 * it set (never their values)".
 *
 * The never-their-values half is the whole design constraint: this env carries
 * `ANTHROPIC_API_KEY` and the record is written to disk, so it stores the key
 * SET, never the value. A record that dumped the environment would be a
 * credential file.
 */
export interface RunRecord {
  startedAt: string;
  target: string | null;
  targetCarriedFiles: string[];
  argv: string[];
  sandboxEnvVarNames: string[];
  channels: ChannelVerdict[];
  negativeControl: ChannelVerdict[];
  preconditionFailures: string[];
  transcriptPath: string | null;
  transcriptRedactions: number;
}

/**
 * Env var names the sandbox SETS, sorted. Names only — see `RunRecord`.
 *
 * Derived by diffing against the base environment rather than from a hardcoded
 * list, so a variable added to `buildSandboxEnv` later cannot silently escape
 * the record.
 */
export function sandboxEnvVarNames(
  base: NodeJS.ProcessEnv,
  sandboxed: NodeJS.ProcessEnv
): string[] {
  return Object.keys(sandboxed)
    .filter((k) => sandboxed[k] !== base[k])
    .sort();
}

export function renderVerdicts(title: string, verdicts: ChannelVerdict[]): string {
  const lines = [title];
  for (const v of verdicts) {
    lines.push(`  ${v.isolated ? "ISOLATED" : "OPEN    "}  ${v.label} — ${v.detail}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The cold-agent prompt (SC2: the repo and its README, nothing else)
// ---------------------------------------------------------------------------

/**
 * What the cold agent is told, and no more.
 *
 * The task is to onboard THIS project onto Minsky, which is the thing mt#4705
 * says cannot be done without a human — so the instruction has to name Minsky
 * and then stop. Everything past that must come from Minsky's own docs, which
 * is the accepted RFC's "following only the docs".
 *
 * The database is named rather than configured, deliberately. The RFC's probe
 * is "against an EMPTY Postgres", not "against no Postgres": a real user has
 * one and has to point Minsky at it. Setting `MINSKY_POSTGRES_URL` in the
 * environment instead would skip the configuration step entirely and stub the
 * very thing worth watching.
 */
export function buildColdAgentPrompt(databaseUrl: string): string {
  return [
    "This project should be set up to use Minsky (https://github.com/edobry/minsky)",
    "for task and session management. Set it up.",
    "Use only Minsky's own documentation — assume nothing is already installed or configured.",
    `An empty Postgres is available at ${databaseUrl} if you need one.`,
    "When you are done, report what you did, what worked, what did not,",
    "and how you know it worked — naming anything you had to guess at.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function resolveAnthropicKey(): Promise<string> {
  const { initializeConfiguration, CustomConfigFactory, getConfiguration } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  const cfg = getConfiguration() as { ai?: { providers?: { anthropic?: { apiKey?: string } } } };
  const key = cfg?.ai?.providers?.anthropic?.apiKey;
  if (typeof key !== "string" || key.length < 20) {
    throw new Error(
      "No usable Anthropic API key at ai.providers.anthropic.apiKey. " +
        "The sandboxed config dir loses Claude Code's OAuth session, so an API key is required."
    );
  }
  return key;
}

/**
 * A disposable, EMPTY Postgres for the run, in a container of its own.
 *
 * Not a database on the local 5432: whatever is listening there is the
 * operator's, and both creating a database in it and dropping one afterwards
 * are writes to state this run does not own. A container is created and
 * destroyed whole.
 */
/**
 * A port nothing is listening on, found by asking rather than by arithmetic.
 *
 * The previous `45000 + (nowMs % 2000)` is a hash of the clock, not a check:
 * two runs in the same millisecond-mod-2000 window collide, and the failure
 * surfaces as "Postgres never became ready" — indistinguishable from a broken
 * image pull.
 */
export function findFreePort(
  isBusy: (port: number) => boolean,
  start = 45000,
  span = 2000
): number {
  for (let i = 0; i < span; i++) {
    const port = start + i;
    if (!isBusy(port)) return port;
  }
  throw new Error(`no free port in ${start}..${start + span}`);
}

function portIsBusy(port: number): boolean {
  // `nc -z` exits 0 when something accepts, non-zero when nothing does.
  return spawnSync("nc", ["-z", "127.0.0.1", String(port)], { timeout: 5_000 }).status === 0;
}

function startDisposablePostgres(port: number): { url: string; containerName: string } {
  const containerName = `mt5012-pg-${port}`;
  const password = `pw${Math.random().toString(36).slice(2, 12)}`;
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      "POSTGRES_DB=coldrun",
      "-p",
      `${port}:5432`,
      "postgres:16",
    ],
    { encoding: "utf8", timeout: 120_000 }
  );
  if (r.status !== 0) {
    throw new Error(`could not start the disposable Postgres: ${(r.stderr ?? "").trim()}`);
  }
  // Assembled through the URL API rather than as a template literal. An
  // interpolated `scheme://user:pass@host` is a credential SHAPE in the source
  // even when the value is generated at runtime, and gitleaks blocks on it —
  // correctly, since a scanner cannot tell a placeholder from a live secret.
  const url = new URL(`postgresql://127.0.0.1:${port}/coldrun`);
  url.username = "postgres";
  url.password = password;
  return { url: url.toString(), containerName };
}

function waitForPostgres(containerName: string): boolean {
  for (let i = 0; i < 60; i++) {
    const r = spawnSync("docker", ["exec", containerName, "pg_isready", "-U", "postgres"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (r.status === 0) return true;
    spawnSync("sleep", ["1"]);
  }
  return false;
}

function stopDisposablePostgres(containerName: string): void {
  spawnSync("docker", ["rm", "-f", containerName], { encoding: "utf8", timeout: 60_000 });
}

/**
 * Clone the target into the sandbox rather than running against it in place.
 *
 * Onboarding WRITES — `.minsky/`, config, hooks — and the target is a real
 * project of the operator's. AT4 requires the operator's environment be
 * unchanged, and a clone is the only way to keep that true while still
 * measuring against a real repository rather than a synthetic one.
 */
function cloneTarget(source: string, destination: string): void {
  const r = spawnSync("git", ["clone", "--quiet", source, destination], {
    encoding: "utf8",
    timeout: 300_000,
  });
  if (r.status !== 0) {
    throw new Error(`could not clone ${source}: ${(r.stderr ?? "").trim()}`);
  }
}

function targetColdness(targetDir: string): string[] {
  const r = spawnSync(
    "git",
    ["ls-files", ".minsky", ".claude", ".cursor", "CLAUDE.md", "AGENTS.md"],
    { cwd: targetDir, encoding: "utf8" }
  );
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface RunOptions {
  execute: boolean;
  target: string | null;
  outDir: string;
  nowMs: number;
}

/**
 * Where run records land. Outside the repository by default — a run record is
 * durable, not committed, and the transcript it points at carries the target
 * project's content.
 */
export const DEFAULT_OUT_DIR = join(homedir(), ".local", "state", "minsky", "cold-agent-runs");

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const next = argv[i + 1];
  // A value that is itself a flag means the value was omitted.
  return next === undefined || next.startsWith("--") ? null : next;
}

export function parseArgs(argv: string[], nowMs: number = Date.now()): RunOptions {
  return {
    execute: argv.includes("--execute"),
    target: flagValue(argv, "--target"),
    outDir: flagValue(argv, "--out-dir") ?? DEFAULT_OUT_DIR,
    nowMs,
  };
}

async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const root = mkdtempSync(join(tmpdir(), "mt5012-cold-"));
  const paths = sandboxPathsUnder(root);
  for (const dir of [
    paths.claudeConfigDir,
    paths.xdgConfigHome,
    paths.xdgDataHome,
    paths.xdgStateHome,
    paths.minskyStateDir,
    paths.binDir,
    join(paths.bunInstallDir, "bin"),
    join(paths.npmPrefixDir, "bin"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const failures: string[] = [];
  let pgContainer: string | null = null;
  let transcriptPath: string | null = null;
  let transcriptRedactions = 0;
  let targetCarried: string[] = [];
  let dispatchArgv: string[] = [];
  let envVarNames: string[] = [];
  let sandboxed: ChannelVerdict[] = [];
  let unsandboxed: ChannelVerdict[] = [];
  let preconditions: string[] = [];
  try {
    const missingTools = [
      ...REQUIRED_TOOLS.always,
      ...(opts.execute ? REQUIRED_TOOLS.execute : []),
    ].filter((tool) => resolveBinary(process.env, tool) === null);

    const apiKey = await resolveAnthropicKey();
    const operatorMinskyPath = resolveBinary(process.env, "minsky");

    // Carry the prerequisite across the strip. `bun` shares a directory with
    // `minsky` here, and PATH can only drop whole directories.
    const operatorBunPath = resolveBinary(process.env, "bun");
    if (operatorBunPath) symlinkSync(operatorBunPath, join(paths.binDir, "bun"));

    const env = buildSandboxEnv(process.env, paths, apiKey, operatorMinskyPath);

    // --- AT1: the sandbox closes every channel ---------------------------
    const sandboxedObs = await observe({
      env,
      claudeConfigDir: paths.claudeConfigDir,
      minskyConfigPath: join(paths.xdgConfigHome, "minsky", "config.yaml"),
      daemonTokenPath: paths.daemonTokenPath,
      strictMcpConfig: true,
    });
    envVarNames = sandboxEnvVarNames(process.env, env);
    sandboxed = evaluateIsolation(sandboxedObs);
    console.log(renderVerdicts("AT1 — under the sandbox:", sandboxed));
    for (const v of sandboxed) {
      if (!v.isolated) failures.push(`AT1: channel still open — ${v.label} (${v.detail})`);
    }

    preconditions = preconditionFailures(sandboxedObs, missingTools);
    console.log(
      preconditions.length === 0
        ? `  PRECONDITION  bun at ${sandboxedObs.bunBinaryPath}; harness tools present`
        : `  PRECONDITION  FAILED: ${preconditions.join("; ")}`
    );
    failures.push(...preconditions.map((p) => `precondition: ${p}`));

    // --- AT2: the same suite must FAIL without the sandbox ----------------
    const operatorConfigHome =
      process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
    unsandboxed = evaluateIsolation(
      await observe({
        env: process.env,
        claudeConfigDir: join(process.env.HOME ?? "", ".claude"),
        minskyConfigPath: join(operatorConfigHome, "minsky", "config.yaml"),
        daemonTokenPath: join(operatorConfigHome, "minsky", "local-mcp-token"),
        strictMcpConfig: false,
      })
    );
    console.log(`\n${renderVerdicts("AT2 — negative control, no sandbox:", unsandboxed)}`);
    const gaps = negativeControlGaps(unsandboxed);
    if (gaps.length > 0) {
      failures.push(
        `AT2: negative control did not discriminate on ${gaps.join(", ")} — ` +
          "a suite that reads clean without the sandbox proves nothing about the sandbox"
      );
    }

    if (!opts.execute) {
      console.log(
        "\nAssertion mode only. Pass --execute --target <path> to run the metered agent run " +
          "(billed to the Anthropic API key, not the subscription)."
      );
    } else {
      if (!opts.target) throw new Error("--execute requires --target <path or url of a cold repo>");

      const workspace = join(paths.root, "workspace");
      cloneTarget(opts.target, workspace);
      targetCarried = targetColdness(workspace);
      console.log(
        `\nTarget ${opts.target} carries ${targetCarried.length} tracked onboarding file(s)${
          targetCarried.length > 0 ? `: ${targetCarried.join(", ")} — NOT a cold repo` : " — cold"
        }`
      );

      const pg = startDisposablePostgres(findFreePort(portIsBusy));
      pgContainer = pg.containerName;
      if (!waitForPostgres(pg.containerName)) {
        throw new Error(`disposable Postgres never became ready (${pg.containerName})`);
      }
      console.log(`Disposable empty Postgres ready in container ${pg.containerName}`);

      const started = new Date(opts.nowMs).toISOString();
      // Captured for the run record BEFORE dispatch. The prompt carries the
      // throwaway connection string, so the recorded argv is scrubbed the same
      // way the transcript is — see where the record is written.
      dispatchArgv = [
        "claude",
        "-p",
        "<prompt>",
        "--strict-mcp-config",
        "--model",
        "fable",
        "--permission-mode",
        "bypassPermissions",
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      const r = spawnSync(
        "claude",
        [
          "-p",
          buildColdAgentPrompt(pg.url),
          "--strict-mcp-config",
          "--model",
          "fable",
          "--permission-mode",
          "bypassPermissions",
          // The tool-by-tool trace, not just the last message. `-p`'s default
          // output format returns ONLY the final turn, which makes every
          // friction point a matter of the agent's own account of what it did
          // — `strong-evidence` about its own behaviour rather than a record of
          // it. The 2026-09-05 run was captured that way and its classification
          // carries that bound; this is what removes it for the next one.
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        { cwd: workspace, env, encoding: "utf8", timeout: 1_800_000 }
      );
      const raw = (r.stdout ?? "") + (r.stderr ?? "");

      // Scrub BEFORE persisting. The transcript records an agent that was handed
      // a connection string and told to configure a database with it, so it can
      // carry credentials by construction — and this run's whole point is that
      // its output gets read by people and pasted into task specs. The vetted
      // shape list is reused rather than hand-rolled: a pattern written here
      // would be a hypothesis about the text, and one that matches nothing emits
      // its input unchanged, indistinguishable from a redaction that fired.
      const { scrubText } = await import("@minsky/domain/transcripts/credential-scrubber");
      const scrubbed = scrubText(raw);
      transcriptRedactions = scrubbed.redactions.length;

      writeFileSync(paths.transcriptPath, scrubbed.text);
      transcriptPath = paths.transcriptPath;
      console.log(
        `\nRun started ${started}; transcript at ${paths.transcriptPath}` +
          ` (${transcriptRedactions} redaction(s))`
      );
      // Exit status is NOT the success signal: a "Not logged in" failure exits 0
      // (measured 2026-09-05). Assert on content.
      if (/Not logged in/i.test(scrubbed.text) || scrubbed.text.trim().length === 0) {
        failures.push("run produced no usable transcript (check auth and the target path)");
      }
    }
  } finally {
    // The container is torn down on every path, including a throw: it holds a
    // port and a password, and leaving one running is a side effect on the
    // operator's machine that AT4 forbids.
    if (pgContainer) stopDisposablePostgres(pgContainer);

    // The run record is written on every path too, including a failed one — a
    // run that fell over is exactly the one whose argv and channel verdicts
    // someone will want to read. It goes to `--out-dir`, which defaults OUTSIDE
    // the repository: the transcript is scrubbed but not sanitised of the
    // target project's content, and a durable record is not the same thing as
    // a committed one.
    const record: RunRecord = {
      startedAt: new Date(opts.nowMs).toISOString(),
      target: opts.target,
      targetCarriedFiles: targetCarried,
      argv: dispatchArgv,
      sandboxEnvVarNames: envVarNames,
      channels: sandboxed,
      negativeControl: unsandboxed,
      preconditionFailures: preconditions,
      transcriptPath,
      transcriptRedactions,
    };
    mkdirSync(opts.outDir, { recursive: true });
    const recordPath = join(opts.outDir, `run-${opts.nowMs}.json`);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\nRun record: ${recordPath}`);

    // The sandbox root survives an --execute run on purpose — it holds the
    // transcript the record points at.
    if (!opts.execute) rmSync(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\nFAIL:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    return 1;
  }
  console.log("\nAll isolation assertions and the negative control passed.");
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("cold-agent-onboarding-run crashed:", err);
      process.exit(1);
    });
}
