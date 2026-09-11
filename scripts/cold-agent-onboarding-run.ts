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
 * agent, and writes the transcript. It is opt-in per
 * `operational-safety-dry-run-first` because it runs a real agent against a real
 * repo, not because of what it costs: since mt#5018 it authenticates with the
 * operator's Claude subscription when one is configured, which is $0 marginal
 * within plan limits. Metered API credits are the FALLBACK, used only when no
 * subscription token is stored, and every run prints which one it is using.
 *
 * Exit 0 = pass, non-zero = fail.
 */

// Side-effect import, NOT unused: `resolveAnthropicKey` dynamically imports
// `@minsky/domain/configuration`, which reaches tsyringe, which throws
// "tsyringe requires a reflect polyfill. Please add 'import
// \"reflect-metadata\"' to the top of your entry point." without it. Observed
// while building this script. It references no symbol, which is exactly why it
// looks removable — a reviewer flagged it as unused on PR #3661 R2.
import "reflect-metadata";
import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, delimiter, dirname, join } from "path";
// mt#5066: the `.claude.json` Claude Code reads follows `CLAUDE_CONFIG_DIR`, and
// so must the probe that claims the channel is closed — and Minsky's own writers,
// which this same task pointed at the same resolver.
import { resolveClaudeJsonPath } from "@minsky/domain/mcp/claude-code-paths";
// PR #3680 R1. A git remote can carry credentials in its userinfo
// (`https://user:token@github.com/...`), and this harness both LOGS its
// workspace origin and PERSISTS it in a record whose stated design constraint is
// "names, never values". Imported rather than re-implemented: this function's
// own docblock is explicit that it is the single source of truth, "centralized
// so the masking regex cannot drift between call sites" — and the drift it
// records (a copy that failed to mask an EMPTY username, `://:pass@host`) is
// exactly what a fresh local regex here would have reproduced.
import { maskConnectionString } from "@minsky/domain/persistence/connection-string";

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

/** See `IsolationObservations.daemonProbe`. */
export type DaemonProbeResult =
  | { kind: "status"; code: number }
  | { kind: "refused" }
  | { kind: "error"; reason: string };

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
   * Outcome of an unauthenticated POST to the daemon's /mcp.
   *
   * Three cases, and collapsing the last two is a false pass. `status` carries
   * what the daemon answered — 401 is the PASS, because the port is a fixed
   * contract (ADR-038) on shared loopback, so the assertion is that the daemon
   * cannot be USED rather than that it is unreachable. `refused` means nothing
   * is listening, which is genuinely isolated. `error` means the probe did not
   * complete — a timeout, a DNS failure, anything — and says NOTHING about the
   * daemon; treating it as a pass is exactly mem#704's can't-fail probe, so it
   * fails closed.
   */
  daemonProbe: DaemonProbeResult;
  /** Customization entries found in the Claude config dir (CLAUDE.md, skills, ...). */
  claudeCustomizationEntries: string[];
  /**
   * User-scope MCP server NAMES in the `.claude.json` Claude Code will read under
   * this env — never values (mt#5066). The customizations DIRECTORY above is not
   * where `minsky setup` writes; this file is, and until mt#5066 channel 5 never
   * looked at it. `UNPARSED:<file>` marks a file that exists and could not be
   * read, so an unreadable file OPENS the channel instead of closing it.
   */
  userScopeMcpServerNames: string[];
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
  // AT1(d) requires a 401. "Nothing listening" also isolates — there is then no
  // daemon to use — but a probe that did not COMPLETE is not evidence either
  // way and must not read as a pass.
  const daemonRefused =
    (obs.daemonProbe.kind === "status" && obs.daemonProbe.code === 401) ||
    obs.daemonProbe.kind === "refused";
  const daemonDetail =
    obs.daemonProbe.kind === "status"
      ? `unauthenticated /mcp -> ${obs.daemonProbe.code}`
      : obs.daemonProbe.kind === "refused"
        ? "nothing listening on the daemon port"
        : `probe did not complete (${obs.daemonProbe.reason}) — cannot be read as isolated`;

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
      detail: daemonDetail,
    },
    {
      channel: "claudeCustomizations",
      label: CHANNELS.claudeCustomizations,
      // Two halves, both required (mt#5066): the customizations DIRECTORY and
      // the user-scope `.claude.json`. The 2026-09-10 run read ISOLATED on a
      // clean directory while the file `minsky setup` writes was never checked.
      isolated:
        obs.claudeCustomizationEntries.length === 0 && obs.userScopeMcpServerNames.length === 0,
      detail: [
        obs.claudeCustomizationEntries.length === 0
          ? "config dir carries no customizations"
          : `present: ${obs.claudeCustomizationEntries.join(", ")}`,
        obs.userScopeMcpServerNames.length === 0
          ? ".claude.json carries no user-scope MCP servers"
          : `.claude.json user-scope MCP servers: ${obs.userScopeMcpServerNames.join(", ")}`,
      ].join("; "),
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
  // `nc` is used by the free-port probe, which only runs under --execute. It is
  // listed because R1's generalization missed it: the point of moving from a
  // per-tool check to a declared set is that the set is the ONE place to look,
  // and a tool invoked but undeclared defeats that.
  always: ["claude"],
  execute: ["docker", "git", "nc"],
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
 * (or config dir) loses Claude Code's OAuth **session** entirely — `claude -p`
 * then prints "Not logged in" and exits 0. That session is Keychain-backed and
 * does not follow a relocated config dir.
 *
 * **That does NOT force metered API auth (mt#5018).** The docblock here used to
 * say `CLAUDE_CONFIG_DIR` plus an `ANTHROPIC_API_KEY` was "the vendor's
 * documented auth for that case (see `--bare`'s help text)". Both halves were
 * wrong. `--bare`'s sentence is about `--bare`'s OWN auth restrictions, not
 * about relocated config dirs; and Anthropic documents a second mechanism for
 * exactly this case — `CLAUDE_CODE_OAUTH_TOKEN`, a long-lived subscription token
 * from `claude setup-token`, passed in the environment. A token in the env is
 * not a session on disk, so relocating the config dir does not disturb it.
 *
 * Verified live 2026-09-08: sandboxed config dir + `CLAUDE_CODE_OAUTH_TOKEN` +
 * no `ANTHROPIC_API_KEY` → authenticated, exit 0. So channel 5 closes AND the
 * run bills the subscription; those were never in tension.
 *
 * The two credentials are mutually exclusive by vendor design — an
 * `ANTHROPIC_API_KEY` present in `-p` mode is "always used", overriding the
 * subscription — so exactly one is set here and the other is deleted from the
 * inherited environment. Deleting matters: the operator's own shell very often
 * exports `ANTHROPIC_API_KEY`, and inheriting it would silently bill the metered
 * path while this function believed it had chosen the subscription.
 *
 * **The deletion is from a COPY, never from `process.env`** (PR #3680 R1 asked).
 * `{ ...base }` is taken on the first line and every mutation below is against
 * that object, so nothing else in this process sees a changed environment — the
 * result is handed to `spawnSync` as the child's env and nowhere else. A test
 * asserts the caller's object is unmodified, since "it takes a copy" is the kind
 * of claim that stays true only until someone adds a line above it.
 */
export function buildSandboxEnv(
  base: NodeJS.ProcessEnv,
  paths: SandboxPaths,
  credential: HarnessCredential,
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

  if (credential.kind === "subscription") {
    env.CLAUDE_CODE_OAUTH_TOKEN = credential.value;
    delete env.ANTHROPIC_API_KEY;
  } else {
    env.ANTHROPIC_API_KEY = credential.value;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

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

async function probeDaemonUnauthenticated(): Promise<DaemonProbeResult> {
  try {
    const res = await fetch(DAEMON_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(5_000),
    });
    return { kind: "status", code: res.status };
  } catch (err) {
    // A refused connection means nothing is listening — a real, informative
    // negative. Everything else (timeout, abort, DNS) means the probe failed,
    // which is NOT the same thing and must not be reported as isolation.
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return /ECONNREFUSED|connection refused|Unable to connect/i.test(reason)
      ? { kind: "refused" }
      : { kind: "error", reason };
  }
}

function customizationEntriesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const present = new Set(readdirSync(dir));
  return CLAUDE_CUSTOMIZATION_ENTRIES.filter((e) => present.has(e));
}

/**
 * User-scope MCP server NAMES in a `.claude.json` — `Object.keys(mcpServers)`,
 * never the entries themselves, which can carry tokens (mt#5066).
 *
 * Failure direction, as with `parseMcpServerNames`: a file that exists but
 * cannot be read or parsed is reported as `UNPARSED:<basename>` rather than
 * `[]`, because `[]` would close the channel on exactly the evidence that
 * should open it. A file that does not exist is genuinely empty.
 */
export function userScopeMcpServerNamesIn(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return [`UNPARSED:${basename(file)}`];
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers === undefined || servers === null) return [];
    if (typeof servers !== "object") return [`UNPARSED:${basename(file)}`];
    return Object.keys(servers as Record<string, unknown>);
  } catch {
    return [`UNPARSED:${basename(file)}`];
  }
}

export interface ObserveOptions {
  env: NodeJS.ProcessEnv;
  claudeConfigDir: string;
  /** The `.claude.json` Claude Code reads under `env` — `resolveClaudeJsonPath(env)`. */
  claudeJsonPath: string;
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
    daemonProbe: await probeDaemonUnauthenticated(),
    claudeCustomizationEntries: customizationEntriesIn(opts.claudeConfigDir),
    userScopeMcpServerNames: userScopeMcpServerNamesIn(opts.claudeJsonPath),
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
 * a credential — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` — and the
 * record is written to disk, so it stores the NAMES set, never the values. A
 * record that dumped the environment would be a credential file. `credentialKind`
 * below names which of the two was used, which is a fact about billing rather
 * than a secret.
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
  /**
   * Which credential the run authenticated with — so a reader can tell a
   * subscription-billed run from a metered one without re-deriving it (SC4).
   * The KIND only; the value is a credential and never enters this record.
   * `null` when the run failed before resolving one.
   */
  credentialKind: HarnessCredentialKind | null;
  /**
   * The `origin` of the workspace the cold agent actually ran in (SC6).
   *
   * Recorded because a remote-dependent finding cannot be read without it. The
   * 2026-09-05 run reported sessions as unusable and ranked it the most severe
   * of six findings; the cause was that the harness's own local clone had left
   * `origin` pointing at a filesystem path, which `session start` refuses. That
   * was invisible until someone read the detection code two days later.
   */
  workspaceOrigin: string | null;
  /**
   * The scrubbed transcript, beside this record under `--out-dir` (mt#5066).
   *
   * A record whose `transcriptPath` points OUTSIDE its own directory — into
   * `/var/folders/…/T/mt5012-cold-<rand>/transcript.txt` — predates mt#5066, when the transcript
   * was written into the sandbox's temp root; macOS reclaims that on reboot, so
   * such a file may be gone. Read a missing one as expired evidence, not as a
   * harness defect. The two such records on the authoring machine were
   * backfilled by hand when this shipped.
   */
  transcriptPath: string | null;
  transcriptRedactions: number;
  /**
   * User-scope MCP server names the run ADDED to the operator's own
   * `.claude.json` — the write-side half of channel 5 (mt#5066). `[]` is the
   * pass; `null` means no agent ran (assertion-only mode), so nothing was
   * checked. Names only, by construction.
   */
  operatorClaudeJsonNewServerNames: string[] | null;
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

/**
 * Which credential the run is authenticating with — and therefore who pays.
 *
 * `subscription` bills the operator's Claude plan; `api-key` bills metered API
 * credits. The distinction is reported in the run record and on the console
 * (SC4), because a run that quietly picked the metered path is exactly what
 * mt#5019's retrospective was about.
 */
export type HarnessCredentialKind = "subscription" | "api-key";

export interface HarnessCredential {
  kind: HarnessCredentialKind;
  value: string;
}

/** Operator-facing phrase naming who pays for the run. */
export function describeCredentialBilling(kind: HarnessCredentialKind): string {
  return kind === "subscription"
    ? "your Claude subscription (no metered API spend)"
    : "metered Anthropic API credits — no subscription token configured";
}

/**
 * Pick the credential for the sandboxed `claude` run: **subscription first**.
 *
 * The original resolver read only `ai.providers.anthropic.apiKey` and justified
 * it with "the sandboxed config dir loses Claude Code's OAuth session, so an API
 * key is required." The first half is true and the second does not follow. What
 * a relocated `CLAUDE_CONFIG_DIR` loses is the OAuth *session*; a **long-lived
 * subscription token passed in the environment** is a different mechanism and is
 * unaffected.
 *
 * Verified live 2026-09-08 (mt#5018 SC2): with a freshly-created temp
 * `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY` unset, and `CLAUDE_CODE_OAUTH_TOKEN`
 * set from `ai.providers.anthropic.authToken`, `claude -p` authenticated and
 * answered — exit 0, no "Not logged in".
 *
 * Anthropic documents both halves. On the token
 * (`code.claude.com/docs/en/github-actions`): *"`CLAUDE_CODE_OAUTH_TOKEN`: an
 * OAuth token that authenticates with your Claude subscription, available on
 * Pro, Max, Team, and Enterprise plans. Generate one by running `claude
 * setup-token` locally."* And on the cost: *"If you authenticate with an OAuth
 * token, runs use your Claude subscription instead of API billing."*
 *
 * On why the API key cannot merely be left set as a fallback in the same env
 * (`code.claude.com/docs/en/env-vars`, on `ANTHROPIC_API_KEY`): *"When set, this
 * key is used instead of your Claude Pro, Max, Team, or Enterprise subscription
 * even if you are logged in. In non-interactive mode (`-p`), the key is always
 * used when present. … To use your subscription instead, run `unset
 * ANTHROPIC_API_KEY`."* So the two are mutually exclusive by vendor design, and
 * `buildSandboxEnv` deletes whichever one it is not using.
 */
export async function resolveHarnessCredential(): Promise<HarnessCredential> {
  const { initializeConfiguration, CustomConfigFactory, getConfiguration } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  const cfg = getConfiguration() as {
    ai?: { providers?: { anthropic?: { apiKey?: string; authToken?: string } } };
  };

  const token = cfg?.ai?.providers?.anthropic?.authToken;
  if (typeof token === "string" && token.length >= 20) {
    // WARN, never reject (PR #3680 R1 suggested stricter prefix validation).
    // mt#5023 is the reason this is not a hard check: the provider REJECTED the
    // exact token it exists for, because `sk-ant-` is the shared family prefix
    // rather than an API-key discriminator. A prefix test that refuses is one
    // upstream tag change away from repeating that. What a prefix CAN do
    // usefully is notice the likely paste error — an API key in the
    // subscription field, which would otherwise fail later as a confusing auth
    // error — and say so while still trying.
    if (token.startsWith("sk-ant-api")) {
      console.warn(
        "warning: ai.providers.anthropic.authToken looks like an API key " +
          "(sk-ant-api… prefix), not a subscription token (sk-ant-oat…). Proceeding with it as " +
          "the subscription credential; if auth fails, re-run `claude setup-token` and store " +
          "that value instead."
      );
    }
    return { kind: "subscription", value: token };
  }

  const key = cfg?.ai?.providers?.anthropic?.apiKey;
  if (typeof key === "string" && key.length >= 20) {
    return { kind: "api-key", value: key };
  }

  throw new Error(
    "No credential for the cold-agent run.\n" +
      "\n" +
      "Preferred (bills your Claude subscription, no metered spend):\n" +
      "  1. Run `claude setup-token` — it mints a long-lived subscription token.\n" +
      "  2. Store it: `minsky config credentials add claude-code-token`\n" +
      "     (writes `ai.providers.anthropic.authToken`).\n" +
      "\n" +
      "Fallback (bills metered API credits): set `ai.providers.anthropic.apiKey`."
  );
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

/**
 * The image handed to the cold agent (mt#5016). pgvector's build, NOT plain
 * `postgres:NN`: the 2026-09-05 run handed the agent a plain `postgres:16`, and
 * it could not migrate until it improvised
 * `apt-get install postgresql-16-pgvector` inside the container — the exact
 * improvisation this harness exists to DETECT, made necessary by the harness
 * itself.
 *
 * Must equal `PGVECTOR_DOCKER_IMAGE`
 * (`packages/domain/src/persistence/pgvector-preflight.ts`), which is what
 * `minsky setup db` prints. Kept as a literal rather than an import because this
 * harness deliberately depends on nothing but Node/Bun builtins — it stands in
 * for a machine that has no Minsky. **The equality is enforced by a test**
 * (`cold-agent-onboarding-run.test.ts`), which is free to import the domain;
 * that is what makes the duplication safe rather than merely commented
 * (PR #3678 R1).
 */
export const DISPOSABLE_POSTGRES_IMAGE = "pgvector/pgvector:pg17";

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
      DISPOSABLE_POSTGRES_IMAGE,
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

async function waitForPostgres(containerName: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const r = spawnSync("docker", ["exec", containerName, "pg_isready", "-U", "postgres"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (r.status === 0) return true;
    // An in-process delay, not `spawnSync("sleep", ["1"])`. A reviewer caught
    // `sleep` as an undeclared dependency — the THIRD tool this list has been
    // missing — and the lesson is not to lengthen the list: a shell-out that a
    // language primitive does just as well is a dependency bought for nothing.
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
/**
 * `origin` of a git working tree, or null if it has none / is not one.
 *
 * Returns the RAW url — `cloneTarget` needs it verbatim to hand to
 * `git remote set-url`. Every path that LOGS or PERSISTS the result masks it
 * first; see {@link maskGitRemote}.
 */
export function readGitOrigin(dir: string): string | null {
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

/**
 * A git remote safe to print or write to disk (PR #3680 R1).
 *
 * `https://user:token@github.com/o/r.git` is a perfectly ordinary remote for
 * anyone who cloned with a PAT in the URL, and this harness reports the
 * workspace origin on the console AND stores it in the run record. Masking the
 * userinfo keeps what the field is FOR — the host, so a reader can tell whether
 * a remote-dependent finding is real — while dropping the part that is a
 * credential. SSH remotes (`git@github.com:o/r.git`) carry no secret and no
 * `://`, so they pass through unchanged.
 */
export function maskGitRemote(remote: string | null): string | null {
  return remote === null ? null : maskConnectionString(remote);
}

/**
 * Clone the target into the sandbox, and give the clone the TARGET's own remote
 * rather than the path we cloned from (SC5). Returns the resulting `origin`.
 *
 * Cloning from a local path sets the clone's `origin` to that path — and
 * `session start` refuses any remote without `github.com` in it
 * (`packages/domain/src/session/repository-backend-detection.ts:151`). The
 * 2026-09-05 run therefore reported sessions as unusable and ranked it the most
 * severe of six findings: *"blocked the entire second half of the product."* It
 * blocked the second half of that RUN, for a reason the harness created. A real
 * user clones from GitHub and never reaches it.
 *
 * The local clone STAYS — AT4 depends on it, because cloning from the operator's
 * working tree is what keeps the operator's repo untouched. Only the remote is
 * corrected afterwards. When `source` is already a URL rather than a path,
 * `readGitOrigin` returns null for it and the clone's own origin is left alone,
 * which is already correct.
 *
 * **The general lesson, worth carrying past this script:** a harness that alters
 * the environment to protect the operator can alter the very property under
 * measurement. Every deviation the sandbox introduces is a candidate explanation
 * for any finding that follows.
 */
export function cloneTarget(source: string, destination: string): string | null {
  const r = spawnSync("git", ["clone", "--quiet", source, destination], {
    encoding: "utf8",
    timeout: 300_000,
  });
  // Every string below is masked before it escapes: `source` is operator-supplied
  // and may itself be a credential-bearing URL, and git's own stderr echoes the
  // remote it failed on.
  if (r.status !== 0) {
    throw new Error(
      `could not clone ${maskGitRemote(source)}: ${maskConnectionString((r.stderr ?? "").trim())}`
    );
  }

  const targetOwnOrigin = readGitOrigin(source);
  if (targetOwnOrigin) {
    const set = spawnSync(
      "git",
      ["-C", destination, "remote", "set-url", "origin", targetOwnOrigin],
      { encoding: "utf8", timeout: 30_000 }
    );
    if (set.status !== 0) {
      throw new Error(
        `cloned ${maskGitRemote(source)} but could not point the clone at the target's own ` +
          `origin (${maskGitRemote(targetOwnOrigin)}): ` +
          `${maskConnectionString((set.stderr ?? "").trim())}. Refusing to run — a workspace ` +
          "whose remote is the harness's clone path manufactures findings about remotes."
      );
    }
  }

  return maskGitRemote(readGitOrigin(destination));
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

/**
 * Where a run's transcript lives: beside its record, named by the same
 * timestamp (`run-<ms>.json` ↔ `transcript-run-<ms>.txt`), so the pair can be
 * matched by eye and neither expires without the other (mt#5066). This is the
 * name the 2026-09-10 transcript was hand-copied to before the harness did it.
 */
export function transcriptPathFor(outDir: string, nowMs: number): string {
  return join(outDir, `transcript-run-${nowMs}.txt`);
}

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
  let operatorClaudeJsonNewServerNames: string[] | null = null;
  let targetCarried: string[] = [];
  let credentialKind: HarnessCredentialKind | null = null;
  let workspaceOrigin: string | null = null;
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

    const credential = await resolveHarnessCredential();
    credentialKind = credential.kind;
    const operatorMinskyPath = resolveBinary(process.env, "minsky");

    // Carry the prerequisite across the strip. `bun` shares a directory with
    // `minsky` here, and PATH can only drop whole directories.
    const operatorBunPath = resolveBinary(process.env, "bun");
    if (operatorBunPath) symlinkSync(operatorBunPath, join(paths.binDir, "bun"));

    const env = buildSandboxEnv(process.env, paths, credential, operatorMinskyPath);

    // --- AT1: the sandbox closes every channel ---------------------------
    const sandboxedObs = await observe({
      env,
      claudeConfigDir: paths.claudeConfigDir,
      claudeJsonPath: resolveClaudeJsonPath(env),
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
        claudeJsonPath: resolveClaudeJsonPath(process.env),
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
        `\nAssertion mode only. Pass --execute --target <path> to run the agent, billed to ` +
          `${describeCredentialBilling(credential.kind)}.`
      );
    } else {
      // SC4: say who pays, every run, before any of it is spent — not in a flag
      // the operator has to think to pass.
      console.log(`\nAgent run will be billed to ${describeCredentialBilling(credential.kind)}.`);
      if (!opts.target) throw new Error("--execute requires --target <path or url of a cold repo>");

      const workspace = join(paths.root, "workspace");
      workspaceOrigin = cloneTarget(opts.target, workspace);
      targetCarried = targetColdness(workspace);
      console.log(
        `\nTarget ${maskGitRemote(opts.target)} carries ${
          targetCarried.length
        } tracked onboarding file(s)${
          targetCarried.length > 0 ? `: ${targetCarried.join(", ")} — NOT a cold repo` : " — cold"
        }`
      );
      // SC6: state the remote the agent will actually see. A remote-dependent
      // finding is unreadable without it.
      console.log(`Workspace origin: ${workspaceOrigin ?? "(none)"}`);

      const pg = startDisposablePostgres(findFreePort(portIsBusy));
      pgContainer = pg.containerName;
      if (!(await waitForPostgres(pg.containerName))) {
        throw new Error(`disposable Postgres never became ready (${pg.containerName})`);
      }
      console.log(`Disposable empty Postgres ready in container ${pg.containerName}`);

      // mt#5066: the write-side falsifier for channel 5. The probe above reads
      // the SANDBOX's `.claude.json`; this snapshot is the OPERATOR's real one,
      // resolved from the harness's own environment, so a run that writes a
      // user-scope registration into it is caught by name after dispatch.
      // Names only — the entries can carry tokens.
      const operatorClaudeJson = resolveClaudeJsonPath(process.env);
      const operatorServersBefore = new Set(userScopeMcpServerNamesIn(operatorClaudeJson));

      const started = new Date(opts.nowMs).toISOString();
      const claudeArgs = [
        "-p",
        buildColdAgentPrompt(pg.url),
        "--strict-mcp-config",
        "--model",
        "fable",
        "--permission-mode",
        "bypassPermissions",
        // The tool-by-tool trace, not just the last message. `-p`'s default
        // output format returns ONLY the final turn, which makes every friction
        // point a matter of the agent's own account of what it did —
        // `strong-evidence` about its own behaviour rather than a record of it.
        // The 2026-09-05 run was captured that way and its classification
        // carries that bound; this is what removes it for the next one.
        "--output-format",
        "stream-json",
        "--verbose",
      ];

      // The vetted scrubber, loaded before dispatch because BOTH the argv and
      // the transcript go through it. A hand-rolled pattern would be a
      // hypothesis about the text, and one that matches nothing emits its input
      // unchanged — indistinguishable from a redaction that fired (mem#808).
      const { scrubText } = await import("@minsky/domain/transcripts/credential-scrubber");

      // SC2 asks for the EXACT argv. It is recorded in full and scrubbed, not
      // replaced with a `<prompt>` placeholder: the placeholder satisfied the
      // secret constraint by discarding the thing the criterion asks for, which
      // is a worse answer than scrubbing. What survives is every flag plus the
      // prompt with any credential shape redacted.
      dispatchArgv = ["claude", ...claudeArgs].map((arg) => scrubText(arg).text);

      const r = spawnSync("claude", claudeArgs, {
        cwd: workspace,
        env,
        encoding: "utf8",
        timeout: 1_800_000,
      });
      const raw = (r.stdout ?? "") + (r.stderr ?? "");

      const scrubbed = scrubText(raw);
      transcriptRedactions = scrubbed.redactions.length;

      // mt#5066: the transcript lands BESIDE its run record, under `--out-dir`,
      // not in the mkdtemp root — macOS reclaims `/var/folders/…/T/` on reboot
      // and periodically, and the transcript is the evidence the record exists
      // to point at (mt#5012: "treat its transcript as the gap list"). The scrub
      // above stays ahead of this write; only the destination moved.
      mkdirSync(opts.outDir, { recursive: true });
      const durableTranscriptPath = transcriptPathFor(opts.outDir, opts.nowMs);
      writeFileSync(durableTranscriptPath, scrubbed.text);
      transcriptPath = durableTranscriptPath;
      console.log(
        `\nRun started ${started}; transcript at ${durableTranscriptPath}` +
          ` (${transcriptRedactions} redaction(s))`
      );

      // mt#5066: did the run write a user-scope registration into the operator's
      // real file? Compare NAMES before and after; a new key is a sandbox escape.
      const operatorServersAfter = userScopeMcpServerNamesIn(operatorClaudeJson);
      operatorClaudeJsonNewServerNames = operatorServersAfter.filter(
        (name) => !operatorServersBefore.has(name)
      );
      if (operatorClaudeJsonNewServerNames.length > 0) {
        failures.push(
          `channel 5 (write side): the run added user-scope MCP server(s) to the operator's ` +
            `${operatorClaudeJson}: ${operatorClaudeJsonNewServerNames.join(", ")}`
        );
      }
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
      // Masked for the same reason `workspaceOrigin` is: `--target` accepts a
      // URL, and a URL can carry userinfo (PR #3680 R1).
      target: maskGitRemote(opts.target),
      targetCarriedFiles: targetCarried,
      argv: dispatchArgv,
      sandboxEnvVarNames: envVarNames,
      channels: sandboxed,
      negativeControl: unsandboxed,
      preconditionFailures: preconditions,
      credentialKind,
      workspaceOrigin,
      transcriptPath,
      transcriptRedactions,
      operatorClaudeJsonNewServerNames,
    };
    mkdirSync(opts.outDir, { recursive: true });
    const recordPath = join(opts.outDir, `run-${opts.nowMs}.json`);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\nRun record: ${recordPath}`);

    // The sandbox root survives an --execute run on purpose — it holds the
    // cloned workspace the agent worked in, which a post-run audit reads (the
    // mt#5065 compile-overwrite finding came from one). The transcript no
    // longer lives there (mt#5066), so nothing the RECORD points at depends on
    // this root surviving.
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
