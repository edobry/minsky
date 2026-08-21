/**
 * Local shared MCP daemon lifecycle (mt#3814, ADR-038 §§Question 4–5).
 *
 * The daemon is `minsky mcp start --http --local-daemon`. This module owns the
 * four things that make it addressable and safe to run unattended:
 *
 *  - the fixed port contract (`48765`) the static Claude Code config targets,
 *  - identity-asserting adopt-or-fail conflict detection on bind failure,
 *  - a discovery file for the supervisor and CLI (never for the MCP client),
 *  - the `0600` bearer token the daemon and the shim both hold.
 *
 * ## Why a separate file from `daemon-state.json`
 *
 * `src/mcp/daemon-state.ts` already writes pid + start-time under the same
 * state dir, so a reader could reasonably ask why the discovery record is not
 * simply a field there. It cannot be: that file is written by EVERY
 * `mcp start` on every transport and is last-writer-wins, so a stdio server
 * starting a minute later would overwrite the record describing the live
 * shared daemon — exactly the reader this file exists to serve. ADR-038
 * §Question 4 names `local-mcp.json` for this reason. What IS shared is the
 * state-dir convention (`MINSKY_STATE_DIR`, else `~/.local/state/minsky`),
 * inherited here rather than re-invented.
 *
 * ## Why the IO is injected
 *
 * Every function that touches the filesystem, the network, or a subprocess
 * takes its dependency as a parameter with a production default. That keeps
 * the decision logic — which conflict outcomes adopt and which fail, what a
 * failure message says — unit-testable without a real filesystem, per this
 * repo's `custom/no-real-fs-in-tests` convention.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { execSync } from "child_process";
import {
  assertServiceIdentity,
  SERVICE_IDENTITIES,
  describeHealthIdentityResult,
  type HealthIdentityResult,
} from "@minsky/domain/deployment/health-identity";
import { DEFAULT_TOKEN_PATH } from "../shim/token";

/**
 * The port contract (ADR-038 §Question 4). The Claude Code config is static
 * and its reconnect logic targets the configured URL, so this cannot be
 * chosen dynamically — a daemon that "helpfully" moves to a free port is a
 * daemon nobody talks to. `src/mcp/shim/main.ts` hardcodes the matching
 * `DEFAULT_DAEMON_URL`; the two must agree.
 */
export const DEFAULT_LOCAL_DAEMON_PORT = 48765;

/** Loopback only. The daemon holds a static bearer token, not a network ACL. */
export const DEFAULT_LOCAL_DAEMON_HOST = "127.0.0.1";

/** File mode for the token. Anything wider defeats the point of a file token. */
export const TOKEN_FILE_MODE = 0o600;

const DISCOVERY_FILENAME = "local-mcp.json";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * State dir, shared with `daemon-state.ts` and `disconnect-tracker.ts`.
 * `MINSKY_STATE_DIR` is the existing override those two already honor.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = env["MINSKY_STATE_DIR"];
  if (envDir) return envDir;
  return path.join(os.homedir(), ".local", "state", "minsky");
}

/** `~/.local/state/minsky/local-mcp.json` (ADR-038 §Question 4). */
export function localDaemonDiscoveryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), DISCOVERY_FILENAME);
}

/**
 * `~/.config/minsky/local-mcp-token`, re-exported from the shim's module so
 * the writer and the reader cannot drift apart. The shim owns the constant
 * because it must stay dependency-free; the import direction is
 * daemon → shim, never the reverse.
 */
export function localDaemonTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return env["MINSKY_LOCAL_MCP_TOKEN_PATH"] ?? DEFAULT_TOKEN_PATH;
}

// ---------------------------------------------------------------------------
// Mode defaults
// ---------------------------------------------------------------------------

/**
 * Local idle-session timeout (ADR-038 §Question 6: minutes, not the hosted 2h).
 *
 * Safe to keep short for two measured reasons: the shim's exit is a reliable
 * local disconnect signal, and a session reaped in error costs almost nothing —
 * mt#3811 measured 6/6 clients re-initializing transparently in 8–14ms.
 */
export const LOCAL_DAEMON_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface LocalDaemonDefaults {
  port: string;
  host: string;
  sessionIdleTimeoutMs: string;
}

/**
 * The values `--local-daemon` supplies for anything the caller did not set.
 *
 * Extracted from the command action (PR #2871 R1 NON-BLOCKING) so the
 * precedence rules are testable without booting a CLI. The rule in every case
 * is the same: an explicit choice wins, and the mode fills in the rest.
 *
 * `portFromCli` / `hostFromCli` come from commander's `getOptionValueSource`,
 * which is what distinguishes "the user typed `--port 3000`" from "commander
 * supplied its own default" — without that distinction an explicit port would
 * be silently overridden.
 */
export function resolveLocalDaemonDefaults(input: {
  portFromCli: boolean;
  hostFromCli: boolean;
  currentPort: string;
  currentHost: string;
  currentIdleTimeoutMs: string | undefined;
}): LocalDaemonDefaults {
  return {
    port: input.portFromCli ? input.currentPort : String(DEFAULT_LOCAL_DAEMON_PORT),
    host: input.hostFromCli ? input.currentHost : DEFAULT_LOCAL_DAEMON_HOST,
    sessionIdleTimeoutMs: input.currentIdleTimeoutMs ?? String(LOCAL_DAEMON_IDLE_TIMEOUT_MS),
  };
}

// ---------------------------------------------------------------------------
// Injected IO
// ---------------------------------------------------------------------------

export interface LocalDaemonFsDeps {
  existsSync(p: string): boolean;
  readFileSync(p: string): string;
  writeFileSync(p: string, data: string, mode?: number): void;
  renameSync(from: string, to: string): void;
  mkdirSync(p: string): void;
  chmodSync(p: string, mode: number): void;
  statMode(p: string): number;
  unlinkSync(p: string): void;
}

export function makeProductionFsDeps(): LocalDaemonFsDeps {
  return {
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p) => fs.readFileSync(p, "utf8") as string,
    writeFileSync: (p, data, mode) =>
      fs.writeFileSync(p, data, mode === undefined ? "utf8" : { encoding: "utf8", mode }),
    renameSync: (from, to) => fs.renameSync(from, to),
    mkdirSync: (p) => {
      fs.mkdirSync(p, { recursive: true });
    },
    chmodSync: (p, mode) => fs.chmodSync(p, mode),
    // Masked to the permission bits so callers compare against 0o600 rather
    // than against a mode that also encodes the file type.
    statMode: (p) => fs.statSync(p).mode & 0o777,
    unlinkSync: (p) => fs.unlinkSync(p),
  };
}

// ---------------------------------------------------------------------------
// Discovery file
// ---------------------------------------------------------------------------

/**
 * What a supervisor or CLI needs to find a daemon it did not spawn.
 *
 * Explicitly NOT a client mechanism: the MCP client reads a static config and
 * cannot consult a file. A HOOK subprocess, however, is not an MCP client —
 * it is an ordinary local process running as the same user and CAN read this,
 * which is the seam mt#2430's DB gateway will use. Keep the shape readable by
 * a non-MCP consumer.
 */
export interface LocalDaemonDiscoveryRecord {
  port: number;
  host: string;
  pid: number;
  startedAt: string;
}

export function writeDiscoveryRecord(
  record: LocalDaemonDiscoveryRecord,
  options: { env?: NodeJS.ProcessEnv; deps?: LocalDaemonFsDeps } = {}
): string {
  const env = options.env ?? process.env;
  const deps = options.deps ?? makeProductionFsDeps();
  const target = localDaemonDiscoveryPath(env);
  deps.mkdirSync(path.dirname(target));
  // tmp + rename so a reader never observes a half-written record.
  const tmp = `${target}.tmp.${record.pid}`;
  deps.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  deps.renameSync(tmp, target);
  return target;
}

/**
 * Read the discovery record, or null when absent or malformed.
 *
 * Returns null rather than throwing because every caller's correct response to
 * a bad record is the same as to a missing one: assume no daemon is
 * discoverable and proceed. A null NEVER means "no daemon is running" — only
 * "no record was readable"; a daemon started without `--local-daemon` writes
 * nothing here.
 *
 * **And the converse, which is the one that bites (mt#4369): a non-null record
 * NEVER means a daemon IS running.** Removal only happens on a shutdown path
 * that a `SIGKILL`, an OOM-kill, or a cleanup killed mid-drain never reaches,
 * so a record routinely outlives its daemon — naming a dead pid, on a port with
 * nothing listening, and parsing exactly like a healthy one. Observed
 * 2026-08-20 against pid 27569.
 *
 * This function is deliberately NOT the place that fixes it: it stays a pure,
 * synchronous, dependency-free read, and its contract is unchanged. Callers
 * that need to know whether a daemon is SERVING use `readDiscoveryLiveness`
 * (`./discovery-liveness`), which probes the pid and the port and returns a
 * tri-state answer that fails closed.
 */
export function readDiscoveryRecord(
  options: { env?: NodeJS.ProcessEnv; deps?: LocalDaemonFsDeps } = {}
): LocalDaemonDiscoveryRecord | null {
  const env = options.env ?? process.env;
  const deps = options.deps ?? makeProductionFsDeps();
  const target = localDaemonDiscoveryPath(env);
  if (!deps.existsSync(target)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(deps.readFileSync(target));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj["port"] !== "number" ||
    typeof obj["host"] !== "string" ||
    typeof obj["pid"] !== "number" ||
    typeof obj["startedAt"] !== "string"
  ) {
    return null;
  }
  return {
    port: obj["port"],
    host: obj["host"],
    pid: obj["pid"],
    startedAt: obj["startedAt"],
  };
}

/**
 * Remove the discovery record on shutdown.
 *
 * Only removes a record this process owns: a daemon that adopted an incumbent,
 * or that lost a bind race, must not delete the winner's record on its way
 * out. Returns whether a removal happened.
 */
export function removeDiscoveryRecord(
  ownerPid: number,
  options: { env?: NodeJS.ProcessEnv; deps?: LocalDaemonFsDeps } = {}
): boolean {
  const env = options.env ?? process.env;
  const deps = options.deps ?? makeProductionFsDeps();
  const existing = readDiscoveryRecord({ env, deps });
  if (!existing || existing.pid !== ownerPid) return false;
  try {
    deps.unlinkSync(localDaemonDiscoveryPath(env));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export interface EnsureTokenResult {
  token: string;
  path: string;
  /** True when this call minted the token; false when it read an existing one. */
  created: boolean;
}

/**
 * Return the local daemon's bearer token, generating it if absent.
 *
 * Idempotent by design — `minsky setup local-http` (mt#3816), the tray
 * supervisor (mt#3815) and the daemon itself all call this, and only the first
 * one to run should mint. An existing file is never rewritten, because
 * rewriting it would invalidate the token every shim already holds.
 *
 * The mode is re-asserted on every call, not only at creation: a token file
 * that has drifted to 0644 (an editor rewrite, a restored backup) is a real
 * exposure, and noticing it costs one `chmod`.
 */
export function ensureLocalDaemonToken(
  options: {
    env?: NodeJS.ProcessEnv;
    deps?: LocalDaemonFsDeps;
    generate?: () => string;
  } = {}
): EnsureTokenResult {
  const env = options.env ?? process.env;
  const deps = options.deps ?? makeProductionFsDeps();
  // Hex-encoded byte-by-byte rather than `.toString("hex")`: under this
  // repo's Bun/TS type resolution `randomBytes` yields a Uint8Array whose
  // `toString` takes no encoding argument, so the idiomatic form does not
  // typecheck. 32 bytes → 64 hex chars.
  const generate =
    options.generate ??
    (() => Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join(""));
  const target = localDaemonTokenPath(env);

  if (deps.existsSync(target)) {
    const existing = deps.readFileSync(target).trim();
    if (existing.length > 0) {
      if (deps.statMode(target) !== TOKEN_FILE_MODE) {
        deps.chmodSync(target, TOKEN_FILE_MODE);
      }
      return { token: existing, path: target, created: false };
    }
  }

  const token = generate();
  deps.mkdirSync(path.dirname(target));
  deps.writeFileSync(target, `${token}\n`, TOKEN_FILE_MODE);
  // Explicit chmod after write: `writeFileSync`'s mode is subject to the
  // process umask, so a 0022 umask would otherwise yield 0644 on a file the
  // spec requires to be 0600. Asserting it separately is not redundant.
  deps.chmodSync(target, TOKEN_FILE_MODE);
  return { token, path: target, created: true };
}

// ---------------------------------------------------------------------------
// Port conflict: identity-asserting adopt-or-fail
// ---------------------------------------------------------------------------

/** What a `/health` probe against the occupied port produced. */
export type HealthProbeOutcome =
  | { kind: "body"; body: unknown }
  | { kind: "unreachable"; detail: string }
  | { kind: "http-error"; status: number };

export type PortConflictDecision =
  | { action: "adopt"; detail: string }
  | { action: "fail"; detail: string };

/**
 * Decide what to do when the port is already bound.
 *
 * Adopt ONLY on an asserted `service: "minsky-mcp"` identity. Everything else
 * fails: a 200 from an unidentified service is the mt#3142 signature (a
 * different Minsky app answering `/health` exactly like the right one), and
 * mt#3811 observed a client's own model spawning a competing daemon on this
 * port with shell access — so "something answers" is specifically not enough.
 *
 * Failing is never "pick another port". A different port is a URL the
 * configured clients will not reach.
 */
export function classifyPortConflict(probe: HealthProbeOutcome): PortConflictDecision {
  if (probe.kind === "unreachable") {
    return {
      action: "fail",
      detail: `the port is bound but /health did not answer (${probe.detail})`,
    };
  }
  if (probe.kind === "http-error") {
    return {
      action: "fail",
      detail: `/health answered HTTP ${probe.status}`,
    };
  }
  const result: HealthIdentityResult = assertServiceIdentity(probe.body, SERVICE_IDENTITIES.mcp);
  if (result.ok) {
    return { action: "adopt", detail: `an existing ${result.service} daemon holds the port` };
  }
  return { action: "fail", detail: describeHealthIdentityResult(result) };
}

/**
 * The message a failed adopt-or-fail prints.
 *
 * Names the port and the occupying pid because those are the two things an
 * operator needs to act, and a bare "address in use" supplies neither.
 */
export function formatPortConflictFailure(input: {
  host: string;
  port: number;
  pid: number | null;
  detail: string;
}): string {
  const owner =
    input.pid === null
      ? "the occupying process could not be identified"
      : `occupied by pid ${input.pid}`;
  return (
    `Refusing to start the local MCP daemon: ${input.host}:${input.port} is already in use — ` +
    `${owner}. Identity check: ${input.detail}. ` +
    `The port is a contract (ADR-038 §Question 4) — binding elsewhere would produce a daemon ` +
    `no configured client can reach, so this is a hard stop rather than a fallback. ` +
    `Stop the occupying process, or start the daemon on a different port AND update the shim URL.`
  );
}

/** Probe `/health` on an occupied port. Never throws. */
export async function probeHealthIdentity(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<HealthProbeOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok && response.status !== 503) {
      // 503 is a legitimate Minsky MCP answer (persistence unhealthy, mt#2949)
      // and still carries the identity body, so it is read rather than
      // rejected on status alone.
      return { kind: "http-error", status: response.status };
    }
    return { kind: "body", body: await response.json() };
  } catch (error) {
    return { kind: "unreachable", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The pid holding a TCP listener on `port`, or null.
 *
 * Best-effort and diagnostic only — a null degrades the failure message, it
 * never changes the adopt-or-fail decision, which is why a failure here is
 * swallowed rather than propagated.
 */
export function findListenerPid(
  port: number,
  execImpl: (command: string) => string = defaultExec
): number | null {
  try {
    const out = execImpl(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).trim();
    const first = out.split(/\s+/)[0];
    if (!first) return null;
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function defaultExec(command: string): string {
  return String(
    execSync(command, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
  );
}
