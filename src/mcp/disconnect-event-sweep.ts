/**
 * mcp.disconnect system-event bridge (mt#2537).
 *
 * The MCP disconnect-tracker (`disconnect-tracker.ts`) persists disconnect
 * events as append-only JSONL to `<state-dir>/mcp-disconnect-log.json` — it
 * does NOT write to the `system_events` table directly. This module bridges
 * that JSONL log into `system_events` as `mcp.disconnect` rows so the
 * cockpit activity feed and the Phase 2 attention noticer see them.
 *
 * Invocation path: fire-and-forget, triggered once at MCP-server boot from
 * `src/commands/mcp/start-command.ts`, mirroring the `startup-transcript-
 * ingest.ts` (mt#2051) and `startup-embedding-sweep.ts` boot-sweep pattern.
 * Never blocks server startup; failures are logged and swallowed.
 *
 * Dedup: HWM-gated by disconnect-event `timestamp`, persisted to
 * `<state-dir>/mcp-disconnect-sweep-hwm.json`. The MCP server restarts
 * frequently (see CLAUDE.md's disconnect-cadence rule — harness-driven
 * cycling is routine), so without a HWM every boot would re-emit the entire
 * log's history as duplicate `mcp.disconnect` rows.
 *
 * Filesystem access is injected via `DisconnectSweepFsDeps` (mirroring the
 * `readHostCap` injectable-`readFile` pattern in `.claude/hooks/types.ts`)
 * so tests exercise an in-memory fake instead of real `fs`/tmpdir, per the
 * repo's `custom/no-real-fs-in-tests` ESLint rule.
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "@minsky/shared/logger";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import { getDisconnectLogPath } from "./disconnect-tracker";

interface HwmState {
  lastSweptTimestamp: string;
}

interface DisconnectLogLine {
  timestamp: string;
  serverName: string;
  kind: string;
  cause: string;
  uptimeMs?: number;
  processRole?: string;
}

/** Injectable filesystem surface — production default wraps real `node:fs`. */
export interface DisconnectSweepFsDeps {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, content: string) => void;
  mkdirSync: (p: string) => void;
}

export const defaultFsDeps: DisconnectSweepFsDeps = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p) => fs.readFileSync(p, { encoding: "utf-8" }) as string,
  writeFileSync: (p, content) => fs.writeFileSync(p, content, { encoding: "utf-8" }),
  mkdirSync: (p) => fs.mkdirSync(p, { recursive: true }),
};

function getHwmPath(): string {
  return path.join(path.dirname(getDisconnectLogPath()), "mcp-disconnect-sweep-hwm.json");
}

function readHwm(deps: DisconnectSweepFsDeps): string | null {
  try {
    const raw = deps.readFileSync(getHwmPath());
    const parsed = JSON.parse(raw) as Partial<HwmState>;
    return typeof parsed.lastSweptTimestamp === "string" ? parsed.lastSweptTimestamp : null;
  } catch {
    return null; // absent/malformed HWM file — sweep from the beginning of the log
  }
}

function writeHwm(timestamp: string, deps: DisconnectSweepFsDeps): void {
  try {
    const dir = path.dirname(getHwmPath());
    if (!deps.existsSync(dir)) deps.mkdirSync(dir);
    deps.writeFileSync(getHwmPath(), JSON.stringify({ lastSweptTimestamp: timestamp } as HwmState));
  } catch (err) {
    log.warn("mcp-disconnect-sweep: failed to persist HWM (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Parse the disconnect-tracker's JSONL log and return `disconnect`-kind
 * lines strictly newer than `hwm` (or all `disconnect` lines when `hwm` is
 * null). Tolerates the legacy mt#1645 leading `[...]` array block the same
 * way `DisconnectTracker.loadFromDisk` does — malformed/bracket-residue
 * lines are skipped rather than failing the whole sweep. Pure function — no
 * filesystem access, so it needs no injected deps.
 *
 * HWM comparison (`candidate.timestamp <= hwm`) is a plain string comparison,
 * which is only chronologically correct because `disconnect-tracker.ts`
 * always writes `timestamp` via `new Date().toISOString()` — a fixed-width,
 * always-UTC, millisecond-precision ISO-8601 string. Lexicographic and
 * chronological ordering coincide for that exact format. If a producer ever
 * writes a differently-formatted timestamp (different precision, a numeric
 * offset instead of "Z", etc.) into this log, this comparison would silently
 * misorder — there is no format validation here beyond `typeof === "string"`.
 */
export function parseNewDisconnectEvents(raw: string, hwm: string | null): DisconnectLogLine[] {
  const events: DisconnectLogLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("]")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed line
    }
    if (!parsed || typeof parsed !== "object") continue;
    const candidate = parsed as Partial<DisconnectLogLine>;
    if (
      candidate.kind !== "disconnect" ||
      typeof candidate.timestamp !== "string" ||
      typeof candidate.serverName !== "string" ||
      typeof candidate.cause !== "string"
    ) {
      continue;
    }
    if (hwm && candidate.timestamp <= hwm) continue;
    events.push(candidate as DisconnectLogLine);
  }
  return events;
}

/**
 * Sweep the disconnect-tracker JSONL log and emit `mcp.disconnect` system
 * events (best-effort) for every disconnect recorded since the last
 * successful sweep.
 *
 * @param persistenceProvider - The persistence provider from the DI container.
 * @param fsDeps - Injectable filesystem surface; defaults to real `node:fs`.
 *   Tests pass an in-memory fake (per `custom/no-real-fs-in-tests`).
 */
export async function triggerMcpDisconnectEventSweep(
  persistenceProvider: BasePersistenceProvider,
  fsDeps: DisconnectSweepFsDeps = defaultFsDeps
): Promise<void> {
  try {
    if (!persistenceProvider.capabilities.sql) return;

    const getDb = (persistenceProvider as { getDatabaseConnection?: () => Promise<unknown> })
      .getDatabaseConnection;
    if (typeof getDb !== "function") return;

    const db = await getDb.call(persistenceProvider);
    if (!db) return;

    const logPath = getDisconnectLogPath();
    if (!fsDeps.existsSync(logPath)) return;

    const raw = fsDeps.readFileSync(logPath);
    const hwm = readHwm(fsDeps);
    const newEvents = parseNewDisconnectEvents(raw, hwm);
    if (newEvents.length === 0) return;

    const { DrizzleEventEmitter } = await import("@minsky/domain/events/emitter");
    const emitter = new DrizzleEventEmitter(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase
    );

    let maxTimestamp = hwm ?? "";
    for (const event of newEvents) {
      await emitter.emit({
        eventType: "mcp.disconnect",
        payload: {
          cause: event.cause,
          serverName: event.serverName,
          uptimeMs: event.uptimeMs,
          processRole: event.processRole,
        },
      });
      if (event.timestamp > maxTimestamp) maxTimestamp = event.timestamp;
    }

    if (maxTimestamp) writeHwm(maxTimestamp, fsDeps);

    log.debug("mcp-disconnect-sweep: emitted mcp.disconnect events", {
      count: newEvents.length,
    });
  } catch (err) {
    // Best-effort: a failed sweep must never affect MCP server boot.
    log.warn("mcp-disconnect-sweep: sweep failed (best-effort, swallowed)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
