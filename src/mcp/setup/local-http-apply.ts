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
export type DaemonState = "running" | "absent" | "foreign";

export interface DaemonStatus {
  state: DaemonState;
  detail: string;
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
export function daemonSpawnCommand(invocation: string[], projectRoot: string): string[] {
  return [...invocation, "mcp", "start", "--http", "--local-daemon", "--repo", projectRoot];
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
 * Refuses to spawn over a `foreign` holder: the config now points at this
 * port, and starting a second process that loses the bind race would leave
 * the operator worse off than before the migration, with a config pointing at
 * someone else's server.
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
        `else — ${initial.detail}. Stop it first, then re-run.`
    );
  }

  spawnDetached(spawnArgv);

  let last: DaemonStatus = initial;
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    last = classifyDaemonProbe(await probe(healthUrl));
    if (last.state === "running") return { spawned: true, status: last };
    if (last.state === "foreign") break;
  }

  throw new ConfigWriteError(
    `Started the local MCP daemon but it never became healthy at ${healthUrl} — ${last.detail}. ` +
      `The config has been migrated; run \`minsky setup local-http --revert\` to undo it.`
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
    if (status.state !== "running") {
      return { stopped: true, detail: `pid ${record.pid} stopped; ${status.detail}` };
    }
  }

  return {
    stopped: false,
    detail: `pid ${record.pid} was signalled but is still answering ${healthUrl}`,
  };
}
