#!/usr/bin/env bun
/**
 * The half-open freeze-proxy (mem#838), extracted from
 * `scripts/verify-close-terminates-wedged-pool.ts` (mt#4515) so that mt#4547's
 * server-side measurement can reuse it rather than carry a second copy.
 *
 * WHAT IT DOES. A local TCP proxy sits in front of the real pooler. Once
 * `freeze()` is called it stops forwarding bytes in BOTH directions but keeps
 * every socket open and never propagates a close. That is exactly the half-open
 * shape — the peer is gone, the socket is not — so every in-flight query's
 * promise is left permanently unsettled.
 *
 * TWO GOTCHAS, both from mem#838, kept because they are not obvious and the
 * proxy silently misbehaves without them. They are the reason this is one
 * shared module instead of two copies: a fix to either must not land in only
 * one caller.
 *
 *   1. Forward per-chunk with explicit listeners, NOT `pipe()`. Attaching a
 *      `data` listener before piping consumes and DROPS the early bytes,
 *      including postgres's startup message.
 *   2. `net.connect({ family: 4 })`. The pooler hostname resolves to several
 *      mixed-family addresses and Bun's multi-address connect path is defective
 *      (oven-sh/bun#25633, mt#3534).
 *
 * THE FREEZE IS ONE-DIRECTIONAL BY DESIGN (mt#4547). While frozen, `drop()`
 * removes a closed CLIENT socket from its set but does NOT destroy the paired
 * UPSTREAM socket — so a client-side close cannot reach the pooler. That is
 * faithful to production half-open, where the network path is dead and our
 * close never arrives; it is also why a frozen run can only ever exhibit the
 * non-propagating case. A caller measuring the propagating case must leave the
 * proxy UNFROZEN.
 *
 * The proxy itself is the client-socket counter — no `lsof` needed.
 */
import { createServer, connect, type Server, type Socket } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface FreezeProxy {
  /** Loopback port the proxy is listening on. */
  readonly port: number;
  /** Client sockets currently held (the number mt#4515 and mt#4547 both count). */
  clientSocketCount(): number;
  /** Upstream sockets to the real pooler currently held. */
  upstreamSocketCount(): number;
  frozen(): boolean;
  /** Stop forwarding bytes and stop propagating closes, keeping sockets open. */
  freeze(): void;
  /** Resume forwarding and close-propagation. */
  unfreeze(): void;
  /** Unfreeze, destroy every socket on both sides, then stop listening. */
  close(): Promise<void>;
}

/**
 * Read Minsky's configured Postgres connection string.
 *
 * Returns `null` when nothing is configured, so callers can SKIP (exit 0)
 * rather than fail. Never printed by this module — it carries a password.
 */
export async function readPoolerConnectionString(): Promise<string | null> {
  try {
    const raw = await readFile(join(homedir(), ".config/minsky/config.yaml"), "utf8");
    const cfg = parseYaml(raw) as {
      persistence?: { postgres?: { connectionString?: unknown } };
    } | null;
    const conn = cfg?.persistence?.postgres?.connectionString;
    return typeof conn === "string" && conn.trim() ? conn.trim() : null;
  } catch {
    return null;
  }
}

/** Split a Postgres connection string into the upstream host and port. */
export function upstreamTargetOf(connectionString: string): { host: string; port: number } {
  const parsed = new URL(connectionString.replace(/^postgres(ql)?:/, "http:"));
  return { host: parsed.hostname, port: Number(parsed.port || 6543) };
}

/**
 * Build the loopback connection string that points a client at the proxy,
 * preserving credentials and database from the original.
 */
export function proxyConnectionString(connectionString: string, proxyPort: number): string {
  const viaProxy = new URL(connectionString);
  viaProxy.hostname = "127.0.0.1";
  viaProxy.port = String(proxyPort);
  return viaProxy.toString();
}

/** Start a freeze-proxy in front of `upstream`, listening on an ephemeral port. */
export async function startFreezeProxy(upstream: {
  host: string;
  port: number;
}): Promise<FreezeProxy> {
  let frozen = false;
  const clientSockets = new Set<Socket>();
  const upstreamSockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    clientSockets.add(client);
    // Gotcha 2: pin to IPv4 — Bun's multi-address connect path is defective.
    const upstreamSocket = connect({ host: upstream.host, port: upstream.port, family: 4 });
    upstreamSockets.add(upstreamSocket);

    // Gotcha 1: explicit per-chunk forwarding. While frozen, bytes are dropped
    // rather than forwarded and no close is propagated — the half-open shape.
    client.on("data", (chunk) => {
      if (!frozen) upstreamSocket.write(chunk);
    });
    upstreamSocket.on("data", (chunk) => {
      if (!frozen) client.write(chunk);
    });

    const drop = (s: Socket, set: Set<Socket>) => {
      set.delete(s);
      if (!frozen) {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
      }
    };
    client.on("close", () => drop(client, clientSockets));
    upstreamSocket.on("close", () => drop(upstreamSocket, upstreamSockets));
    client.on("error", () => drop(client, clientSockets));
    upstreamSocket.on("error", () => drop(upstreamSocket, upstreamSockets));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    clientSocketCount: () => clientSockets.size,
    upstreamSocketCount: () => upstreamSockets.size,
    frozen: () => frozen,
    freeze: () => {
      frozen = true;
    },
    unfreeze: () => {
      frozen = false;
    },
    close: async () => {
      frozen = false;
      for (const s of [...clientSockets, ...upstreamSockets]) {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
