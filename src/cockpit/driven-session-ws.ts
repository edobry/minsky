/**
 * Cockpit driven-session WebSocket channel (mt#2750, Rung 2A).
 *
 * Attaches to the daemon's underlying `http.Server` `"upgrade"` event — WS
 * upgrades are plain HTTP GETs carrying `Connection: Upgrade`, handled by a
 * listener on the raw server, NOT by anything mounted on the Express `app`
 * (Express never sees an upgrade request unless something explicitly wires
 * it in). Gated to `/api/driven-session/:id/ws`.
 *
 * Library choice (mt#2750 spec's "pick one, justify" note): uses the `ws`
 * npm package (already a direct dependency — see package.json) rather than
 * Bun's native `Bun.serve({ websocket })` upgrade path. The cockpit daemon is
 * an Express app bound via `app.listen()` / `http.createServer(app).listen()`
 * (see start-command.ts) — Bun's native WS upgrade is a property of
 * `Bun.serve()`'s own fetch handler and does not compose with an
 * already-created `node:http` `Server`/Express app without restructuring the
 * whole daemon bootstrap onto `Bun.serve()`. `ws`'s `{ noServer: true }` +
 * `server.on("upgrade", ...)` + `wss.handleUpgrade(...)` pattern attaches
 * cleanly to the EXISTING `http.Server`, so the rest of the daemon
 * (Express routes, SSE broker, sweepers) is untouched.
 *
 * Auth (mt#2538 — consumed here, not reinvented): validates the SAME bearer
 * token / `minsky_cockpit` cookie the mutation-auth middleware checks, via
 * the shared `isValidCockpitAuth`/`isHostAllowed` predicates exported from
 * ./auth.ts. An unauthenticated or disallowed-Host upgrade is refused before
 * the WS handshake completes — this channel is remote command execution
 * (operator input is forwarded straight to a genuine `claude` process's
 * stdin), so it gets the same posture as every mutation endpoint.
 *
 * Wired from src/commands/cockpit/start-command.ts — the LOCAL cockpit
 * daemon entrypoint only. Never attached for the Railway `isPublicDeployment`
 * entrypoint (services/cockpit/src/server.ts) — see
 * ./routes/driven-sessions.ts's docblock for why spawning a genuine `claude`
 * binary has no meaning there.
 *
 * @see mt#2750 — this module
 * @see ./driven-session-host.ts — the registry + spawn/parse/input logic this attaches to
 * @see ./auth.ts — mt#2538 auth primitives consumed here
 */
import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import { log } from "@minsky/shared/logger";
import { isHostAllowed, isRequestOriginAllowed, isValidCockpitAuth } from "./auth";
import {
  drivenSessionRegistry,
  sendDrivenSessionInput,
  stopDrivenSession,
  buildReconnectingDrivenSessionRecord,
  type DrivenSessionRecord,
  type DrivenSessionRegistry,
  type DrivenSessionSubscriber,
} from "./driven-session-host";
import { orchestrateDrivenSessionResume } from "./driven-session-launch";

/** Matches `/api/driven-session/<id>/ws` (id is a path segment — no further slashes). */
const WS_PATH_PATTERN = /^\/api\/driven-session\/([^/]+)\/ws$/;

export interface AttachDrivenSessionWebSocketOptions {
  /** The cockpit daemon's bearer token (mt#2538 — same value `getOrCreateCockpitToken()` returns). */
  token: string;
  /** The Host-header allowlist (mt#2538 — same set `buildAllowedHosts(host)` returns). */
  allowedHosts: Set<string>;
  /** Override the registry (tests use a hermetic instance; production uses the shared singleton). */
  registry?: DrivenSessionRegistry;
  /** Override the restart-recovery orchestration (tests avoid a real Postgres round-trip). */
  orchestrateResume?: typeof orchestrateDrivenSessionResume;
}

/**
 * Attach the driven-session WS upgrade handler to `server`. Call ONCE per
 * `http.Server` — production calls this once from start-command.ts right
 * after the bind succeeds; each test constructs its own `http.Server` and
 * calls this once against it.
 *
 * A request whose path does NOT match `/api/driven-session/:id/ws` is left
 * untouched (the listener returns without writing to or destroying the
 * socket) so any OTHER upgrade handler attached to the same server — present
 * or future — still gets a chance to handle it.
 */
export function attachDrivenSessionWebSocket(
  server: Server,
  opts: AttachDrivenSessionWebSocketOptions
): WebSocketServer {
  const registry = opts.registry ?? drivenSessionRegistry;
  const orchestrateResume = opts.orchestrateResume ?? orchestrateDrivenSessionResume;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url ?? "").split("?")[0] ?? "";
    const match = WS_PATH_PATTERN.exec(pathname);
    if (!match) return;

    if (!isHostAllowed(req.headers.host, opts.allowedHosts)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    // Cross-origin defense (mt#2750 R1). The SPA authenticates this upgrade with
    // the `SameSite=Strict` cookie (a browser `WebSocket` cannot set an
    // `Authorization` header), and that cookie IS sent to a same-site
    // DIFFERENT-port origin — so without this check a malicious
    // `http://127.0.0.1:<other>` page could open an authenticated
    // command-execution channel. Enforce the SAME origin check the HTTP mutation
    // path uses (shared `isRequestOriginAllowed`); browsers send `Origin` on WS
    // upgrades, so it is enforceable here. Runs BEFORE the token check so a
    // cross-origin attempt is refused regardless of the cookie it carries.
    if (!isRequestOriginAllowed(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!isValidCockpitAuth(req, opts.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = decodeURIComponent(match[1] ?? "");
    void resolveDrivenSessionForUpgrade(sessionId, registry, orchestrateResume).then(
      (resolution) => {
        if (resolution.kind === "gone") {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        if (resolution.kind === "locked") {
          // Another process is already resuming this conversation (R1 delta
          // #1's cross-process lock lost the race) — a transient condition,
          // NOT "gone forever". 503 + Retry-After tells the client to retry
          // shortly rather than treating this as a dead session.
          socket.write("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wireDrivenSessionSocket(ws, resolution.record);
        });
      }
    );
  });

  return wss;
}

type UpgradeResolution =
  | { kind: "attach"; record: DrivenSessionRecord }
  | { kind: "locked" }
  | { kind: "gone" };

/**
 * Resolve what to attach the incoming WS upgrade to (mt#3038 restart
 * recovery — RFC minimal-first-slice step 3). Three cases:
 *
 *   - The in-memory registry already has a LIVE (non-`"reconnecting"`)
 *     record — the common case, attach directly, no persistence lookup.
 *   - The registry has no record, OR a `"reconnecting"` placeholder loaded
 *     at boot (R1 delta #6) — consult persistence via
 *     `orchestrateDrivenSessionResume`, which acquires the cross-process
 *     resume lock (R1 delta #1) before spawning `claude --resume`.
 *   - The persisted row is `"unrecoverable"` (R1 delta #2 — deleted cwd,
 *     spawn-died-before-init, policy-blocked respawn) — attach anyway so the
 *     client gets the buffered transcript history, but mark/keep the
 *     in-memory record `"unrecoverable"` with its reason instead of ever
 *     spawning; the client (useDrivenSession) renders this read-only, never
 *     the crash card.
 */
async function resolveDrivenSessionForUpgrade(
  sessionId: string,
  registry: DrivenSessionRegistry,
  orchestrateResume: typeof orchestrateDrivenSessionResume = orchestrateDrivenSessionResume
): Promise<UpgradeResolution> {
  const existing = registry.get(sessionId);
  if (existing && existing.status !== "reconnecting") {
    return { kind: "attach", record: existing };
  }

  const outcome = await orchestrateResume(sessionId, { registry });
  switch (outcome.outcome) {
    case "resumed":
      return { kind: "attach", record: outcome.record };
    case "locked":
      return { kind: "locked" };
    case "unrecoverable": {
      // A persisted row genuinely IS unrecoverable — but there may be no
      // in-memory record at all yet (boot reconciliation never loaded this
      // ROW specifically — e.g. persistence was transiently unreachable at
      // boot and recovered by the time this request arrived). Falling
      // through to "gone"/404 here would be exactly the bug this whole
      // mechanism exists to fix: a session that DOES have a durable, known
      // reason gets the generic "may not exist" crash instead of its reason.
      // Construct the placeholder now rather than requiring it to have
      // already existed. `registry.register()` is called ONLY in the
      // freshly-built branch — re-registering an already-registered record
      // is pointless work on the hot path (reviewer round 2, PR #2179).
      const alreadyRegistered = existing ?? registry.get(sessionId);
      if (alreadyRegistered) {
        alreadyRegistered.status = "unrecoverable";
        alreadyRegistered.unrecoverableReason = outcome.reason;
        return { kind: "attach", record: alreadyRegistered };
      }
      const record = buildReconnectingDrivenSessionRecord({
        localId: sessionId,
        harnessSessionId: null,
        cwd: "",
        permissionMode: "default",
        taskId: null,
        minskySessionId: null,
        status: "unrecoverable",
        unrecoverableReason: outcome.reason,
        actuatorGeneration: 0,
        startedAt: new Date().toISOString(),
      });
      registry.register(record);
      return { kind: "attach", record };
    }
    case "not-found":
      return existing ? { kind: "attach", record: existing } : { kind: "gone" };
  }
}

/**
 * Normalize a `ws` "message" event's raw payload (`Buffer | ArrayBuffer |
 * Buffer[]`) to a string. Deliberately avoids `Buffer.concat` / an explicit
 * `.toString(encoding)` argument — this project's root `@types/node` vs.
 * bun-types' bundled copy disagree on the `Buffer` static/instance surface
 * (the same ambient-typing ambiguity documented in ./auth.ts's token-encoding
 * comment and ./driven-session-host.ts's `chunkToString`); `String(chunk)`
 * sidesteps it by invoking a real Buffer's zero-arg `.toString()` (default
 * encoding `"utf8"`) instead.
 */
function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return data.map((item) => rawDataToString(item)).join("");
  return String(data);
}

/**
 * Wire a newly-upgraded WS connection to `record`: replay the buffered event
 * log (which may already include the `init` event and any turns that raced
 * ahead of the client's connect), stream new events as they arrive, and
 * forward client frames to the child's stdin as operator input.
 *
 * Client frame shapes accepted:
 *   - `{"text": "<message>"}` — the documented shape.
 *   - Any other valid JSON, or plain non-JSON text — forwarded as best-effort
 *     raw text input (defensive; mirrors the "tolerate unknown event types"
 *     posture on the outbound side).
 *   - `{"type": "stop"}` — graceful stop (closes stdin / SIGTERM fallback).
 */
function wireDrivenSessionSocket(ws: WebSocket, record: DrivenSessionRecord): void {
  for (const event of record.eventLog) {
    ws.send(JSON.stringify(event.payload));
  }

  // mt#3038 R1 delta #2 — a synthetic terminal frame (namespaced like the
  // host's own minsky_exit/minsky_error) so the client can render the
  // read-only unrecoverable state instead of a generic crash card. Sent
  // AFTER the (possibly empty, in-process-memory-only) eventLog replay —
  // full on-disk transcript replay for an unrecoverable session is a known
  // gap, not attempted here (see the PR body).
  if (record.status === "unrecoverable") {
    ws.send(
      JSON.stringify({
        type: "minsky_unrecoverable",
        reason: record.unrecoverableReason ?? "Session unrecoverable",
      })
    );
  }

  const subscriber: DrivenSessionSubscriber = {
    onEvent: (event) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(event.payload));
      }
    },
    // mt#3038 R1 delta #3 — an actuator swap replaced this record; force the
    // client to redial the SAME localId (never hot-swap a live socket onto
    // the new record). Close code 4001 is this channel's private
    // reconnect-signal (the 4000-4999 range is reserved for
    // application-defined codes per RFC 6455 §7.4.2); the client hook keys
    // off it to distinguish "please reconnect immediately" from an ordinary
    // close/error, which it treats as session-ended.
    onSwap: () => {
      try {
        ws.close(4001, "actuator-swap-reconnect");
      } catch {
        // Best-effort — the socket may already be closing.
      }
    },
  };
  record.subscribers.add(subscriber);

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    const text = rawDataToString(data);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      sendDrivenSessionInput(record, text);
      return;
    }

    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (obj["type"] === "stop") {
        stopDrivenSession(record);
        return;
      }
      if (typeof obj["text"] === "string") {
        sendDrivenSessionInput(record, obj["text"]);
        return;
      }
    }
    // Unrecognized JSON shape — forward the raw text as best-effort input.
    sendDrivenSessionInput(record, text);
  });

  ws.on("close", () => {
    record.subscribers.delete(subscriber);
  });

  // Defense-in-depth: also unsubscribe on "error" (not just "close"). The
  // `ws` package always follows a socket error with a close event in
  // practice, so this is normally redundant with the handler above — but
  // `Set.delete` on an already-removed entry is a harmless no-op, and this
  // removes any dependency on that ordering guarantee holding across every
  // runtime/transport this channel might ever run over.
  ws.on("error", (err: Error) => {
    record.subscribers.delete(subscriber);
    log.error(`[driven-session-ws] socket error for ${record.localId}: ${err.message}`);
  });
}
