import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import type { Server } from "http";
import type express from "express";
import { createCockpitServer, getResolvedAllowedHosts } from "../../cockpit/server";
import { startSseBrokerWarmup } from "../../cockpit/routes/events";
import {
  startAskAdvancementSweeper,
  startStaleAskCloseSweeper,
  startProdStateRefreshSweeper,
  startShortIdMapSweeper,
  startAskStateRefreshSweeper,
  startConversationTitleSweeper,
  startConversationSummarySweeper,
  startTopologySweeper,
  startGuardEventsSweepBackstop,
  startInterceptorAggregatesSweeper,
  startDispatchWatchdogSweeper,
  startDeploySmokeSweeper,
  startFollowUpSweeper,
  startConversationPresenceSweeper,
  startSweepMetaWatchdog,
} from "../../cockpit/sweepers";
// mt#4480: lifted out of sweepers.ts when that file hit the max-lines ceiling.
import { startTranscriptSweepBackstop } from "../../cockpit/transcript-sweep-backstop";
// mt#4537: same reason — a sweep of its own rather than more of sweepers.ts.
import { startWakePendingRetentionSweeper } from "../../cockpit/wake-pending-retention-sweeper";
import { installDaemonFileLogging } from "../../cockpit/daemon-file-log";
import {
  classifyUncaughtException,
  createSurvivedErrorLogger,
  formatErrorForLog,
} from "../../cockpit/daemon-error-policy";
import { refreshSchemaReadinessFromDb } from "../../cockpit/schema-readiness";
import { startStdioLogRotationSweeper } from "../../cockpit/stdio-log-rotation";
import {
  markDbDegraded,
  startDbRetryBackoff,
  getSharedProvider,
  PersistenceInitTimeoutError,
} from "../../cockpit/shared-persistence";
import {
  isDbConditionSqlStateClass,
  sqlStateClass,
} from "@minsky/domain/persistence/connection-failure";
import { emitSystemEventFromProvider } from "@minsky/domain/events/emit-best-effort";
import { registerEmbeddingsHealthEventEmitter } from "@minsky/domain/ai/embeddings-health-wiring";
import { log } from "@minsky/shared/logger";
import {
  classifyPortHolder,
  killZombie,
  openInBrowser,
  resolveIncumbentDisposition,
} from "../../cockpit/port-recovery";
import { removeCurrentCockpitState, writeCurrentCockpitState } from "../../cockpit/lifecycle";
import { startTranscriptWatcher } from "../../cockpit/transcript-watcher";
import { ensureDevChromiumRunning } from "../../cockpit/dev-chromium";
import { cockpitIndexHtml } from "../../cockpit/web-dist";
import { getCockpitTokenPath, isLoopbackHost, getOrCreateCockpitToken } from "../../cockpit/auth";
import { resolveCockpitPort, COCKPIT_PORT_FLAG_DESCRIPTION } from "./port";
import { attachDrivenSessionWebSocket } from "../../cockpit/driven-session-ws";
import {
  createHighestUpdateIdReader,
  createInboundEventRecorder,
  getPrincipalChannelDb,
  respondToAskFromChannel,
  startPrincipalChannel,
} from "../../cockpit/principal-channel-launch";
import { loadPersistedDrivenSessions } from "../../cockpit/driven-session-launch";

// mt#3988: the local `DEFAULT_PORT = 3737` that used to live here is gone —
// `DEFAULT_COCKPIT_PORT` in ./port is the single fallback, so this command, the
// status/install commands and the tray cannot drift apart.

/**
 * Default bind host (mt#2538): loopback-only. Binding to any other
 * interface (via `--host`) exposes the cockpit's data (tasks, sessions,
 * transcripts, live events) and command surface to that interface — e.g.
 * the whole LAN for a bare IP or `0.0.0.0`.
 */
export const DEFAULT_HOST = "127.0.0.1";

// __dirname is used only for the --dev Vite web root (which requires a source
// checkout). The PRODUCTION web-dist path is resolved bundle-aware via
// cockpitIndexHtml() (process.cwd()-based) — see src/cockpit/web-dist.ts (mt#2283).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type ListenAttempt =
  | { kind: "ok"; server: Server }
  | { kind: "in-use" }
  | { kind: "error"; err: Error };

/**
 * Bind-or-fail: race the 'listening' event against 'error'. EADDRINUSE is
 * classified separately from other errors so the caller can attempt recovery.
 */
/**
 * Record that a previous cockpit instance was terminated to free the port
 * (mt#4205).
 *
 * Called only AFTER the replacement server has bound, because this command's
 * port guard runs before any configuration or persistence initialization — an
 * emit at the decision point would resolve no provider and no-op silently,
 * which is exactly the evidence-loss mt#4154 hit when it tried to reconstruct
 * the 2026-08-06 outage from `system_events` and found the table could not
 * distinguish "the daemon was fine" from "nobody was working".
 *
 * Never throws: a failed emission must not take down a daemon that has already
 * successfully bound its port.
 */
async function recordPortDisplacement(
  port: number,
  displaced: { pid: number; command: string; forced: boolean }
): Promise<void> {
  try {
    await emitSystemEventFromProvider(await getSharedProvider(), {
      eventType: "cockpit.port_displaced",
      payload: {
        port,
        displacedPid: displaced.pid,
        displacedCommand: displaced.command,
        // `forced` records WHY the kill was allowed: false is the mt#4205 path
        // (the incumbent answered nothing), true means the disposition said
        // preserve and the operator overrode it with --force. Without it the
        // row cannot distinguish an automatic recovery from a manual one.
        forced: displaced.forced,
      },
      actor: "cockpit-start",
    });
  } catch (err) {
    log.warn("cockpit.port_displaced: could not record the displacement", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function attemptListen(
  app: express.Express,
  port: number,
  host: string
): Promise<ListenAttempt> {
  const server = app.listen(port, host);
  return new Promise<ListenAttempt>((resolve) => {
    server.once("listening", () => resolve({ kind: "ok", server }));
    server.once("error", (err: NodeJS.ErrnoException) => {
      try {
        server.close();
      } catch {
        // Already torn down by the failed bind.
      }
      if (err.code === "EADDRINUSE") {
        resolve({ kind: "in-use" });
      } else {
        resolve({ kind: "error", err });
      }
    });
  });
}

/**
 * postgres-js CLIENT-SIDE error codes (gh#1761): the driver's own codes for a
 * tripped circuit breaker or a recycled connection.
 *
 * This is a DIFFERENT CODE SPACE from the server-side SQLSTATEs below, and
 * conflating the two is what mt#4100 was. Every code here is client-side, so a
 * SQLSTATE — the `code` Postgres itself returns — matched none of them, and a
 * cancelled statement took the whole daemon down.
 */
const CLIENT_SIDE_DEGRADATION_CODES = new Set([
  "ECIRCUITBREAKER",
  "EDBHANDLEREXITED",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
]);

// `DB_CONDITION_SQLSTATE_CLASSES` and `sqlStateClass` now live in
// `@minsky/domain/persistence/connection-failure` (imported above). mt#4519 found a
// SECOND consumer of the same taxonomy — the transcript-ingest quarantine counter,
// which had this exact code-space gap for this exact reason — so the definition
// moved to one place rather than being copied a third time. The full class list,
// PostgreSQL Appendix A citation, and the "NOT transient" reasoning travelled with
// it; read the docblock there.
//
// What did NOT move is the reading of it below: for THIS handler the question is
// "is this a defect in THIS PROCESS?", and killing a daemon serving live clients
// does not undrop a database — it drops every in-flight page load, SSE stream and
// driven-session websocket, and respawns into the same condition (ADR-014 raised
// `ThrottleInterval` to 60 s to survive that loop). The ingest consumer asks a
// different question of the same set: "is this a fact about the database rather
// than about this session?" One taxonomy, two readings.

/**
 * The subset of the above that failed ONE STATEMENT on a connection that is
 * still fine — as opposed to a connection or server that is unusable.
 *
 * Class 40 (Transaction Rollback: serialization_failure, deadlock_detected) is
 * per-transaction by definition. `57014` query_canceled is a statement timeout.
 * `57P05` idle_session_timeout reaped one idle session, which needs a new
 * connection, not a new pool.
 *
 * The distinction matters because "degrade" is not free: `markDbDegraded()`
 * nulls the shared singleton and bumps the persistence epoch, which every
 * cached consumer keys on (mt#3638), and publishes `db: "degraded"` on
 * `/api/health` — a surface the tray watches. Doing that because one query
 * timed out tears down a working pool and reports a false problem.
 */
const STATEMENT_LEVEL_SQLSTATES = new Set(["57014", "57P05"]);
const STATEMENT_LEVEL_SQLSTATE_CLASSES = new Set(["40"]);

/**
 * What the `unhandledRejection` handler should do with `reason`.
 *
 * Mirrors `classifyUncaughtException`'s two-way disposition in
 * `daemon-error-policy.ts`, with a third arm the DB side needs: `"degrade"`
 * changes daemon state (pool teardown + retry backoff), `"survive"` changes
 * nothing at all.
 */
export type UnhandledRejectionDisposition = "degrade" | "survive" | "exit";

function readErrorCode(reason: unknown): string | undefined {
  if (reason === null || typeof reason !== "object") return undefined;
  if (!("code" in reason)) return undefined;
  const code = (reason as { code: unknown }).code;
  return code === undefined || code === null ? undefined : String(code);
}

/**
 * Decides whether an unhandled rejection should degrade the DB, be survived
 * silently, or terminate the daemon.
 *
 * Two code spaces reach this, and they are matched separately:
 *
 *   - **Client-side** — postgres-js's own codes (`CLIENT_SIDE_DEGRADATION_CODES`)
 *     plus `PersistenceInitTimeoutError`. All connection-level → `"degrade"`.
 *   - **Server-side** — a five-character SQLSTATE returned by Postgres. Matched
 *     by CLASS (`DB_CONDITION_SQLSTATE_CLASSES`), not by an enumerated list, so
 *     a sibling code is covered without another incident. Split into
 *     `"survive"` and `"degrade"` per `STATEMENT_LEVEL_SQLSTATES`.
 *
 * Assignment principle for a member not named above: **is the connection
 * unusable, or did just this statement fail?** Statement → `"survive"`;
 * connection or server → `"degrade"`.
 *
 * Everything else exits. That deliberately includes class 42 (Syntax Error or
 * Access Rule Violation) — a malformed query is a bug in our code, and this
 * classifier must not become "swallow everything".
 *
 * @internal Exported for unit testing only.
 */
export function classifyUnhandledRejection(reason: unknown): UnhandledRejectionDisposition {
  if (reason instanceof PersistenceInitTimeoutError) return "degrade";

  const code = readErrorCode(reason);
  if (code === undefined) return "exit";
  if (CLIENT_SIDE_DEGRADATION_CODES.has(code)) return "degrade";

  const stateClass = sqlStateClass(code);
  if (stateClass === undefined || !isDbConditionSqlStateClass(stateClass)) return "exit";

  return STATEMENT_LEVEL_SQLSTATES.has(code) || STATEMENT_LEVEL_SQLSTATE_CLASSES.has(stateClass)
    ? "survive"
    : "degrade";
}

/**
 * The side effects the `unhandledRejection` handler performs, injected so the
 * handler's branching is testable without patching the modules it reaches.
 */
export interface UnhandledRejectionEffects {
  /**
   * Rate-limited survived-error logger (`createSurvivedErrorLogger`). The
   * `"survive"` branch uses it rather than a bare write because a statement
   * timeout recurs for as long as the load does — the same repetition that put
   * one signature in a rotated log 190 times (mt#3626).
   */
  logSurvived: (reason: unknown) => void;
  /**
   * Writes ONE operator-facing line to **stderr**, for the degrade and exit
   * branches.
   *
   * The stderr binding is part of the contract, not an implementation detail
   * of the current wiring (PR #2970 R1). These lines are what an operator
   * greps `cockpit-daemon.log` for when a daemon degrades or dies, and
   * `daemon-file-log.ts` captures the stream — routing them to stdout or into
   * a structured logger that drops the stream would silently retire an
   * operator-visible signature with nothing failing. The exact text of both
   * lines is asserted in `start-command.test.ts` for the same reason.
   */
  logErrorLine: (line: string) => void;
  markDegraded: () => void;
  /** Starts the retry loop and returns its stop function. */
  startRetryBackoff: () => () => void;
  cleanup: () => void;
  exit: () => void;
}

/**
 * Builds the `unhandledRejection` handler, closing over the retry-loop handle
 * so a second degradation cancels the first loop rather than stacking one.
 *
 * @internal Exported for unit testing only.
 */
export function createUnhandledRejectionHandler(
  effects: UnhandledRejectionEffects
): (reason: unknown) => void {
  let stopDbRetry: (() => void) | null = null;

  return (reason: unknown) => {
    switch (classifyUnhandledRejection(reason)) {
      case "survive":
        effects.logSurvived(reason);
        return;
      case "degrade": {
        const message = reason instanceof Error ? reason.message : String(reason);
        effects.logErrorLine(`Cockpit: DB unavailable — degrading gracefully: ${message}`);
        effects.markDegraded();
        if (stopDbRetry !== null) stopDbRetry();
        stopDbRetry = effects.startRetryBackoff();
        return;
      }
      case "exit":
        effects.cleanup();
        // mt#3626: the degradation branch above keeps its message-only line
        // (its errors are classified, and their text is the useful part); this
        // fatal branch records the stack, same as `uncaughtException`.
        effects.logErrorLine(`Cockpit: unhandled rejection: ${formatErrorForLog(reason)}`);
        effects.exit();
    }
  };
}

/**
 * Create the cockpit "start" subcommand.
 */
export function createStartCommand(): Command {
  const startCommand = new Command("start");
  startCommand.description("Start the Cockpit dashboard server");
  startCommand
    // mt#3988: no commander default — see `resolveCockpitPort`. A default here
    // would make an explicit `--port 3737` indistinguishable from an unset
    // flag, so `cockpit.port` could never take effect.
    .option("--port <port>", COCKPIT_PORT_FLAG_DESCRIPTION)
    .option(
      "--force",
      "Terminate a previous cockpit instance holding the port even when it is still " +
        "answering /api/health. Not needed to clear one that has stopped answering — " +
        "that is displaced automatically. Never terminates unrecognized processes."
    )
    .option("--open", "After the server starts, open the cockpit URL in the default browser.")
    .option(
      "--no-dev-chromium",
      "Skip launching the dedicated dev chromium (used by chrome-devtools-mcp " +
        "for agent-driven UI inspection). Useful for headless / CI contexts."
    )
    .option(
      "--dev",
      "Enable dev mode: Vite serves the frontend with HMR, no pre-built bundle needed. " +
        "Use with `bun --watch` for server-side auto-restart."
    )
    .option(
      "--host <host>",
      `Interface to bind to (default: ${DEFAULT_HOST} — loopback only). Binding to any ` +
        "other interface exposes the cockpit's data (tasks, sessions, transcripts, live " +
        "events) and command surface to that interface — e.g. your whole LAN for a bare " +
        "IP or 0.0.0.0. Only opt in if you understand that risk.",
      DEFAULT_HOST
    )
    .action(async (options) => {
      // mt#2894: install rotating daemon file logging + force-enable the
      // structured warn/error channel as the FIRST thing this handler does —
      // before any sweeper or other module's first log.*() call, so the
      // shared logger singleton (lazily initialized on first use) picks up
      // ENABLE_AGENT_LOGS. See src/cockpit/daemon-file-log.ts's docblock for
      // why this was previously a silent gap.
      installDaemonFileLogging();

      // Stdio-redirect log rotation (mt#3298): bounds the supervisor-written
      // cockpit-{stdout,stderr}.log capture files via copy-then-truncate —
      // the one launch-path-agnostic place a size policy can live, since the
      // files' fds are owned by whichever supervisor started this process.
      // Started immediately after logging install (PR #2387 R1) so the boot
      // tick bounds an oversized file left by a previous run before the
      // subsystems below begin writing to stdout/stderr. Filesystem-only;
      // deliberately not gated on schema readiness.
      const stopStdioLogRotationSweeper = startStdioLogRotationSweeper();

      let port: number;
      try {
        port = resolveCockpitPort(options.port);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      const host: string = options.host || DEFAULT_HOST;
      if (!isLoopbackHost(host)) {
        console.warn(
          `WARNING: cockpit daemon binding to ${host} — this exposes cockpit data ` +
            "(tasks, sessions, transcripts, live events) and command endpoints to any " +
            "host that can reach this interface (e.g. your LAN).\n" +
            "  Auth posture on a non-loopback bind: the daemon serves plain HTTP (no TLS), " +
            "so the bearer token would traverse the network in the clear, and any host that " +
            "can reach this interface can attempt to brute-force it. Cookie bootstrap is " +
            "DISABLED on non-loopback binds — mutation clients must send an explicit " +
            "`Authorization: Bearer <token>` header (token at " +
            `${getCockpitTokenPath()}). Prefer an SSH tunnel or a TLS-terminating reverse ` +
            "proxy over a bare non-loopback bind."
        );
      }

      const isDev = !!options.dev;

      // Check that the frontend bundle has been built (skip in dev mode)
      if (!isDev && !fs.existsSync(cockpitIndexHtml(__dirname))) {
        console.error("Cockpit bundle not built. Run `bun run cockpit:build` first.");
        process.exit(1);
      }

      const app = createCockpitServer({ dev: isDev, host });

      // In dev mode, attach Vite middleware for frontend HMR.
      if (isDev) {
        const webRoot = path.join(__dirname, "..", "..", "cockpit", "web");
        if (!fs.existsSync(webRoot)) {
          console.error(
            `Dev mode requires a source checkout (expected ${webRoot}).\n` +
              "Use production mode (without --dev) for installed/bundled contexts."
          );
          process.exit(1);
        }
        try {
          const { createServer: createViteServer } = await import("vite");
          const vite = await createViteServer({
            root: webRoot,
            server: { middlewareMode: true },
            appType: "spa",
          });
          app.use(vite.middlewares);
        } catch (err) {
          const e = err as Error;
          console.error(
            `Failed to start Vite dev server: ${e.message}\n` +
              "Ensure dev dependencies are installed (bun install)."
          );
          process.exit(1);
        }
      }

      let attempt = await attemptListen(app, port, host);

      // Set when a previous instance was terminated to free the port. Recorded
      // as a system event AFTER the replacement binds (mt#4205) — emitting at
      // the kill would run before this process has any persistence provider and
      // silently no-op, which is the evidence-loss shape mt#4154 found.
      let displaced: { pid: number; command: string; forced: boolean } | null = null;

      // EADDRINUSE: classify and (with --force) recover.
      if (attempt.kind === "in-use") {
        const classification = classifyPortHolder(port);
        switch (classification.kind) {
          case "free":
            // Holder vanished between bind and lsof. Retry once.
            attempt = await attemptListen(app, port, host);
            break;
          case "recognized-zombie": {
            // mt#4205: a recognized incumbent is not automatically a zombie.
            // Probe before deciding — a daemon that still answers /api/health
            // as ours is a live incumbent to leave alone (even at 503), and
            // only a positive "nothing is serving" earns a displacement.
            // `--force` remains the operator's override in both directions.
            const disposition = await resolveIncumbentDisposition(port, classification.pid, host);
            if (disposition.kind === "preserve" && !options.force) {
              console.error(
                `Port ${port} is held by a previous cockpit instance ` +
                  `(PID ${classification.pid}: ${classification.command}), ` +
                  `and ${disposition.reason}.`
              );
              console.error(`Run with --force to terminate it and start a new instance.`);
              process.exit(1);
            }
            console.log(
              `Port ${port} held by previous cockpit (PID ${classification.pid}); terminating...`
            );
            await killZombie(classification.pid);
            displaced = {
              pid: classification.pid,
              command: classification.command,
              forced: disposition.kind === "preserve",
            };
            // Retry the bind rather than attempting it once. `killZombie` now
            // waits for the process to exit, but process death and socket
            // release are separate events and the second is not observable from
            // here. A single attempt makes the whole recovery lose a race it
            // wins moments later — and losing it means the incumbent was killed
            // and NOT replaced, which is worse than never having tried.
            attempt = await attemptListen(app, port, host);
            for (let i = 0; attempt.kind === "in-use" && i < 10; i++) {
              await new Promise((r) => setTimeout(r, 200));
              attempt = await attemptListen(app, port, host);
            }
            break;
          }
          case "unrecognized":
            console.error(
              `Port ${port} is in use by PID ${classification.pid} (${classification.command}).`
            );
            console.error(`This is not a recognized cockpit instance; refusing to terminate it.`);
            console.error(
              `Kill PID ${classification.pid} manually, or pass --port to use a different port.`
            );
            process.exit(1);
        }
      }

      if (attempt.kind === "error") {
        console.error(`Failed to start Cockpit on port ${port}: ${attempt.err.message}`);
        process.exit(1);
      }

      if (attempt.kind === "in-use") {
        console.error(
          `Port ${port} is still in use after recovery attempt. ` +
            `Pass --port to use a different port.`
        );
        process.exit(1);
      }

      const server = attempt.server;

      if (displaced !== null) {
        // Fire-and-forget: the port is already bound and the daemon must not
        // wait on the DB to finish booting. Best-effort by contract — a failed
        // emission leaves the console line above as the only record.
        void recordPortDisplacement(port, displaced);
      }

      // Rung 2A driven-session WebSocket channel (mt#2750) — LOCAL DAEMON
      // ONLY (this file IS the local daemon entrypoint; the Railway
      // isPublicDeployment entrypoint is a separate file,
      // services/cockpit/src/server.ts, which never calls this attach
      // function — mirrors the routes/driven-sessions.ts mount gate).
      // WS upgrades bypass Express's request pipeline entirely (they're
      // plain HTTP GETs with `Connection: Upgrade`, handled by a listener on
      // the raw http.Server), so this is attached directly to the `server`
      // handle rather than threaded through createCockpitServer(). The
      // TOKEN is a cheap, deterministic re-read of the same persisted file
      // (idempotent — reading it twice is not a second derivation of
      // anything). `allowedHosts`, by contrast, is a RESOLVED VALUE
      // (bind host + cockpit.allowedHosts config), so it is read back from
      // `app.locals` via `getResolvedAllowedHosts` rather than re-derived —
      // createCockpitServer is the only place that resolves it, and this
      // call site consumes that exact Set instance (mt#3641 PR #2721 R1).
      attachDrivenSessionWebSocket(server, {
        token: getOrCreateCockpitToken(),
        allowedHosts: getResolvedAllowedHosts(app),
      });

      // mt#3038 (RFC "Conversation-first drive" Phase 1) boot reconciliation
      // — the "minimal first slice" step 2: load every non-terminal
      // persisted driven-session row as "reconnecting" so a WS reconnect
      // right after this restart resumes instead of 404ing. Fire-and-forget
      // (never blocks the bind) — persistence init is itself async and this
      // mirrors startSseBrokerWarmup()'s posture below; a client connecting
      // before this resolves just sees a brief "not found yet" that a retry
      // clears once reconciliation completes.
      // The handler below no longer catches reconciliation FAILURES (mt#4103).
      // `loadPersistedDrivenSessions` now reports every outcome it can reach —
      // including a stall, an unavailable database, and a thrown error — as its
      // own single log line, so nothing it handles arrives here. What is left
      // is a genuine backstop: a throw from OUTSIDE its own error handling
      // would otherwise become an unhandled rejection on a fire-and-forget
      // call. Kept for that, and reworded so it can no longer be read as the
      // failure path — a second "reconciliation failed" line would now
      // contradict the one the function itself emits.
      void loadPersistedDrivenSessions().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Warning: driven-session boot reconciliation threw unexpectedly: ${message}`);
      });

      try {
        writeCurrentCockpitState({
          pid: process.pid,
          port,
          url: `http://localhost:${port}`,
        });
      } catch (err) {
        const e = err as Error;
        console.warn(`Warning: could not write cockpit state file: ${e.message}`);
      }

      // Cleanup on shutdown. Idempotent against double-fire across multiple
      // signal sources AND the process-exit path. Per PR #1151 R1 (mt#1887)
      // BLOCKING #2 — signal-only cleanup left stale state files on non-signal
      // shutdown paths (process.exit() called elsewhere, uncaughtException,
      // unhandledRejection, normal event-loop drain). All paths now route
      // through `cleanupSync` which removes the state file unconditionally
      // before exit. State file moved from a single-global path to the
      // per-workspace lifecycle module in mt#1904.
      // SSE broker warmup (mt#2699): started AFTER the bind, as a background
      // retry loop with logging (PR #1860 R1). It awaits the full
      // persistence/DB init (~5 s, network-bound) — awaiting it BEFORE the
      // bind was the dominant share of the cockpit's 6.5 s cold boot (the
      // white-window window for deeplink cold starts). The /api/events route
      // awaits the same cached init promise, so clients connecting during
      // warmup wait instead of missing channels; /api/health reports
      // db:"unreachable" until init completes (documented pre-init state,
      // tolerated by the tray watchdog's 24-poll threshold).
      startSseBrokerWarmup();
      // Embeddings degradation events (mt#4218). This daemon runs the per-turn
      // transcript embedding pipeline in-process (`sweepers.ts` →
      // `PerTurnEmbeddingPipeline`), so `EmbeddingsHealthTracker.recordError`
      // fires here — but until now nothing registered an emitter, so
      // `emitDegradationEvent` resolved null and returned false on every call,
      // before even reaching a log line. The 2026-08-17 degradation ran six
      // hours and left no row.
      //
      // Registered BEFORE the sweepers below, which are what perform the
      // embedding work. Registration itself is synchronous and stores only a
      // closure, so it neither blocks the bind nor needs persistence to be up:
      // `getSharedProvider` is called per emit, not now. Per-call is also what
      // keeps this correct across a pool recycle (mt#3638/mt#3721) — a cached
      // handle from before the recycle would raise `CONNECTION_ENDED` forever.
      registerEmbeddingsHealthEventEmitter(() => getSharedProvider());
      // Ask advancement sweep (mt#2265): advance `detected` asks (route or
      // expire) so the /asks surface reflects reality. Boot pass + 60s loop;
      // fail-open inside the sweeper.
      const stopAskSweeper = startAskAdvancementSweeper();
      // Principal channel (mt#3228): the inbound Telegram poller, which drives
      // a local `claude` conversation with the principal's messages. LOCAL
      // DAEMON ONLY, like the driven-session surfaces above — it spawns the
      // genuine binary with the operator's own credentials. Opt-in
      // (`principalChannel.enabled`); fire-and-forget so a Telegram or
      // Pulumi hiccup can never keep the cockpit from serving.
      let stopPrincipalChannel: (() => void) | null = null;
      void startPrincipalChannel({
        respondToAsk: respondToAskFromChannel,
        recordEvent: createInboundEventRecorder(getPrincipalChannelDb),
        readHighestUpdateId: createHighestUpdateIdReader(getPrincipalChannelDb),
      })
        .then((handle) => {
          stopPrincipalChannel = handle ? () => handle.stop() : null;
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`Warning: principal channel failed to start: ${message}`);
        });
      // Stale-suspended-ask close sweep (mt#3001): recurring reconciliation
      // over `suspended` asks — close parent-terminal authz/review asks,
      // close failed-commit orphans superseded by a later landed commit,
      // expire abandoned commit-auth asks past the TTL. 15-minute cadence.
      const stopStaleAskCloseSweeper = startStaleAskCloseSweeper();
      // wake_pending retention sweep (mt#4537): nothing deleted from that table
      // until this shipped, and the growth was undelivered rows addressed to
      // sessions that no longer exist — 11 of 12 rows when measured. Deletes
      // delivered rows past the retention window and undeliverable ones at any
      // age; never an undelivered row whose addressee is still live.
      const stopWakePendingRetentionSweeper = startWakePendingRetentionSweeper();
      // Prod-state cache refresh (mt#2506): periodically read the prod migration
      // ledger and write the local cache that inject-prod-state.ts injects each turn.
      const stopProdStateSweeper = startProdStateRefreshSweeper();
      // Short-id map sweep (mt#3914): read (short_id, id) for asks, memories and
      // workspaces into a local cache the MessageDisplay linkifier reads, so a
      // bare ask#N/mem#N/ws#N renders clickable. The hook cannot do this read
      // itself — a hook process's Postgres connect is capped below the measured
      // cold-connect time (mt#3744/mt#3879), so it resolves null every time.
      const stopShortIdMapSweeper = startShortIdMapSweeper();
      // Ask-state sweep (mt#3744): read the state of every ask the calibration
      // watermark store names as an open disposition into a local cache the
      // calibration-review-cadence-detector hook reads. Same reason as the
      // short-id map above — ADR-028 D7(5) keeps unbounded-latency network I/O
      // out of the synchronous dispatcher budget.
      const stopAskStateSweeper = startAskStateRefreshSweeper();
      // Slow-clock topology sweep (mt#2602): periodically re-derive the
      // guard-hook registry + interlock history (git log + retrospective.fired
      // correlation) so the plant board's S2 valve inventory and
      // interlock-history drill-down stay current without any per-request
      // derivation.
      const stopTopologySweeper = startTopologySweeper();
      // Transcript watcher (mt#2320): the PRIMARY transcript-capture path from
      // ADR-017 — FS-watch ~/.claude/projects and ingest-on-append so in-flight
      // sessions become searchable without an exit/manual ingest/reboot.
      const stopTranscriptWatcher = startTranscriptWatcher();
      // Transcript sweep backstop (mt#2321): BACKSTOP half of ADR-017 — periodic
      // full-discovery ingest + embedding backfill to cover dropped FS events,
      // sessions missed while the daemon was down, and stale embeddings.
      const stopTranscriptSweep = startTranscriptSweepBackstop();
      // Guard-events sweep backstop (mt#4035, mt#3334 phase 3): THE
      // CORRECTNESS LAYER for the guard/calibration exhaust ingest — the
      // SessionEnd hook is a latency optimization only (SessionEnd does not
      // reliably fire, per ADR-017/mt#2313); this periodic sweep is what
      // guarantees completeness regardless of how a conversation ended.
      const stopGuardEventsSweep = startGuardEventsSweepBackstop();
      // Interceptor-aggregates refresh (mt#4009): computes the catalog-wide
      // guard_events rollup + canary/health/calibration joins off the request
      // path; the interceptor-aggregates widget serves only this snapshot.
      const stopInterceptorAggregatesSweeper = startInterceptorAggregatesSweeper();
      // Conversation-title generation (mt#3321): fill `agent_transcripts.title`
      // for conversations that don't have one, so the cockpit labels a run by
      // what it's ABOUT instead of the first 60 characters of the opening
      // prompt (which is unusable when that prompt is garbled).
      const stopConversationTitleSweeper = startConversationTitleSweeper();
      // Conversation-summary generation (mt#3441): the same treatment for
      // `agent_transcripts.summary`, which had NO automatic caller at all —
      // 11 of 2,108 rows carried one, so the index could not answer "which
      // conversation was the one about X" for 99.5% of its contents.
      const stopConversationSummarySweeper = startConversationSummarySweeper();
      // Schema readiness (mt#3297): populate the /api/health `schema` block at
      // boot, independently of any sweep. The transcript sweep also refreshes
      // it every tick, but relying on that alone would leave `current: null`
      // forever whenever that sweep is not running (PR #2379 R1) — a health
      // field that is permanently "unknown" is indistinguishable from one that
      // is broken, which is the failure shape this whole task removes.
      // Fire-and-forget: it never throws, and boot must not block on the DB.
      void refreshSchemaReadinessFromDb();
      // Dispatch watchdog refresh (mt#2646): periodically check in-flight
      // subagent dispatches (IN-PROGRESS/IN-REVIEW tasks with no commit/PR-
      // event/subagent_invocations progress) and write the flagged set to the
      // local cache that inject-dispatch-watchdog.ts injects each turn.
      const stopDispatchWatchdogSweeper = startDispatchWatchdogSweeper();
      // deploy.smoke sweep (mt#2599): periodically check whether the
      // bundle-boot-smoke GitHub Actions check-run for the commit THIS
      // cockpit process was deployed from has completed, emitting a
      // best-effort deploy.smoke system event once per distinct commit.
      const stopDeploySmokeSweeper = startDeploySmokeSweeper();
      // Scheduled follow-up sweeper (mt#2322 — remaining scope of parent
      // mt#2234): periodic poll of the scheduled_follow_ups table, firing
      // any pending row whose dueAt has passed. The general recurring-job
      // scheduler facility itself IS createIntervalSweeper (already proven
      // general by every sweeper in this list); this is simply its newest
      // registrant plus a DB-durable one-shot primitive layered on top.
      const stopFollowUpSweeper = startFollowUpSweeper();
      // Conversation presence absence-detection sweep (mt#3201, mt#3130
      // Phase 2): detects presence TRANSITIONS the write path structurally
      // cannot emit — above all LIVE -> STALLED, since a killed process emits
      // no event to retract its own `running` row — and pushes them on
      // `minsky.conversation.presence_changed` for the SSE broker. Started
      // BEFORE the meta-watchdog below so the watchdog covers it like every
      // other sweep.
      const stopConversationPresenceSweeper = startConversationPresenceSweeper();
      // The service-window runtime is NOT started here (mt#4410).
      //
      // mt#4313 wired it and mt#4364 fixed it; the principal then retired the
      // attention-window concept on 2026-08-21. `startServiceWindowSweeper`
      // still exists in sweepers.ts and is deliberately uncalled — see its
      // header before wiring it back.
      // Sweep meta-watchdog (mt#2894): a "sweep of sweeps" on its OWN
      // self-rescheduling setTimeout chain (deliberately not setInterval —
      // see sweepers.ts's docblock) that force-restarts any of the
      // sweeps above whose interval has stopped attempting ticks entirely.
      // Covers the class per-tick isolation structurally cannot: a dropped
      // or wedged setInterval handle, not a hung/throwing tick.
      const stopSweepMetaWatchdog = startSweepMetaWatchdog();

      let shuttingDown = false;
      const cleanupSync = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        stopAskSweeper();
        stopStaleAskCloseSweeper();
        stopWakePendingRetentionSweeper();
        stopProdStateSweeper();
        stopShortIdMapSweeper();
        stopAskStateSweeper();
        stopTopologySweeper();
        stopTranscriptWatcher();
        stopTranscriptSweep();
        stopGuardEventsSweep();
        stopInterceptorAggregatesSweeper();
        stopConversationTitleSweeper();
        stopConversationSummarySweeper();
        stopDispatchWatchdogSweeper();
        stopDeploySmokeSweeper();
        stopFollowUpSweeper();
        stopConversationPresenceSweeper();
        stopStdioLogRotationSweeper();
        stopSweepMetaWatchdog();
        // Aborts the in-flight long poll rather than letting shutdown wait it
        // out; null when the channel is disabled or still starting.
        stopPrincipalChannel?.();
        removeCurrentCockpitState();
      };
      const cleanupAndExit = () => {
        cleanupSync();
        server.close(() => process.exit(0));
        // Force-exit if server.close() hangs on long-lived SSE clients.
        setTimeout(() => process.exit(0), 1000).unref();
      };

      // The project's narrowed `process` type omits EventEmitter methods.
      // Cast to a Node-shaped surface for `on` — mirrors `src/mcp/server.ts:1340-1345`.
      // eslint-disable-next-line custom/no-excessive-as-unknown
      const proc = process as unknown as {
        on(
          event: NodeJS.Signals | "exit" | "uncaughtException" | "unhandledRejection",
          listener: (...args: unknown[]) => void
        ): void;
      };
      proc.on("SIGINT", cleanupAndExit);
      proc.on("SIGTERM", cleanupAndExit);
      proc.on("SIGHUP", cleanupAndExit);

      // mt#3973: resident-memory CAPTURE for the cockpit daemon.
      //
      // The 2026-08-08 panic stackshot carries no argv, so "the runaway was an
      // MCP server" is an inference, not an observation (mt#3885). `bun` names
      // at least four process classes on this machine and THIS one — a
      // long-lived daemon — is currently the largest live `bun` on it (1.31 GB
      // measured 2026-08-11, against a 427-644 MB band for `mcp start`).
      // Leaving it uninstrumented would keep the attribution question open
      // exactly where it is most likely to be answered.
      //
      // Capture only, NO self-terminate: mt#3886's ceiling deliberately covers
      // `mcp start` / `mcp proxy`, whose parent restarts them. Killing the
      // cockpit daemon out from under the tray is a different decision with a
      // different blast radius, and it is not this task's to make.
      const { wireMemoryCaptureWatcher } = await import("../../mcp/memory-capture");
      const { getCurrentProcessMemoryBytes, getCurrentProcessUptimeSeconds } = await import(
        "../../mcp/orphan-exit"
      );
      wireMemoryCaptureWatcher({
        processRole: "cockpit start",
        // No self-terminate on this class — say so, rather than inventing a
        // bound the arm-check would then compare against.
        ceilingBytes: Number.POSITIVE_INFINITY,
        // Above the 1.31 GB measured baseline, so this fires on genuine growth
        // rather than on every cockpit start.
        defaultWatermarkMb: 2048,
        getResidentBytes: getCurrentProcessMemoryBytes,
        getUptimeSeconds: getCurrentProcessUptimeSeconds,
      });

      // Synchronous-only path: fires on any non-signal exit (normal exit,
      // process.exit() called elsewhere, event-loop drain). `cleanupSync` uses
      // fs.unlinkSync inside removeCockpitPidFile, which is safe here.
      proc.on("exit", cleanupSync);

      // Uncaught error paths: clean up best-effort, then exit non-zero so the
      // failure isn't silently swallowed. The `exit` listener above fires
      // after process.exit(1) and is the second line of defence.
      //
      // mt#3626: a failed outbound connection attempt inside the RUNTIME's own
      // net module is not a defect in daemon state, so it no longer exits —
      // see `daemon-error-policy.ts` for the classification and why the crash
      // message text is not what it is matched on. The survivable branch must
      // NOT call cleanupSync(): the daemon keeps serving, so its sweepers and
      // its state file have to stay in place.
      const logSurvivedError = createSurvivedErrorLogger((line) => console.error(line));
      proc.on("uncaughtException", (err: unknown) => {
        if (classifyUncaughtException(err) === "survive") {
          logSurvivedError(err);
          return;
        }
        cleanupSync();
        console.error(`Cockpit: uncaught exception: ${formatErrorForLog(err)}`);
        process.exit(1);
      });
      // gh#1761: postgres-js ECIRCUITBREAKER / EDBHANDLEREXITED reach this
      // handler when the Supavisor circuit breaker trips (e.g. after a burst of
      // auth failures). Calling process.exit(1) here crashes the daemon and
      // causes KeepAlive to respawn it, which re-trips the circuit breaker in a
      // tight loop — exactly the 49,650-restart incident.
      //
      // mt#4100 widened this from four client-side codes to the server-side
      // SQLSTATE space as well, and split the response in two: a connection or
      // server that is unusable degrades (as before), while a single cancelled
      // statement is survived without tearing down a healthy pool. See
      // `classifyUnhandledRejection`. Non-DB errors still exit(1).
      proc.on(
        "unhandledRejection",
        createUnhandledRejectionHandler({
          logSurvived: logSurvivedError,
          // stderr, per `UnhandledRejectionEffects.logErrorLine`'s contract.
          logErrorLine: (line) => console.error(line),
          markDegraded: markDbDegraded,
          startRetryBackoff: () => startDbRetryBackoff(),
          cleanup: cleanupSync,
          exit: () => process.exit(1),
        })
      );

      console.log(`Cockpit running at http://localhost:${port}`);
      if (isDev) {
        console.log("Dev mode: Vite HMR active — frontend changes hot-reload in the browser");
        console.log("Tip: run with `bun --watch` for server-side auto-restart:");
        console.log(`  bun --watch run src/cli.ts cockpit start --dev --port ${port}`);
      }
      console.log("Press Ctrl+C to stop");

      if (options.open) {
        openInBrowser(`http://localhost:${port}`);
      }

      // Launch the shared dev chromium for chrome-devtools-mcp attachment
      // (mt#1904). Idempotent — reuses an already-running instance. Best-effort:
      // failures don't block cockpit. Commander negates --no-* flags into
      // `options.devChromium === false`.
      if (options.devChromium !== false) {
        try {
          const devChromium = await ensureDevChromiumRunning();
          if (devChromium) {
            console.log(
              `Dev chromium running at http://127.0.0.1:${devChromium.debuggingPort} ` +
                `(PID ${devChromium.pid}) — attach chrome-devtools-mcp via ` +
                `--browser-url=http://127.0.0.1:${devChromium.debuggingPort}`
            );
          }
        } catch (err) {
          const e = err as Error;
          console.warn(`Warning: dev chromium launch failed: ${e.message}`);
        }
      }

      // Keep the action handler awaiting indefinitely so the top-level CLI
      // doesn't fall through to its `exit(0)` after parseAsync resolves.
      // Mirrors `src/commands/mcp/start-command.ts:1101`.
      await new Promise<never>(() => {});
    });

  return startCommand;
}
