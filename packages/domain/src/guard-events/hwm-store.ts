/**
 * Per-stream high-water-mark cursor store for the guard/calibration exhaust
 * ingest (mt#4035, mt#3334 phase 3).
 *
 * ## Cursor store choice: state-dir JSON file, not the DB
 *
 * Precedent: `~/.local/state/minsky/mcp-disconnect-sweep-hwm.json`
 * (`src/mcp/disconnect-event-sweep.ts`) — a single JSON object, overwritten
 * in place, keyed by the thing being watermarked. This ingest follows the
 * same shape: ONE file, `guard-events-sweep-hwm.json`, keyed by stream name,
 * rather than a DB table or column. Reasons: (1) the cursor is a pure LATENCY
 * optimization, never a correctness dependency — every stream's dedupe key is
 * a function of stream+content, so a lost, stale, or hand-deleted cursor file
 * only costs a slower next sweep (full re-scan, safe per constraint #5),
 * never a wrong result; (2) a state-dir file is one `fs` read + one `fs`
 * write per sweep tick for all ~40 streams combined, versus either 40 tiny
 * DB round trips or a single multi-row upsert that still costs a DB
 * connection the sweep doesn't otherwise need on its fast path (the
 * dedupe-key insert is the only DB write this ingest requires); (3) it keeps
 * the ingest runnable (in a degraded, "did nothing new" sense) even when the
 * DB is briefly unreachable, since reading/advancing the cursor doesn't
 * require a live connection. The tradeoff this accepts: the cursor is
 * per-machine (a laptop's state dir), which is already this whole corpus's
 * documented property (SC4 — see `docs/architecture/evaluation-loop-fire-log.md`).
 *
 * Filesystem access is injected (`HwmStoreFsDeps`) so tests exercise an
 * in-memory fake instead of real `fs`/tmpdir, per `custom/no-real-fs-in-tests`.
 */

/** One stream's persisted cursor. Exactly one of the two fields is meaningful, per format. */
export interface GuardEventsHwmEntry {
  /** JSONL streams: bytes already consumed from the start of the file. */
  byteOffset?: number;
  /** json-array streams: array elements already consumed (mcp-disconnect-log.json). */
  elementCount?: number;
}

export type GuardEventsHwmState = Record<string, GuardEventsHwmEntry>;

export interface HwmStoreFsDeps {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, content: string) => void;
  mkdirSync: (p: string) => void;
}

/**
 * Parse a raw HWM file's content into state. Malformed or absent content
 * resolves to an empty state (every stream sweeps from its start) rather
 * than throwing — matching the mcp-disconnect-sweep-hwm.json precedent's
 * `readHwm` behavior.
 */
export function parseHwmState(raw: string | null): GuardEventsHwmState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as GuardEventsHwmState;
  } catch {
    return {};
  }
}

export function serializeHwmState(state: GuardEventsHwmState): string {
  return JSON.stringify(state);
}

export const HWM_STATE_FILENAME = "guard-events-sweep-hwm.json";

export function readHwmState(path: string, deps: HwmStoreFsDeps): GuardEventsHwmState {
  if (!deps.existsSync(path)) return {};
  try {
    return parseHwmState(deps.readFileSync(path));
  } catch {
    return {};
  }
}

/**
 * Persist state. Best-effort by design — a write failure is swallowed by the
 * CALLER (this function itself throws normally; `ingest-service.ts` wraps
 * the call and logs rather than crashing the sweep, matching the
 * disconnect-sweep precedent's `writeHwm`).
 */
export function writeHwmState(
  path: string,
  state: GuardEventsHwmState,
  deps: HwmStoreFsDeps
): void {
  const dir = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
  if (dir) deps.mkdirSync(dir);
  deps.writeFileSync(path, serializeHwmState(state));
}
