/**
 * `minsky setup local-http` effect layer (mt#3816).
 *
 * The decisions live in `local-http-config.ts`; this module is what actually
 * touches the operator's config and the daemon process. Two disciplines hold
 * throughout:
 *
 *  - **Backup before the first mutating byte.** A backup is a byte-for-byte
 *    copy of the original, taken before any rewrite, so `--revert` restores
 *    the exact file rather than a re-serialization of it.
 *  - **Never write a guess.** A config that cannot be parsed aborts the run
 *    naming the file, instead of being replaced by something we invented.
 */

import { spawn } from "child_process";
import path from "path";
import {
  applyRewritesToDocument,
  backupPathFor,
  backupTimestamp,
  claudeJsonPath,
  findLatestBackup,
  makeProductionConfigFsDeps,
  projectConfigPath,
  writeAtomically,
  type ConfigFsDeps,
  type MigrationPlan,
  type PlannedRewrite,
} from "./local-http-config";
import {
  DEFAULT_LOCAL_DAEMON_HOST,
  DEFAULT_LOCAL_DAEMON_PORT,
  probeHealthIdentity,
  readDiscoveryRecord,
  type HealthProbeOutcome,
} from "../daemon/local-daemon";
import {
  assertServiceIdentity,
  SERVICE_IDENTITIES,
  describeHealthIdentityResult,
} from "@minsky/domain/deployment/health-identity";
import { killIfIdentityMatches } from "../../cockpit/process-identity";

/** Raised when a config file cannot be read or parsed during an apply. */
export class ConfigWriteError extends Error {}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface AppliedFile {
  file: string;
  backup: string;
}

export interface ApplyResult {
  backups: AppliedFile[];
  entriesRewritten: number;
}

function rewritesFor(plan: MigrationPlan, file: string): PlannedRewrite[] {
  return plan.rewrites.filter((r) => r.entry.file === file);
}

/**
 * Write the plan to disk: back up every touched file, then rewrite it.
 *
 * All backups share ONE timestamp so a later revert restores a coherent set —
 * files restored from two different instants would be a configuration that
 * never actually ran.
 */
export function applyPlan(
  plan: MigrationPlan,
  options: { deps?: ConfigFsDeps; now?: Date } = {}
): ApplyResult {
  const deps = options.deps ?? makeProductionConfigFsDeps();
  const stamp = backupTimestamp(options.now ?? new Date());
  const backups: AppliedFile[] = [];

  for (const file of plan.filesTouched) {
    let raw: string;
    try {
      raw = deps.readFileSync(file);
    } catch (error) {
      throw new ConfigWriteError(
        `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const next = applyRewritesToDocument(raw, rewritesFor(plan, file));
    if (next === null) {
      throw new ConfigWriteError(
        `Refusing to write ${file}: its current contents are not valid JSON. ` +
          `Fix or restore the file, then re-run.`
      );
    }

    // Backup FIRST, and byte-for-byte — a backup written after the rewrite,
    // or produced by re-serializing, is not a restore point.
    const backup = backupPathFor(file, stamp);
    deps.writeFileSync(backup, raw);
    writeAtomically(file, next, deps);
    backups.push({ file, backup });
  }

  return { backups, entriesRewritten: plan.rewrites.length };
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

export interface RevertedFile {
  file: string;
  restoredFrom: string;
}

/** The config files this command is capable of having written. */
export function revertCandidates(projectRoot: string, home: string): string[] {
  return [projectConfigPath(projectRoot), claudeJsonPath(home)];
}

/**
 * Restore each candidate config from its most recent backup.
 *
 * Restores the backup's BYTES, so the result is the pre-migration file rather
 * than an equivalent-looking re-serialization. A candidate with no backup is
 * skipped silently: it means this command never wrote it.
 */
export function revertFromBackups(
  candidates: string[],
  options: { deps?: ConfigFsDeps } = {}
): RevertedFile[] {
  const deps = options.deps ?? makeProductionConfigFsDeps();
  const restored: RevertedFile[] = [];

  for (const file of candidates) {
    const backup = findLatestBackup(file, deps);
    if (backup === null) continue;
    const raw = deps.readFileSync(backup);
    writeAtomically(file, raw, deps);
    restored.push({ file, restoredFrom: backup });
  }

  return restored;
}

// ---------------------------------------------------------------------------
// Daemon liveness
// ---------------------------------------------------------------------------

/**
 * What is (or is not) answering the daemon port.
 *
 * `foreign` is deliberately distinct from `absent`: something already holds
 * the port and it is not a Minsky MCP daemon, so spawning ours would lose the
 * bind race and leave the operator with a rewritten config pointing at another
 * application. mt#3142 is why identity is asserted rather than a 200 accepted
 * — every Minsky service answers `/health` the same way.
 */
export type DaemonState = "running" | "absent" | "foreign" | "not-ready";

export interface DaemonStatus {
  state: DaemonState;
  detail: string;
}

/**
 * Is an identity-matching daemon actually able to serve DB-backed work?
 *
 * mt#4297: reads `ready` when present, and falls back to `persistence.mode` for
 * a daemon predating that field. The fallback is what makes this safe to ship —
 * keying on `ready` alone would classify EVERY daemon built before this change
 * as not-ready, including during the rollout window, which turns a safety check
 * into an outage. `persistence.mode` has been in the payload all along.
 *
 * Returns `undefined` when neither signal is present, which the caller treats as
 * "cannot tell" rather than "not ready" — refusing on a payload we cannot parse
 * would be the same over-reach in a different disguise.
 */
function readDaemonReadiness(body: unknown): boolean | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;

  if (typeof record.ready === "boolean") return record.ready;

  const persistence = record.persistence;
  if (typeof persistence === "object" && persistence !== null) {
    const mode = (persistence as Record<string, unknown>).mode;
    if (typeof mode === "string") return mode === "connected";
  }
  return undefined;
}

export function classifyDaemonProbe(probe: HealthProbeOutcome): DaemonStatus {
  if (probe.kind === "unreachable") {
    return { state: "absent", detail: `nothing answered /health (${probe.detail})` };
  }
  if (probe.kind === "http-error") {
    return { state: "foreign", detail: `/health answered HTTP ${probe.status}` };
  }
  const result = assertServiceIdentity(probe.body, SERVICE_IDENTITIES.mcp);
  if (result.ok) {
    // mt#4297: identity is necessary and NOT sufficient. A Minsky MCP daemon
    // with no persistence provider answers /health 200 with the right identity
    // and cannot serve a single DB-backed tool call — the state this check
    // exists to refuse, observed live for 31h before anything noticed. Adopting
    // it would point every conversation at a Minsky whose tools fail.
    if (readDaemonReadiness(probe.body) === false) {
      return {
        state: "not-ready",
        detail:
          `a ${result.service} daemon is serving the port but reports it cannot reach the ` +
          `database — adopting it would migrate every conversation onto a daemon whose ` +
          `DB-backed tools fail at call time`,
      };
    }
    return { state: "running", detail: `a ${result.service} daemon is already serving the port` };
  }
  return { state: "foreign", detail: describeHealthIdentityResult(result) };
}

export function localDaemonHealthUrl(
  host: string = DEFAULT_LOCAL_DAEMON_HOST,
  port: number = DEFAULT_LOCAL_DAEMON_PORT
): string {
  return `http://${host}:${port}/health`;
}

export function localDaemonMcpUrl(
  host: string = DEFAULT_LOCAL_DAEMON_HOST,
  port: number = DEFAULT_LOCAL_DAEMON_PORT
): string {
  return `http://${host}:${port}/mcp`;
}

/**
 * The exact command line the ensure-running step would run.
 *
 * Exposed (and printed in the plan) rather than kept internal because the
 * `--repo` it carries is a real choice: a machine-wide daemon has no single
 * correct repo, so the operator should see which one this run picked. The
 * general multi-repo binding question belongs to mt#3814 / mt#2430.
 */
export function daemonSpawnCommand(
  invocation: string[],
  projectRoot: string,
  endpoint?: DaemonEndpoint
): string[] {
  const base = [...invocation, "mcp", "start", "--http", "--local-daemon", "--repo", projectRoot];
  // `--local-daemon` is a MODE that supplies ADR-038's host/port contract for
  // any value the caller did not pass explicitly, and `mcp start` honors an
  // explicit `--port`/`--host` over that default (see start-command.ts's
  // `getOptionValueSource` branch). So the override is appended ONLY when the
  // requested endpoint differs from the contract: at the default we let the
  // mode speak, and a printed spawn line carrying redundant flags would imply
  // a choice was made where none was.
  if (endpoint === undefined || isDefaultDaemonEndpoint(endpoint)) return base;
  return [...base, "--host", endpoint.host, "--port", String(endpoint.port)];
}

export interface DaemonEndpoint {
  host: string;
  port: number;
}

export function isDefaultDaemonEndpoint(endpoint: DaemonEndpoint): boolean {
  return endpoint.host === DEFAULT_LOCAL_DAEMON_HOST && endpoint.port === DEFAULT_LOCAL_DAEMON_PORT;
}

/**
 * The host/port a given MCP URL points at.
 *
 * `--url` decides where the rewritten config sends the shim, so it must also
 * decide where this command probes for a daemon and what endpoint it spawns
 * one on. Deriving all three from one string is what keeps them from drifting:
 * before this, `--url http://127.0.0.1:9999/mcp` wrote a config aimed at 9999
 * while the ensure-running step probed and spawned 48765, leaving the operator
 * with a config pointing at nothing.
 *
 * Returns null for a URL that is not parseable or carries no usable port; the
 * caller turns that into an operator-facing error rather than silently falling
 * back to the default, which would reintroduce exactly that drift.
 */
export function parseDaemonEndpoint(mcpUrl: string): DaemonEndpoint | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    return null;
  }
  if (parsed.hostname === "") return null;
  const port =
    parsed.port === ""
      ? parsed.protocol === "https:"
        ? 443
        : 80
      : Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { host: parsed.hostname, port };
}

/** The `/health` URL for the same daemon a given MCP URL addresses. */
export function healthUrlForMcpUrl(mcpUrl: string): string | null {
  const endpoint = parseDaemonEndpoint(mcpUrl);
  return endpoint === null ? null : localDaemonHealthUrl(endpoint.host, endpoint.port);
}

/**
 * How to re-invoke this same Minsky, as an argv prefix.
 *
 * A compiled binary is one token; the from-source form is `bun <cli.ts>` and
 * needs both, or the spawned daemon would be a `bun` with no script. Reading
 * it off the live argv rather than hardcoding `minsky` also means a developer
 * running from source gets a daemon built from the SAME source they are
 * testing.
 *
 * `process.execPath` is not on this project's narrowed ambient `process`
 * type; `argv[0]` carries the same value.
 */
export function resolveSelfInvocation(argv: string[] = process.argv): string[] {
  const [interpreter, script] = argv;
  if (interpreter === undefined) return ["minsky"];
  if (script !== undefined && (script.endsWith(".ts") || script.endsWith(".js"))) {
    return [interpreter, script];
  }
  // `bunx minsky ...` / `npx minsky ...`: argv[1] is the package bin name, not
  // a script path, so the extension test above misses it and the prefix would
  // collapse to a bare `bunx` — spawning `bunx mcp start ...`, which names no
  // package and cannot run. The runner needs its package argument kept.
  const runner = path.basename(interpreter);
  if ((runner === "bunx" || runner === "npx") && script !== undefined) {
    return [interpreter, script];
  }
  return [interpreter];
}

/**
 * The argv marker that identifies a local MCP daemon in `ps` output.
 *
 * The discovery record's pid can outlive the process it names — a crashed
 * daemon leaves the record behind, and the OS is free to reuse the number.
 * Killing on the record alone would then terminate an unrelated process, which
 * is the hazard `killIfIdentityMatches` exists for (mt#3038).
 */
export const LOCAL_DAEMON_CMD_MARKER = "--local-daemon";

export interface DaemonProcessDeps {
  probe?: (url: string) => Promise<HealthProbeOutcome>;
  spawnDetached?: (argv: string[]) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Resolves false when the pid's live command line is not a local daemon. */
  killIfOurs?: (pid: number, signal: NodeJS.Signals) => Promise<boolean>;
  readRecord?: typeof readDiscoveryRecord;
}

function defaultSpawnDetached(argv: string[]): void {
  const [command, ...args] = argv;
  if (command === undefined) throw new ConfigWriteError("empty daemon spawn command");
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface EnsureDaemonResult {
  /** True when this call spawned the daemon; false when one was already up. */
  spawned: boolean;
  status: DaemonStatus;
}

/**
 * Make sure a Minsky MCP daemon is answering before the run reports success.
 *
 * Refuses to spawn over a `foreign` holder rather than start a second process
 * that loses the bind race, which would leave the caller about to point its
 * config at someone else's server.
 *
 * CALLER INVARIANT (mt#4337): every throw below tells the operator "Nothing
 * has been written." That is true only because `runSetupLocalHttp` calls this
 * BEFORE `applyPlan`. A caller that writes config first turns all three
 * refusals into false statements — which is the defect mt#4337 fixed, where
 * the not-ready refusal fired after the entry had been rewritten and a backup
 * left on disk. Call this before mutating anything, or change the messages.
 */
export async function ensureDaemonRunning(
  spawnArgv: string[],
  options: {
    healthUrl?: string;
    attempts?: number;
    intervalMs?: number;
    deps?: DaemonProcessDeps;
  } = {}
): Promise<EnsureDaemonResult> {
  const deps = options.deps ?? {};
  const probe = deps.probe ?? ((url: string) => probeHealthIdentity(url));
  const spawnDetached = deps.spawnDetached ?? defaultSpawnDetached;
  const sleep = deps.sleep ?? defaultSleep;
  const healthUrl = options.healthUrl ?? localDaemonHealthUrl();
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 250;

  const initial = classifyDaemonProbe(await probe(healthUrl));
  if (initial.state === "running") return { spawned: false, status: initial };
  if (initial.state === "foreign") {
    throw new ConfigWriteError(
      `Refusing to start the local MCP daemon: ${healthUrl} is already answered by something ` +
        `else — ${initial.detail}. Stop it first, then re-run. Nothing has been written.`
    );
  }
  // mt#4297: must be refused BEFORE the spawn below, and separately from
  // `foreign`. Falling through would spawn a second daemon against a port the
  // incumbent still holds — it loses the bind race, adopts the incumbent and
  // exits (ADR-014, one owner per port), and the migration proceeds onto the
  // very daemon this check identified as unable to serve.
  if (initial.state === "not-ready") {
    throw new ConfigWriteError(
      `Refusing to migrate onto the local MCP daemon at ${healthUrl}: ${initial.detail}. ` +
        `Restart the daemon (the tray supervises it) and re-run once /health reports ` +
        `"ready": true. Nothing has been written.`
    );
  }

  spawnDetached(spawnArgv);

  let last: DaemonStatus = initial;
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    last = classifyDaemonProbe(await probe(healthUrl));
    if (last.state === "running") {
      // `classifyDaemonProbe`'s "already serving" wording is written for the
      // PRE-spawn probe above, where adopting someone else's daemon is the
      // news. Reused verbatim here it describes the daemon we just started as
      // one that was already up — the caller renders "Started the local MCP
      // daemon (a minsky-mcp daemon is already serving the port)", which
      // states both outcomes at once and tells the operator neither.
      return { spawned: true, status: { ...last, detail: "it is answering /health" } };
    }
    if (last.state === "foreign") break;
    // mt#4297: the daemon WE just started came up without a database. Retrying
    // cannot fix it — persistence is resolved once at boot — so stop here and
    // let the error below report `last.detail` rather than burning the full
    // attempt budget and then blaming the timeout.
    if (last.state === "not-ready") break;
  }

  throw new ConfigWriteError(
    `Started the local MCP daemon but it never became healthy at ${healthUrl} — ${last.detail}. ` +
      `Nothing has been written.`
  );
}

export interface StopDaemonResult {
  stopped: boolean;
  detail: string;
}

/**
 * Stop the daemon this machine's discovery record names.
 *
 * Keyed on the discovery record rather than on whatever holds the port: a
 * revert should stop the daemon Minsky started, never an unrelated process
 * that happens to be listening.
 */
export async function stopLocalDaemon(
  options: {
    healthUrl?: string;
    attempts?: number;
    intervalMs?: number;
    env?: NodeJS.ProcessEnv;
    deps?: DaemonProcessDeps;
  } = {}
): Promise<StopDaemonResult> {
  const deps = options.deps ?? {};
  const probe = deps.probe ?? ((url: string) => probeHealthIdentity(url));
  const sleep = deps.sleep ?? defaultSleep;
  const killImpl =
    deps.killIfOurs ??
    ((pid: number, signal: NodeJS.Signals) =>
      killIfIdentityMatches(pid, LOCAL_DAEMON_CMD_MARKER, signal));
  const readRecord = deps.readRecord ?? readDiscoveryRecord;
  const healthUrl = options.healthUrl ?? localDaemonHealthUrl();
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 250;

  const record = readRecord(options.env === undefined ? {} : { env: options.env });
  if (record === null) {
    return { stopped: false, detail: "no local daemon discovery record — nothing to stop" };
  }

  const signalled = await killImpl(record.pid, "SIGTERM");
  if (!signalled) {
    return {
      stopped: false,
      detail:
        `pid ${record.pid} was not signalled — its live command line is not a local MCP daemon. ` +
        `The discovery record is stale (the daemon already exited, or the pid has been reused).`,
    };
  }

  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    const status = classifyDaemonProbe(await probe(healthUrl));
    // mt#4297: enumerate the states that mean "our daemon is gone" rather than
    // testing `!== "running"`. `not-ready` is a daemon that is STILL SERVING the
    // port, so the negated form would have reported `stopped: true` for a
    // process that is very much alive — a false success introduced by adding a
    // member to the union, and invisible at this call site.
    if (status.state === "absent" || status.state === "foreign") {
      return { stopped: true, detail: `pid ${record.pid} stopped; ${status.detail}` };
    }
  }

  return {
    stopped: false,
    detail: `pid ${record.pid} was signalled but is still answering ${healthUrl}`,
  };
}
