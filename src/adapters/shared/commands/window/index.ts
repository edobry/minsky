/**
 * Window CLI commands — mt#1489.
 *
 * Surfaces the attention-window primitive (mt#1411 ADR) as four shared
 * commands that are registered in the shared command registry:
 *
 *   window.list    — show configured windows + current state
 *   window.open    — explicitly open a window; fires NOTIFY event
 *   window.close   — explicitly close a window; fires NOTIFY event
 *   window.status  — show currently-open window(s)
 *
 * Commands are v0 file-backed: no DB `attention_windows` table exists yet.
 * Window "open" state is tracked in-process via the `OpenWindowRegistry`
 * singleton. Postgres NOTIFY events are emitted so Cockpit (mt#1147) and
 * the reaper (mt#1490) can subscribe via LISTEN.
 *
 * Cron integration: `window.open` is the target that cron scheduling
 * eventually calls (see `shouldWindowFireNow` in cron.ts). The actual
 * `setInterval` / startup wiring lives in the CLI entry point and calls
 * the `checkAndFireCronWindows` helper exported from this file.
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../../command-registry";
import { log } from "../../../../utils/logger";
import {
  loadAttentionWindowsOrThrow,
  loadAttentionWindows,
  type LoaderFs,
} from "../../../../domain/ask/attention-windows/loader";
import { shouldWindowFireNow, nextCronFire } from "../../../../domain/ask/attention-windows/cron";
import {
  createPostgresWindowNotifier,
  type WindowNotifier,
  type WindowOpenedPayload,
  type WindowClosedPayload,
} from "../../../../domain/ask/attention-windows/notify";
import type { AttentionWindowConfig } from "../../../../domain/ask/attention-windows/config";
import type { AppContainerInterface } from "../../../../composition/types";

// ---------------------------------------------------------------------------
// In-process open-window registry (v0; no DB table)
// ---------------------------------------------------------------------------

export interface OpenWindowState {
  windowKey: string;
  openedAt: Date;
  durationMin: number;
  expectedCloseAt: Date;
}

/**
 * In-process registry of currently-open attention windows.
 *
 * v0 is per-process: windows survive only as long as the process that opened
 * them. v1 will persist this in the DB. The `window.status` and
 * `window.list` commands read from this registry to show live state.
 */
export class OpenWindowRegistry {
  private readonly open = new Map<string, OpenWindowState>();

  isOpen(windowKey: string): boolean {
    return this.open.has(windowKey);
  }

  getOpen(windowKey: string): OpenWindowState | undefined {
    return this.open.get(windowKey);
  }

  getAllOpen(): OpenWindowState[] {
    return Array.from(this.open.values());
  }

  openWindow(state: OpenWindowState): void {
    this.open.set(state.windowKey, state);
  }

  closeWindow(windowKey: string): boolean {
    return this.open.delete(windowKey);
  }
}

/** Module-level singleton — shared across command registrations. */
const globalRegistry = new OpenWindowRegistry();

/** Exported for tests that need to inspect or reset state. */
export { globalRegistry };

// ---------------------------------------------------------------------------
// Core domain logic (exported for testing)
// ---------------------------------------------------------------------------

export interface OpenWindowResult {
  windowKey: string;
  openedAt: string;
  durationMin: number;
  expectedCloseAt: string;
  alreadyOpen: boolean;
}

export interface CloseWindowResult {
  windowKey: string;
  closedAt: string;
  wasOpen: boolean;
}

/**
 * Open a named window.
 *
 * Idempotent: if the window is already open, returns `alreadyOpen: true`
 * without emitting a second NOTIFY.
 */
export async function openWindow(
  windowKey: string,
  windows: AttentionWindowConfig[],
  notifier: WindowNotifier,
  registry: OpenWindowRegistry = globalRegistry
): Promise<OpenWindowResult> {
  const config = windows.find((w) => w.key === windowKey);
  if (!config) {
    throw new Error(
      `window.open: unknown window key "${windowKey}". ` +
        `Available keys: ${windows.map((w) => w.key).join(", ")}`
    );
  }

  // Idempotent: if already open, return current state without re-notifying
  if (registry.isOpen(windowKey)) {
    const current = registry.getOpen(windowKey);
    if (!current) {
      // Should never happen: isOpen returned true but getOpen returned undefined.
      // Treat as closed so we fall through to the open path below.
    } else {
      return {
        windowKey,
        openedAt: current.openedAt.toISOString(),
        durationMin: current.durationMin,
        expectedCloseAt: current.expectedCloseAt.toISOString(),
        alreadyOpen: true,
      };
    }
  }

  const openedAt = new Date();
  const expectedCloseAt = new Date(openedAt.getTime() + config.durationMin * 60_000);

  registry.openWindow({ windowKey, openedAt, durationMin: config.durationMin, expectedCloseAt });

  const payload: WindowOpenedPayload = {
    windowKey,
    openedAt: openedAt.toISOString(),
    durationMin: config.durationMin,
    expectedCloseAt: expectedCloseAt.toISOString(),
  };
  await notifier.notifyOpened(payload);

  log.info(`window.open: "${windowKey}" opened until ${expectedCloseAt.toISOString()}`);

  return {
    windowKey,
    openedAt: openedAt.toISOString(),
    durationMin: config.durationMin,
    expectedCloseAt: expectedCloseAt.toISOString(),
    alreadyOpen: false,
  };
}

/**
 * Close a named window early.
 *
 * Idempotent: if the window is not open, returns `wasOpen: false` without
 * emitting a NOTIFY.
 */
export async function closeWindow(
  windowKey: string,
  windows: AttentionWindowConfig[],
  notifier: WindowNotifier,
  registry: OpenWindowRegistry = globalRegistry
): Promise<CloseWindowResult> {
  // Validate the key exists in config (even if window is not currently open)
  const config = windows.find((w) => w.key === windowKey);
  if (!config) {
    throw new Error(
      `window.close: unknown window key "${windowKey}". ` +
        `Available keys: ${windows.map((w) => w.key).join(", ")}`
    );
  }

  const wasOpen = registry.isOpen(windowKey);
  const closedAt = new Date();
  registry.closeWindow(windowKey);

  if (wasOpen) {
    const payload: WindowClosedPayload = {
      windowKey,
      closedAt: closedAt.toISOString(),
    };
    await notifier.notifyClosed(payload);
    log.info(`window.close: "${windowKey}" closed`);
  }

  return { windowKey, closedAt: closedAt.toISOString(), wasOpen };
}

// ---------------------------------------------------------------------------
// Cron fire helper (called from CLI entry point)
// ---------------------------------------------------------------------------

/**
 * Check all configured windows against the current time and open any whose
 * cron schedule fires.
 *
 * Call this from the CLI startup's `setInterval(..., 60_000)` tick to
 * implement the cron-daemon integration without a separate process.
 *
 * `lastFiredAt` is a per-window map of last auto-open timestamps. The caller
 * maintains this map between ticks to prevent duplicate firings.
 *
 * @param loaderFs Optional filesystem interface for loading the config.
 *   Defaults to real `fs`. Override in tests to provide in-memory config.
 */
export async function checkAndFireCronWindows(
  notifier: WindowNotifier,
  registry: OpenWindowRegistry = globalRegistry,
  lastFiredAt: Map<string, Date> = new Map(),
  now: Date = new Date(),
  loaderFs?: LoaderFs
): Promise<string[]> {
  const result = loadAttentionWindows(loaderFs);
  if (!result.ok) {
    log.warn("window cron: config errors, skipping tick", {
      errors: result.errors.map((e) => e.message),
    });
    return [];
  }

  const fired: string[] = [];
  for (const w of result.windows) {
    if (shouldWindowFireNow(w.schedule, now, lastFiredAt.get(w.key))) {
      lastFiredAt.set(w.key, now);
      await openWindow(w.key, result.windows, notifier, registry);
      fired.push(w.key);
    }
  }
  return fired;
}

// ---------------------------------------------------------------------------
// Command result types
// ---------------------------------------------------------------------------

export interface WindowListEntry {
  key: string;
  schedule: string;
  durationMin: number;
  maxMisses: number;
  description?: string;
  state: "open" | "closed";
  openedAt?: string;
  expectedCloseAt?: string;
  nextOpenAt?: string | null;
}

export interface WindowListResult {
  windows: WindowListEntry[];
  total: number;
}

export interface WindowStatusResult {
  openWindows: OpenWindowState[];
  count: number;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the window commands in the shared command registry.
 *
 * @param container Optional DI container — when provided, NOTIFY events are
 *   emitted via the real Postgres connection; otherwise they are no-ops.
 * @param notifierOverride For testing: inject a stub notifier directly.
 */
export function registerWindowCommands(
  container?: AppContainerInterface,
  notifierOverride?: WindowNotifier
): void {
  // -------------------------------------------------------------------------
  // window.list
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "window.list",
      category: CommandCategory.TOOLS,
      name: "list",
      description:
        "List all configured attention windows with their state (open/closed) and next scheduled open time",
      requiresSetup: false,
      parameters: {},
      execute: async (): Promise<WindowListResult> => {
        const windows = loadAttentionWindowsOrThrow();
        const now = new Date();

        const entries: WindowListEntry[] = windows.map((w) => {
          const openState = globalRegistry.getOpen(w.key);
          const isOpen = !!openState;

          let scheduleStr: string;
          let nextOpenAt: string | null | undefined;

          if (w.schedule.type === "manual") {
            scheduleStr = "manual";
            nextOpenAt = null;
          } else {
            scheduleStr = w.schedule.expr;
            const next = nextCronFire(w.schedule.expr, now);
            nextOpenAt = next ? next.toISOString() : null;
          }

          const entry: WindowListEntry = {
            key: w.key,
            schedule: scheduleStr,
            durationMin: w.durationMin,
            maxMisses: w.maxMisses,
            description: w.description,
            state: isOpen ? "open" : "closed",
            nextOpenAt,
          };

          if (isOpen && openState) {
            entry.openedAt = openState.openedAt.toISOString();
            entry.expectedCloseAt = openState.expectedCloseAt.toISOString();
          }

          return entry;
        });

        return { windows: entries, total: entries.length };
      },
    })
  );

  // -------------------------------------------------------------------------
  // window.open
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "window.open",
      category: CommandCategory.TOOLS,
      name: "open",
      description: "Explicitly open a named attention window. Emits a Postgres NOTIFY event.",
      requiresSetup: false,
      parameters: {
        key: {
          schema: z.string().min(1),
          description: "Window key (e.g. ask-hours, weekly-review)",
          required: true,
        },
      },
      execute: async (params, ctx): Promise<OpenWindowResult> => {
        const notifier =
          notifierOverride ?? createPostgresWindowNotifier(ctx.container ?? container);
        const windows = loadAttentionWindowsOrThrow();
        return openWindow(params.key, windows, notifier);
      },
    })
  );

  // -------------------------------------------------------------------------
  // window.close
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "window.close",
      category: CommandCategory.TOOLS,
      name: "close",
      description: "Explicitly close a named attention window. Emits a Postgres NOTIFY event.",
      requiresSetup: false,
      parameters: {
        key: {
          schema: z.string().min(1),
          description: "Window key to close (e.g. ask-hours)",
          required: true,
        },
      },
      execute: async (params, ctx): Promise<CloseWindowResult> => {
        const notifier =
          notifierOverride ?? createPostgresWindowNotifier(ctx.container ?? container);
        const windows = loadAttentionWindowsOrThrow();
        return closeWindow(params.key, windows, notifier);
      },
    })
  );

  // -------------------------------------------------------------------------
  // window.status
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "window.status",
      category: CommandCategory.TOOLS,
      name: "status",
      description: "Show currently-open attention windows with one-line summary per window",
      requiresSetup: false,
      parameters: {},
      execute: async (): Promise<WindowStatusResult> => {
        const openWindows = globalRegistry.getAllOpen();
        return { openWindows, count: openWindows.length };
      },
    })
  );
}
