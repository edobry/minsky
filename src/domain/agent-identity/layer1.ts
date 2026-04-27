/**
 * Layer 1 — Ascribed identity resolver (ADR-006).
 *
 * Constructs a process-stable agentId from clientInfo + process signals:
 *   kind   = normalizeClientInfoNameToKind(clientInfo.name)
 *   scope  = "proc"
 *   id     = <16-hex-SHA256(hostname, user, pid, start-time)>
 *
 * Hostname is hashed by default (opt-out via config for single-user legibility).
 * The hash is stable for the lifetime of one MCP server process and
 * non-colliding across distinct processes (different pid or start-time).
 */

import { createHash } from "crypto";
import { hostname as osHostname, userInfo } from "os";
import { type ParsedAgentId } from "./format";
import { normalizeClientInfoNameToKind, KNOWN_KINDS } from "./kinds";

/**
 * Inputs available from MCP clientInfo (from server.getClientVersion()).
 * Only `name` is required; the rest are optional extensions.
 */
export interface ClientInfo {
  name?: string;
  version?: string;
  title?: string;
  websiteUrl?: string;
  description?: string;
}

/**
 * Process-level signals used for the hash.
 * Defaults to current process values; injectable for testing.
 */
export interface ProcessSignals {
  hostname: string;
  username: string;
  pid: number;
  /** Milliseconds since epoch when this process started. Use Date.now() at startup. */
  startTimeMs: number;
}

/**
 * Configuration for Layer 1 resolver.
 */
export interface Layer1Config {
  /**
   * Hash hostname before including in the agentId id field.
   * Default: true (privacy-preserving).
   * Set to false in single-user deployments that prefer human-readable hostnames.
   */
  hashHostname?: boolean;
}

/**
 * Capture process start time once at module-load time.
 * This is stable for the process lifetime and differs across restarts.
 */
const PROCESS_START_TIME_MS = Date.now();

/**
 * Get default process signals from the current runtime.
 */
export function getDefaultProcessSignals(): ProcessSignals {
  let username = "unknown";
  try {
    username = userInfo().username || "unknown";
  } catch {
    // userInfo() can throw on some platforms
  }
  return {
    hostname: osHostname(),
    username,
    pid: process.pid,
    startTimeMs: PROCESS_START_TIME_MS,
  };
}

/**
 * Build the hash id component for Layer 1.
 *
 * Hash inputs (canonical order, tab-separated):
 *   hostname (raw or hashed per config) \t username \t pid \t startTimeMs
 *
 * Returns 16 lowercase hex characters (first 64 bits of SHA-256).
 */
export function buildLayer1HashId(signals: ProcessSignals, config: Layer1Config = {}): string {
  const hostnameComponent =
    config.hashHostname !== false
      ? createHash("sha256").update(signals.hostname).digest("hex").slice(0, 16)
      : signals.hostname;

  const canonical = [
    hostnameComponent,
    signals.username,
    String(signals.pid),
    String(signals.startTimeMs),
  ].join("\t");

  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Resolve a Layer 1 agentId.
 *
 * Returns a fully parsed agentId structure (never null — Layer 1 always
 * produces a value as the last-resort fallback).
 */
export function resolveLayer1(
  clientInfo: ClientInfo | undefined,
  signals?: ProcessSignals,
  config?: Layer1Config
): ParsedAgentId {
  const resolvedSignals = signals ?? getDefaultProcessSignals();
  const resolvedConfig = config ?? {};

  const kind = normalizeClientInfoNameToKind(clientInfo?.name);
  const scope = "proc" as const;
  const id = buildLayer1HashId(resolvedSignals, resolvedConfig);

  // For "unknown" kind, use "hash" scope per ADR-006 examples
  const finalScope = kind === KNOWN_KINDS.UNKNOWN ? ("hash" as const) : scope;

  return { kind, scope: finalScope, id };
}
