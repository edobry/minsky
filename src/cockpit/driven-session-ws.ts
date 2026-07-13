/**
 * Cockpit driven-session WebSocket channel (mt#2750, Rung 2A).
 *
 * Attaches to the daemon's underlying `http.Server` `"upgrade"` event — WS
 * upgrades are plain HTTP GETs carrying `Connection: Upgrade`, handled by a
 * listener on the raw server, NOT by anything mounted on the Express `app`
 * (Express never sees an upgrade request unless something explicitly wires
 * it in). Gated to `/api/driven-session/:id/ws`.
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
import { isHostAllowed, isValidCockpitAuth } from "./auth";
import {
  drivenSessionRegistry,
  sendDrivenSessionInput,
  stopDrivenSession,
  type DrivenSessionRecord,
  type DrivenSessionRegistry,
} from "./driven-session-host";

/** Matches `/api/driven-session/<id>/ws` (id is a path segment — no further slashes). */
const WS_PATH_PATTERN = /^\/api\/driven-session\/([^/]+)\/ws$/;

export interface AttachDrivenSessionWebSocketOptions {
  /** The cockpit daemon's bearer token (mt#2538 — same value `getOrCreateCockpitToken()` returns). */
  token: string;
  /** The Host-header allowlist (mt#2538 — same set `buildAllowedHosts(host)` returns). */
  allowedHosts: Set<string>;
  /** Override the registry (tests use a hermetic instance; production uses the shared singleton). */
  registry?: DrivenSessionRegistry;
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

    if (!isValidCockpitAuth(req, opts.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = decodeURIComponent(match[1] ?? "");
    const record = registry.get(sessionId);
    if (!record) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wireDrivenSessionSocket(ws, record);
    });
  });

  return wss;
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

  const subscriber = (event: { payload: Record<string, unknown> }): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event.payload));
    }
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

  ws.on("error", (err: Error) => {
    log.error(`[driven-session-ws] socket error for ${record.localId}: ${err.message}`);
  });
}
