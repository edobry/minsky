/**
 * Cockpit port recovery — detect what's holding a port, recognize our own
 * stale instances via the per-workspace state file (owned by lifecycle.ts),
 * and provide opt-in kill of recognized zombies (never of arbitrary
 * processes). Also provides a best-effort cross-platform browser opener for
 * the `--open` flag.
 *
 * State-file ownership moved to src/cockpit/lifecycle.ts in mt#1904:
 * recognition is now per-workspace, so concurrent cockpits in different
 * operator session workspaces don't false-positive each other.
 *
 * @see mt#1887 — port-recovery (this module)
 * @see mt#1904 — lifecycle refactor; src/cockpit/lifecycle.ts owns the state file
 * @see src/mcp/daemon-state.ts — sibling state-file convention
 */

import { execSync, spawn, type SpawnOptions } from "child_process";
import { readCurrentCockpitState, type CockpitState } from "./lifecycle";
import { log } from "@minsky/shared/logger";

// The project's narrowed `process` type omits EventEmitter methods like
// `kill`. Cast to a Node-shaped surface for the signal-handling APIs we
// need — mirrors the pattern at `src/mcp/server.ts:1340-1345`.
// eslint-disable-next-line custom/no-excessive-as-unknown
const proc = process as unknown as {
  pid: number;
  kill(pid: number, signal: NodeJS.Signals | number): void;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PortHolder {
  pid: number;
  command: string;
}

export type PortClassification =
  | { kind: "free" }
  | { kind: "recognized-zombie"; pid: number; command: string }
  | { kind: "unrecognized"; pid: number; command: string };

// ---------------------------------------------------------------------------
// Process introspection
// ---------------------------------------------------------------------------

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    proc.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === "EPERM";
  }
}

/**
 * Find the process holding the given port. Returns null on Windows (no `lsof`)
 * or if `lsof` isn't available — port-recovery degrades to the standard
 * EADDRINUSE error in that case.
 *
 * Scoped to LOOPBACK (mt#3787). `-i :<port>` matches that port number on ANY
 * address, and the first PID of a multi-line result wins — so any process
 * listening on the same port on another interface could be named as the
 * holder. On a machine where Tailscale serves the cockpit port on the tailnet
 * addresses, `lsof -i :3737 -sTCP:LISTEN -P -n -t` returned Tailscale's PID
 * before the cockpit daemon's, and the sole consumer
 * (`src/commands/cockpit/start-command.ts`) then told the operator to kill it.
 * `-i tcp@localhost:<port>` resolves through both loopback families — verified
 * against a live IPv6-only listener, which `tcp@127.0.0.1` misses — while
 * excluding every non-loopback address.
 *
 * Independent re-implementation of `pid_on_port` in
 * `cockpit-tray/src-tauri/src/supervisor.rs` (mt#2629) — this side
 * additionally resolves the holder's command line for zombie-recognition
 * (see `classifyPortHolder` below) and spells the filter differently, but both
 * are now loopback-scoped, both filter to LISTEN-state sockets only, and both
 * treat "no matching PID" as "port free". Not unified: the Rust
 * supervisor must keep working with no Minsky CLI/MCP process running at
 * all. See `contract/README.md` §2 for the documented semantics both
 * implementations share.
 */
export function findPortHolder(port: number): PortHolder | null {
  if (process.platform === "win32") return null;

  let pidLine: string;
  try {
    pidLine = execSync(`lsof -i tcp@localhost:${port} -sTCP:LISTEN -P -n -t`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      encoding: "utf-8",
    }).toString();
  } catch {
    // lsof exits non-zero when nothing matches.
    return null;
  }

  const firstPid = parseInt(pidLine.split(/\s+/).filter(Boolean)[0] ?? "", 10);
  if (!Number.isInteger(firstPid) || firstPid <= 0) return null;

  let command = "<unknown>";
  try {
    command = execSync(`ps -p ${firstPid} -o command=`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      encoding: "utf-8",
    })
      .toString()
      .trim();
  } catch {
    // Fall through with "<unknown>" — still report the PID.
  }
  return { pid: firstPid, command };
}

// ---------------------------------------------------------------------------
// Classification
//
// "recognized-zombie" requires THIS workspace's prior cockpit state to match
// the port-holder. Peer cockpits in other workspaces are "unrecognized" — we
// will never auto-kill another workspace's cockpit even with `--force`.
// ---------------------------------------------------------------------------

export function classifyPortHolder(port: number): PortClassification {
  const holder = findPortHolder(port);
  if (!holder) return { kind: "free" };
  return classifyHolderAgainstState(holder, port, readCurrentCockpitState(), isProcessAlive);
}

/**
 * Pure half of `classifyPortHolder`, split out so the void-record rule is
 * testable without a real port or state file (ADR-036; the same split
 * `decideIncumbentDisposition` uses, and for the same reason — the file-backed
 * `port-recovery.test.ts` races on the workspace's real cockpit state under the
 * full suite, mt#3543/mt#3733).
 *
 * The rule (mt#4800 SC3): a state record naming a DEAD pid is VOID. It
 * describes a process that no longer exists, so it can neither recognize the
 * holder nor be cited against it — classification proceeds exactly as if no
 * record existed. Today that is also what falls out of the pid-equality check
 * (a live holder can never equal a dead recorded pid), so this guard changes no
 * current output; it exists to make the invariant structural rather than
 * incidental, so a future consumer of the record cannot start treating a stale
 * pid as evidence. The 2026-08-31 incident's refusal message cited a pid that
 * was dead by diagnosis time, which is what promoted this from incidental to
 * asserted.
 */
export function classifyHolderAgainstState(
  holder: PortHolder,
  port: number,
  state: Pick<CockpitState, "pid" | "port"> | null,
  isAlive: (pid: number) => boolean
): PortClassification {
  const record = state !== null && isAlive(state.pid) ? state : null;
  if (record && record.pid === holder.pid && record.port === port) {
    return { kind: "recognized-zombie", pid: holder.pid, command: holder.command };
  }
  return { kind: "unrecognized", pid: holder.pid, command: holder.command };
}

// ---------------------------------------------------------------------------
// Incumbent disposition (mt#4205)
//
// `recognized-zombie` says the port-holder IS this workspace's cockpit. It does
// NOT say whether that cockpit is still working — and until mt#4205 the command
// refused to displace it either way, so the one holder it could identify with
// certainty was the one it never cleared. Every known daemon-wedge mechanism
// (mt#3039 / mt#3051 / mt#3060 / mt#3682) leaves the process ALIVE and holding
// the port, so that refusal turned any wedge into an outage lasting until a
// human found `--force`.
//
// The disposition below is ADR-014's adoption rule applied to this path: its
// implementation notes prescribe pairing the failed bind with a health probe to
// confirm the holder is ours, and its 2026-08-12 amendment fixes what "ours"
// means. The tray supervisor already implements this
// (`cockpit-tray/src-tauri/src/supervisor/daemon_core.rs`'s `is_ours`); this is
// the same predicate on the CLI path, not a second answer to the question.
// ---------------------------------------------------------------------------

/**
 * The identity every cockpit daemon publishes at `GET /api/health`
 * (`src/cockpit/routes/health.ts`), pinned cross-language by
 * `contract/cockpit-health-shape.json`.
 */
export const COCKPIT_SERVICE_IDENTITY = "minsky-cockpit";

/** Path the health probe targets — `/api/health`, not `/health`. */
const HEALTH_PATH = "/api/health";

/**
 * Longer than the 2s `cockpit status` uses for the same endpoint, deliberately:
 * there, a timeout costs a blank status line; here it costs the incumbent its
 * life. The asymmetry runs one way, so the probe is given room to answer.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Tolerance when matching the state file's `startedAt` against the holder's
 * real start time. Absorbs `ps` second-granularity and clock jitter; a recycled
 * PID misses by orders of magnitude more than this.
 */
export const PID_REUSE_SKEW_MS = 5_000;

/** What `cockpit start` should do about a recognized cockpit holding the port. */
export type IncumbentDisposition = { kind: "preserve"; reason: string } | { kind: "displace" };

/**
 * The three observations `decideIncumbentDisposition` decides from.
 *
 * Separated from the IO below so the decision is testable without a real port,
 * a real state file, or an HTTP hop (ADR-036) — the same split
 * `resolveDaemonStatus` uses in `launchd.ts`. It also keeps the new tests out of
 * `port-recovery.test.ts`, which races on the workspace's real cockpit state
 * file under the full suite two independent ways (mt#3543, mt#3733).
 */
export interface IncumbentProbes {
  /**
   * `{ service }` when the port ANSWERED (at ANY status), `null` when nothing
   * answered at all. The distinction is the whole decision — see below.
   *
   * Takes the host the bind was ATTEMPTED on, because "nothing answered" must
   * mean the incumbent is unreachable, not that the probe knocked on a
   * different door than the one it is holding.
   */
  health(port: number, bindHost: string): Promise<{ service: string | null } | null>;
  /** The holder's real process start time, ms since epoch; null if unreadable. */
  processStartedAtMs(pid: number): number | null;
  /** `startedAt` from this workspace's cockpit state, ms since epoch; null if absent. */
  recordedStartedAtMs(): number | null;
}

/** The observations, once gathered. */
export interface IncumbentEvidence {
  health: { service: string | null } | null;
  holderStartedAtMs: number | null;
  recordedStartedAtMs: number | null;
}

/**
 * Decide whether a recognized incumbent is a working daemon to leave alone or a
 * wedged one to displace. Pure.
 *
 * Displacing requires a POSITIVE finding that nothing is serving; every other
 * outcome preserves. Three things follow, none of them obvious:
 *
 * 1. **A non-2xx answer counts as ours.** The daemon answers 503 when
 *    persistence is unhealthy (mt#2949), and restarting cannot fix what a 503
 *    reports — killing it would destroy a live process that is correctly
 *    reporting a problem, and mt#3638's pool-recycle would have self-healed it.
 *    So this asks whether the port ANSWERED, never whether it answered `ok`.
 * 2. **A missing `service` is not ours.** Fail-closed, per mt#3148: every
 *    Minsky service is built from the same monorepo and answers 200
 *    identically, so a bare status code cannot tell them apart. An answer we
 *    cannot attribute means the state file no longer describes the holder —
 *    which is a reason to keep hands off, not to kill.
 * 3. **Silence alone is not enough.** With nothing answering there is no body
 *    to attribute, so identity rests entirely on the state file's PID — and a
 *    recycled PID now costs a SIGKILL rather than the harmless refusal it cost
 *    before this change. The recorded `startedAt` must be consistent with the
 *    holder's real start time, and an unreadable start time preserves.
 */
export function decideIncumbentDisposition(evidence: IncumbentEvidence): IncumbentDisposition {
  const { health, holderStartedAtMs, recordedStartedAtMs } = evidence;

  if (health !== null) {
    return health.service === COCKPIT_SERVICE_IDENTITY
      ? {
          kind: "preserve",
          reason: `it is answering ${HEALTH_PATH} as ${COCKPIT_SERVICE_IDENTITY}`,
        }
      : {
          kind: "preserve",
          reason:
            `something is answering ${HEALTH_PATH} on this port, but it does not ` +
            `identify as ${COCKPIT_SERVICE_IDENTITY} ` +
            `(service: ${health.service === null ? "absent" : `"${health.service}"`})`,
        };
  }

  if (holderStartedAtMs === null || recordedStartedAtMs === null) {
    return {
      kind: "preserve",
      reason:
        "nothing answered, but the holder's start time could not be compared " +
        "against the recorded one, so it cannot be confirmed as the same process",
    };
  }

  // A recycled PID belongs to a process that started LONG AFTER the state file
  // was written, so the recorded time sits far in the past relative to it. The
  // opposite direction (a process older than its record) is not checked: it
  // still means the PID is ours, so it is not a kill hazard.
  if (recordedStartedAtMs < holderStartedAtMs - PID_REUSE_SKEW_MS) {
    return {
      kind: "preserve",
      reason:
        "nothing answered, but the holder started after the recorded cockpit " +
        "did — the PID was recycled and belongs to a different process",
    };
  }

  return { kind: "displace" };
}

/**
 * Parse `ps -o etime=` into whole elapsed seconds; null when it does not match.
 *
 * `etime` renders as `[[DD-]HH:]MM:SS` — the last two fields are ALWAYS
 * minutes and seconds, so `00:03` is three seconds, not three minutes.
 *
 * Fields outside that rendering are REJECTED rather than summed (mt#4260):
 * hours > 23, minutes > 59, or seconds > 59 return null. See the bound check
 * below for why erring strict is the safe direction here.
 *
 * Exported because this is the one part of `processStartedAtMs` that can be
 * checked without a live process, and because its predecessor shipped broken:
 * the first version asked `ps` for `etimes` (whole seconds, no parsing needed)
 * — a procps keyword that macOS's `ps` rejects with "keyword not found". Every
 * unit test passed, because they all inject the probe. The live consequence was
 * silent and total: an unreadable start time preserves, so the displacement
 * this task exists to enable would never once have fired on the platform the
 * daemon actually runs on. `etime` is the portable spelling; the parsing is the
 * price of that portability.
 */
export function parseElapsedSeconds(raw: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;

  const h = Number(hours ?? 0);
  const m = Number(minutes);
  const s = Number(seconds);

  // Reject anything outside `etime`'s documented rendering (mt#4260). The regex
  // above matches POSITIONS; it bounds no field, so before this check any
  // numeric garbage in any position became a confident seconds count —
  // `"00:99"` read as 99s, `"0-99:99:99"` parsed, and `"10585853616:18:40"`
  // yielded 38,109,073,018,720s. That last number is not hypothetical: it is
  // exactly what a `test-forced-tz` CI run reported on 2026-08-18, as an age of
  // ~1.2 million years for a `sleep` spawned microseconds earlier.
  //
  // The bounds are `ps`'s, not ours: `etime` renders as `[[DD-]hh:]mm:ss`
  // (ps(1), man7.org/linux/man-pages/man1/ps.1.html), so minutes and seconds are
  // clock fields and hours rolls into the days field past 24. Days is genuinely
  // unbounded — a process can run for years.
  //
  // Erring STRICT is the safe direction, and that follows from the consumer:
  // `realIncumbentProbes.processStartedAtMs` already maps null to null and every
  // caller handles it. So an over-strict bound costs an honest "unknown", while
  // an under-strict one costs a fabricated age that downstream logic treats as
  // real. Note this does NOT fix the underlying flake — it converts an absurd
  // value into a legible null so the next occurrence is diagnosable.
  //
  // CORRECTION (mt#4275): that last sentence overstated what this check does.
  // It converts absurd values in the BOUNDED fields; days is left open by the
  // paragraph above, and the same reading came back through it three hours after
  // this shipped, as `441077234-00:18:40`. The "legible null" is delivered by
  // `startedAtMsFromElapsed` below, which bounds the derived TIMESTAMP rather
  // than another field — see its docblock. This check remains correct and
  // useful; it is simply not sufficient on its own.
  if (h > 23 || m > 59 || s > 59) return null;

  return Number(days ?? 0) * 86_400 + h * 3_600 + m * 60 + s;
}

/**
 * Convert a raw `ps -o etime=` reading into an absolute start time, or null.
 *
 * Pure by construction — `nowMs` is a parameter rather than a `Date.now()` call
 * — so the bound below is testable without depending on the host's `ps`, which
 * is the very thing under suspicion.
 *
 * ## Why the epoch bound exists (mt#4275)
 *
 * `parseElapsedSeconds` bounds hours, minutes and seconds against `ps`'s
 * documented rendering, and deliberately does NOT bound days, because a process
 * can legitimately run for years. That reasoning is right about `ps` and wrong
 * about this consumer, and mt#4260 shipped with the gap: the same absurd
 * reading that motivated the field bounds came back through the one field left
 * open. Decomposed, it was `441077234-00:18:40` — 441 million days, every
 * bounded field in range. mt#4260's originating occurrence recorded the
 * identical garbage as `10585853616:18:40`, parsed then as HOURS; 10,585,853,616
 * hours IS 441,077,234 days. Same reading, different capture group, and only the
 * group seen first was bounded.
 *
 * So the ceiling belongs here rather than in the parser, and it is not a chosen
 * constant: **a process cannot have started before the UNIX epoch.** An elapsed
 * that drives the computed start time negative is not a long-running process, it
 * is a bad reading. That admits a genuinely decade-old process and rejects 441
 * million days, with no threshold to justify or revisit.
 *
 * The parse itself stays faithful — `parseElapsedSeconds` still returns the
 * number the string denotes. Rejecting it is the consumer's call, because only
 * the consumer knows the value becomes a timestamp.
 *
 * ## Integer precision at these magnitudes (R1)
 *
 * `elapsedSec * 1000` for the observed reading is 3.81e16, which is past
 * `Number.MAX_SAFE_INTEGER` (9.01e15) — so the product is imprecise. Measured:
 * `Number.isSafeInteger(38_109_073_018_720 * 1000)` is `false`.
 *
 * That does not weaken the bound, and the reason is worth stating rather than
 * assuming: float error at this scale perturbs low-order digits, never the
 * MAGNITUDE or the SIGN. `nowMs` is ~1.79e12 against a subtrahend of ~3.81e16,
 * so the difference is negative by four orders of magnitude — no rounding
 * reaches that. The check is a sign test, and a sign test is exactly the kind
 * that survives precision loss.
 *
 * The reverse case needs no guard either: a reading small enough to produce a
 * plausible timestamp is far inside the safe range (a decade is 3.15e11 ms), so
 * every value this function ACCEPTS is exact. Imprecision is confined to values
 * it rejects.
 */
export function startedAtMsFromElapsed(raw: string, nowMs: number): number | null {
  const elapsedSec = parseElapsedSeconds(raw);
  if (elapsedSec === null) return null;

  const startedAtMs = nowMs - elapsedSec * 1000;
  // Before the epoch means the reading is impossible, not merely large.
  if (startedAtMs < 0) return null;

  return startedAtMs;
}

/**
 * URL authorities to try for a daemon bound to `bindHost`, in order.
 *
 * `localhost` is NOT usable here, and that is the whole reason this exists.
 * `findPortHolder` identifies the holder with `lsof -i tcp@localhost:<port>`,
 * chosen in mt#3787 precisely because it resolves through BOTH loopback
 * families — verified there against a live IPv6-only listener that
 * `tcp@127.0.0.1` misses. So the classifier can hand us a holder that a
 * `http://localhost:...` fetch never reaches, because `localhost`'s resolution
 * order varies by platform and runtime. The failure is silent and lands on the
 * destructive side: identified as ours, read as "nothing answered", killed.
 * A `--host` bind to a specific non-loopback interface fails the same way.
 *
 * A wildcard bind accepts every local address but does not tell us which family
 * it opened, so both loopback literals are tried. Absence therefore requires
 * EVERY candidate to fail, which keeps the fail-closed direction: an
 * unreachable probe preserves.
 */
export function healthProbeAuthorities(bindHost: string): string[] {
  const host = bindHost.trim();
  if (host === "" || host === "*" || host === "0.0.0.0" || host === "::") {
    return ["127.0.0.1", "[::1]"];
  }
  // The ambiguity itself — resolve it here rather than delegating to the
  // resolver whose answer we cannot see.
  if (host === "localhost") return ["127.0.0.1", "[::1]"];
  if (host === "::1") return ["[::1]"];
  // A bare IPv6 literal needs brackets to be a URL authority.
  if (host.includes(":")) return [`[${host}]`];
  return [host];
}

async function probeHealthAt(
  port: number,
  authority: string
): Promise<{ service: string | null } | null> {
  let resp: Response;
  try {
    resp = await fetch(`http://${authority}:${port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
  } catch {
    // Connection refused, reset, or no answer within the timeout.
    return null;
  }
  // Answered. Its STATUS is deliberately not consulted (see rule 1 above);
  // only the identity in the body is.
  try {
    const body = (await resp.json()) as Record<string, unknown>;
    const service = body["service"];
    return { service: typeof service === "string" ? service : null };
  } catch {
    // Answered with a body we cannot parse — still an answer, still not
    // attributable, so it preserves via rule 2.
    return { service: null };
  }
}

export const realIncumbentProbes: IncumbentProbes = {
  health: async (port, bindHost) => {
    // First answer wins; only an all-candidates miss is absence. Worst case is
    // one timeout per candidate, which is the right trade on a path whose other
    // outcome is killing a healthy daemon.
    for (const authority of healthProbeAuthorities(bindHost)) {
      const answer = await probeHealthAt(port, authority);
      if (answer !== null) return answer;
    }
    return null;
  },

  processStartedAtMs: (pid) => {
    try {
      const raw = execSync(`ps -p ${pid} -o etime=`, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        encoding: "utf-8",
      }).toString();
      return startedAtMsFromElapsed(raw, Date.now());
    } catch {
      // Process gone, or `ps` unavailable.
      return null;
    }
  },

  recordedStartedAtMs: () => {
    const state = readCurrentCockpitState();
    if (!state) return null;
    const parsed = Date.parse(state.startedAt);
    return Number.isFinite(parsed) ? parsed : null;
  },
};

/** Gather the evidence and decide. Thin IO shell over the pure decision above. */
export async function resolveIncumbentDisposition(
  port: number,
  pid: number,
  bindHost: string,
  probes: IncumbentProbes = realIncumbentProbes
): Promise<IncumbentDisposition> {
  return decideIncumbentDisposition({
    health: await probes.health(port, bindHost),
    holderStartedAtMs: probes.processStartedAtMs(pid),
    recordedStartedAtMs: probes.recordedStartedAtMs(),
  });
}

// ---------------------------------------------------------------------------
// Kill zombie (SIGTERM → wait → SIGKILL)
// ---------------------------------------------------------------------------

export interface KillZombieOptions {
  /** Time to wait for SIGTERM to take effect before SIGKILL. Default 2000ms. */
  timeoutMs?: number;
  /** Polling interval while waiting. Default 100ms. */
  pollMs?: number;
}

async function waitForExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (!isProcessAlive(pid)) return true;
  }
  return false;
}

export async function killZombie(pid: number, opts: KillZombieOptions = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 2000;
  const poll = opts.pollMs ?? 100;

  try {
    proc.kill(pid, "SIGTERM");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return; // already dead
    throw err;
  }

  if (await waitForExit(pid, timeout, poll)) return;

  try {
    proc.kill(pid, "SIGKILL");
  } catch {
    // Race: died between checks. Ignore.
    return;
  }

  // SIGKILL is not synchronous. The kernel still has to tear the process down
  // and release its LISTENING socket, and returning before that lets the
  // caller's re-bind race the teardown and take EADDRINUSE on a port whose
  // holder is already dead. Observed 2026-08-17 against a SIGSTOPped daemon
  // (mt#4205): the displacement succeeded, the re-bind failed, and the command
  // exited having killed the incumbent WITHOUT replacing it — strictly worse
  // than the refusal it replaced. A stopped process is exactly the case that
  // reaches here, because it cannot handle the SIGTERM above.
  await waitForExit(pid, timeout, poll);
}

// ---------------------------------------------------------------------------
// Browser opener (best-effort)
// ---------------------------------------------------------------------------

export interface OpenInBrowserOptions {
  /** Override platform detection (test seam). */
  platform?: NodeJS.Platform;
  /**
   * Override spawn implementation (test seam). Must mimic `child_process.spawn`
   * — accept (cmd, args, opts) and return an object with `on(event, handler)`
   * and `unref()`.
   */
  spawnFn?: (cmd: string, args: string[], options: SpawnOptions) => SpawnLike;
  /** Override warn handler (test seam). Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

export interface SpawnLike {
  on(event: string, handler: (err: Error) => void): void;
  unref(): void;
}

function defaultSpawnFn(cmd: string, args: string[], options: SpawnOptions): SpawnLike {
  return spawn(cmd, args, options);
}

export function openInBrowser(url: string, opts: OpenInBrowserOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  // Default to log.cliWarn (CLI-visible via programLogger → stderr) rather than
  // log.warn (suppressed in HUMAN mode unless ENABLE_AGENT_LOGS is set). The
  // --open opener is invoked from a CLI command; opener failures must reach
  // the user. Per PR #1151 R1 (mt#1887) — BLOCKING #1.
  const warn = opts.warn ?? ((m: string) => log.cliWarn(m));
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;

  let cmd: string;
  let args: string[];
  switch (platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "linux":
      cmd = "xdg-open";
      args = [url];
      break;
    case "win32":
      cmd = "cmd";
      // Empty title argument so the url itself isn't treated as the title.
      args = ["/c", "start", "", url];
      break;
    default:
      warn(`Cockpit --open: no default browser opener for platform "${platform}"; skipping.`);
      return;
  }

  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (err: Error) => {
      warn(`Cockpit --open: failed to invoke ${cmd}: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    const e = err as Error;
    warn(`Cockpit --open: failed to invoke ${cmd}: ${e.message}`);
  }
}
