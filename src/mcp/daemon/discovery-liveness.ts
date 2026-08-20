/**
 * Is the daemon the discovery record names actually SERVING? (mt#4369)
 *
 * `readDiscoveryRecord` answers "was a record readable", which is a fact about
 * the past: a daemon announced itself here. Consumers need a fact about the
 * present, and the two were indistinguishable — a record left behind by a
 * daemon that died without reaching `removeDiscoveryRecord` names a dead pid on
 * a port with no listener, and reads exactly like a healthy one.
 *
 * Observed 2026-08-20: the record named pid 27569, which did not exist, with
 * zero listeners on 48765, while `/health` refused the connection. An MCP write
 * failed against it.
 *
 * The framing is the presence-vs-liveness split from the "Presence vs lock" RFC
 * (Draft 2026-07-24): the record is a PRESENCE artifact — advisory, "who was
 * recently active" — and every consumer reading it as LIVENESS is reaching for
 * the only column that exists. This module supplies the missing one for this
 * artifact.
 *
 * Three properties that RFC asks for, and why each is here rather than left to
 * the caller:
 *
 *  - **Tri-state, not boolean.** Its move three specifies "a tri-state liveness
 *    read that fails closed when it can't tell." A boolean forces every
 *    can't-tell into one of the two confident answers, and the safe one is not
 *    obvious at the call site.
 *  - **No timeout is load-bearing.** "No timeout may be load-bearing for a
 *    safety property." So nothing here reads `startedAt` and compares it to a
 *    clock — a record is judged by probing the pid and the port, never by age.
 *    `startedAt` is carried through untouched for the caller to log.
 *  - **Identity, not just reachability.** A 200 from the wrong Minsky app is the
 *    mt#3142 signature; `classifyPortConflict` already refuses to adopt on one,
 *    and this reuses the same `assertServiceIdentity` rather than re-deciding.
 */

import {
  type LocalDaemonDiscoveryRecord,
  type HealthProbeOutcome,
  probeHealthIdentity,
  readDiscoveryRecord,
  type LocalDaemonFsDeps,
} from "./local-daemon";
import { isPidAlive } from "@minsky/domain/session/attachment";
import {
  assertServiceIdentity,
  describeHealthIdentityResult,
  SERVICE_IDENTITIES,
} from "@minsky/domain/deployment/health-identity";

/** Why a record is not backing a serving daemon. */
export type NotLiveReason =
  | "no-record"
  | "invalid-address"
  | "pid-dead"
  | "not-serving"
  | "wrong-service";

export type DiscoveryLiveness =
  | { state: "live"; record: LocalDaemonDiscoveryRecord; detail: string }
  | {
      state: "not-live";
      reason: NotLiveReason;
      detail: string;
      record: LocalDaemonDiscoveryRecord | null;
    }
  | { state: "indeterminate"; detail: string; record: LocalDaemonDiscoveryRecord };

/**
 * The ONLY safe way to turn this into a boolean.
 *
 * Exported so a caller never has to write the comparison itself: `state ===
 * "live"` and `state !== "not-live"` differ exactly on `indeterminate`, and the
 * second one is the wrong answer. Fail closed means an unknown daemon is not a
 * usable daemon.
 */
export function isDaemonUsable(liveness: DiscoveryLiveness): boolean {
  return liveness.state === "live";
}

export interface LivenessDeps {
  /** Defaults to the shared local-pid oracle. */
  pidAlive?: (pid: number) => boolean;
  /** Defaults to the same `/health` probe the port-conflict path uses. */
  probe?: (url: string) => Promise<HealthProbeOutcome>;
}

/**
 * Classify an already-read record. Pure apart from the two injected probes,
 * so the state machine is testable without a daemon, a port, or a filesystem.
 */
export async function classifyDiscoveryLiveness(
  record: LocalDaemonDiscoveryRecord | null,
  deps: LivenessDeps = {}
): Promise<DiscoveryLiveness> {
  if (record === null) {
    return {
      state: "not-live",
      reason: "no-record",
      detail: "no discovery record was readable",
      record: null,
    };
  }

  // Validate the address BEFORE anything else touches it. A record whose host
  // or port is unusable is not a daemon we could reach even in principle, and
  // deciding that here keeps every path below working on a checked value.
  const url = healthUrlFor(record);
  if (url === null) {
    return {
      state: "not-live",
      reason: "invalid-address",
      detail: `the record's address is not usable: host ${JSON.stringify(record.host)}, port ${record.port}`,
      record,
    };
  }

  const pidAlive = deps.pidAlive ?? isPidAlive;
  const probe = deps.probe ?? ((target: string) => probeHealthIdentity(target));

  // The pid check runs FIRST but is not authoritative on its own, and the
  // asymmetry is deliberate. `isPidAlive` shells out to `kill -0`, whose
  // non-zero exit means "dead OR owned by another user" — its own doc says the
  // distinction collapses for the self-registered attachments it was written
  // for. The local daemon runs as the same user, so the collapse holds here for
  // the same reason; pid REUSE is likewise accepted rather than defended
  // against, because the port probe below is what actually decides `live`. A
  // pid that is alive by luck still has to answer /health with the right
  // identity.
  //
  // So a dead pid short-circuits (cheap, and conclusive in the safe direction)
  // while a live pid proves nothing by itself.
  if (!pidAlive(record.pid)) {
    return {
      state: "not-live",
      reason: "pid-dead",
      detail: `the record names pid ${record.pid}, which is not running`,
      record,
    };
  }

  const outcome = await probe(url);

  if (outcome.kind === "unreachable") {
    return {
      state: "not-live",
      reason: "not-serving",
      detail: `pid ${record.pid} is running but ${record.host}:${record.port} did not answer /health (${outcome.detail})`,
      record,
    };
  }

  if (outcome.kind === "http-error") {
    // Something is listening and answering, but not in a shape that identifies
    // it. That is genuinely unknown rather than dead — a caller must not treat
    // it as either, which is what the third state is for.
    return {
      state: "indeterminate",
      detail: `${record.host}:${record.port} answered HTTP ${outcome.status}, which carries no service identity`,
      record,
    };
  }

  const identity = assertServiceIdentity(outcome.body, SERVICE_IDENTITIES.mcp);
  if (!identity.ok) {
    return {
      state: "not-live",
      reason: "wrong-service",
      detail: describeHealthIdentityResult(identity),
      record,
    };
  }

  return {
    state: "live",
    record,
    detail: `${identity.service} is serving on ${record.host}:${record.port} as pid ${record.pid}`,
  };
}

/**
 * `/health` URL for a record, or null when the record's address is not one we
 * are willing to send a request to (PR #3207 R1).
 *
 * `readDiscoveryRecord` type-checks the shape — `host` is a string, `port` is a
 * number — and stops there, so an editable `local-mcp.json` can carry a `host`
 * of `"http://example.com"`, a path, or control characters, and a `port` of
 * `-1` or `1e9`. Composing a URL out of that unvalidated mis-targets the probe,
 * and the record is exactly the artifact this module exists to distrust.
 *
 * **Not restricted to loopback, deliberately.** The reviewer suggested
 * asserting it, and `--host` is a real CLI option (`resolveLocalDaemonDefaults`
 * honors `hostFromCli`), so a hard loopback-only rule would reject a legitimate
 * configuration to defend against a local file the operator already controls.
 * The check is therefore STRUCTURAL — is this a bare host and a usable port —
 * which removes the mis-targeting without deciding policy this module does not
 * own.
 *
 * IPv6 literals are bracketed, which the previous string concatenation did not
 * do: `::1` produced `http://::1:48765/health`, which is not a URL.
 */
export function healthUrlFor(record: LocalDaemonDiscoveryRecord): string | null {
  const { host, port } = record;

  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (host.length === 0 || host.length > 255) return null;
  // Anything that could smuggle a scheme, a path, a query, credentials, or a
  // second host past the composition below.
  if (/[/\\?#@\s]/.test(host)) return null;
  // Control characters, which would otherwise ride into the request. Checked
  // by code point rather than a regex escape: a unicode NUL escape in a
  // JSON-parameterized write lands as a literal NUL byte on disk, which the
  // pre-commit guard blocks (mt#1821).
  for (const ch of host) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }

  const isIpv6Literal = host.includes(":");
  if (isIpv6Literal && !/^[0-9a-fA-F:.]+$/.test(host)) return null;
  const authority = isIpv6Literal ? `[${host}]` : host;

  try {
    // Round-trip through URL so a value that survives the checks above but is
    // still unparseable fails here rather than at fetch time.
    return new URL(`http://${authority}:${port}/health`).toString();
  } catch {
    return null;
  }
}

/**
 * Read the record AND classify it — the call a consumer actually wants.
 *
 * `readDiscoveryRecord` remains exactly as it was; this is additive, so no
 * existing caller's contract changes.
 */
export async function readDiscoveryLiveness(
  options: { env?: NodeJS.ProcessEnv; deps?: LocalDaemonFsDeps } & LivenessDeps = {}
): Promise<DiscoveryLiveness> {
  const record = readDiscoveryRecord({ env: options.env, deps: options.deps });
  return classifyDiscoveryLiveness(record, {
    pidAlive: options.pidAlive,
    probe: options.probe,
  });
}
