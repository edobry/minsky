/**
 * Window CLI commands — mt#1489, mt#1491.
 *
 * Surfaces the attention-window primitive (mt#1411 ADR) as five shared
 * commands that are registered in the shared command registry:
 *
 *   window.list    — show configured windows + current state
 *   window.open    — explicitly open a window; fires NOTIFY event
 *   window.close   — explicitly close a window; fires NOTIFY event
 *   window.status  — show currently-open window(s) with pending count
 *   window.service — load cohort for a window, render digest, accept responses
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
import { createInterface as createReadlineInterface } from "node:readline";
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
import type { Ask } from "../../../../domain/ask/types";
import type { AskRepository } from "../../../../domain/ask/repository";
import { pendingAsksForWindow } from "../../../../domain/ask/pending-asks-for-window";
import { buildAskRepository } from "../asks";

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
  /** Per-window pending ask counts (only present for open windows). */
  pendingByWindow?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// window.service — types and domain logic (mt#1491)
// ---------------------------------------------------------------------------

/** Result returned by `serviceWindow` / the `window.service` command. */
export interface WindowServiceResult {
  windowKey: string;
  responded: number;
  skipped: number;
  remaining: number;
}

/**
 * Stdin reader interface — injectable for tests.
 *
 * The default implementation wraps `process.stdin`. Tests inject a fake that
 * returns a predetermined sequence of lines.
 */
export interface StdinReader {
  readLine(): Promise<string | null>;
}

/**
 * Parse an operator response token from the service loop.
 *
 * Accepted formats:
 *   `<N><letter>` — respond to ask N with the option identified by letter
 *                   (A = first option, B = second, …)
 *   `skip <N>`    — defer ask N without responding
 *   `done`        — exit the service loop early
 *
 * Returns `null` if the input does not match any recognised pattern.
 */
export type ServiceCommand =
  | { type: "respond"; index: number; optionLetter: string }
  | { type: "skip"; index: number }
  | { type: "done" };

export function parseServiceCommand(raw: string): ServiceCommand | null {
  const trimmed = raw.trim().toLowerCase();

  if (trimmed === "done") {
    return { type: "done" };
  }

  const skipMatch = /^skip\s+(\d+)$/.exec(trimmed);
  if (skipMatch) {
    const idx = parseInt(skipMatch[1] ?? "0", 10);
    return { type: "skip", index: idx };
  }

  // `<N><letter>` — e.g. "1a", "2B", "3c"
  const respondMatch = /^(\d+)([a-z])$/.exec(trimmed);
  if (respondMatch) {
    const idx = parseInt(respondMatch[1] ?? "0", 10);
    const letter = (respondMatch[2] ?? "a").toUpperCase();
    return { type: "respond", index: idx, optionLetter: letter };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Render helpers — plain text + ANSI; no Markdown or extra dependencies.
// ---------------------------------------------------------------------------

const SEPARATOR = "─".repeat(42); // box-drawing horizontal line

/**
 * Render a single-line option entry.
 *
 * Format: `A) <label> [— description]`
 *
 * The first option in a `direction.decide` Ask is conventionally the
 * recommended option and is marked with `(recommended)` in the label if
 * the label or description does not already say so. This satisfies the
 * humility checklist item: "make a recommendation."
 */
function renderOption(
  letter: string,
  label: string,
  description?: string,
  isFirst?: boolean
): string {
  const rec = isFirst && !label.toLowerCase().includes("recommended") ? " (recommended)" : "";
  const base = `    ${letter}) ${label}${rec}`;
  return description ? `${base} — ${description}` : base;
}

/**
 * Render per-Ask kind-appropriate affordances.
 *
 * Satisfies the humility 5-item checklist at the per-Ask level:
 *   1. Question (Q:)
 *   2. Options inline (A), B), …)
 *   3. Drivers (from contextRefs labels / metadata.drivers)
 *   4. Recommendation marker (first option marked recommended)
 *   5. What-not-needed (shown as "Context not needed: …" when metadata present)
 */
export function renderAsk(index: number, ask: Ask): string {
  const lines: string[] = [];

  // Header: index, kind, created time, estimated cost
  const createdTime = new Date(ask.createdAt).toTimeString().slice(0, 5);
  const costLabel =
    ask.kind === "direction.decide" || ask.kind === "authorization.approve" ? "medium" : "quick";
  lines.push(`[${index}] ${ask.kind} · created ${createdTime} · ${costLabel}`);

  // 1. Question
  lines.push(`    Q: ${ask.question}`);

  // 2. Options inline (for decision-like kinds)
  if (ask.options && ask.options.length > 0) {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    ask.options.forEach((opt, i) => {
      const letter = letters[i] ?? String(i + 1);
      const isFirst = i === 0;
      const label = String(opt.label);
      const description = opt.description;
      lines.push(renderOption(letter, label, description, isFirst));
    });
  } else if (ask.kind === "authorization.approve") {
    lines.push("    A) Approve");
    lines.push("    B) Deny");
  } else if (ask.kind === "quality.review") {
    lines.push("    A) Approve");
    lines.push("    B) Request changes");
  }

  // 3. Drivers — extracted from contextRefs descriptions
  const drivers: string[] = [];
  if (ask.contextRefs && ask.contextRefs.length > 0) {
    drivers.push(
      ...ask.contextRefs.filter((r) => r.description).map((r) => r.description as string)
    );
  }
  if (ask.metadata?.["drivers"] && Array.isArray(ask.metadata["drivers"])) {
    drivers.push(...(ask.metadata["drivers"] as string[]));
  }
  if (drivers.length > 0) {
    lines.push(`    Drivers: ${drivers.join(", ")}`);
  }

  // 5. What not needed — items the responder does not need to consider
  if (ask.metadata?.["notNeeded"]) {
    lines.push(`    Not needed: ${String(ask.metadata["notNeeded"])}`);
  }

  // Reply affordance line
  if (ask.options && ask.options.length > 0) {
    const letters = ask.options
      .map((_, i) => `${i + 1}${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[i] ?? String(i + 1)}`)
      .join(" | ");
    lines.push(`    Reply: ${letters} | skip ${index} | done`);
  } else if (ask.kind === "authorization.approve") {
    lines.push(`    Reply: ${index}A (approve) | ${index}B (deny) | skip ${index} | done`);
  } else if (ask.kind === "quality.review") {
    lines.push(`    Reply: ${index}A (approve) | ${index}B (changes) | skip ${index} | done`);
  } else {
    lines.push(`    Reply: ${index}A | skip ${index} | done`);
  }

  return lines.join("\n");
}

/**
 * Render the full cohort digest.
 *
 * Layout:
 *   <window-title> (<N> pending)
 *   ────────────────────────────
 *   ## <task-id> (<task-title>) — <N> decisions
 *   [1] ... (first ask)
 *   [2] ... (second ask)
 *   ...
 *   Window closes <time> · respond [N | NA | skip N | done]
 */
export function renderCohortDigest(
  windowKey: string,
  asks: Ask[],
  openState?: OpenWindowState,
  now: Date = new Date()
): string {
  if (asks.length === 0) {
    return `No pending asks for window "${windowKey}".`;
  }

  const lines: string[] = [];

  // Header
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 5);
  lines.push(`${windowKey} — ${dateStr} ${timeStr} (${asks.length} pending)`);
  lines.push(SEPARATOR);
  lines.push("");

  // Group by parentTaskId
  const byTask = new Map<string, Ask[]>();
  for (const ask of asks) {
    const taskId = ask.parentTaskId ?? "(no task)";
    const group = byTask.get(taskId) ?? [];
    group.push(ask);
    byTask.set(taskId, group);
  }

  let globalIndex = 1;
  for (const [taskId, taskAsks] of byTask) {
    const countLabel = taskAsks.length === 1 ? "1 decision" : `${taskAsks.length} decisions`;
    lines.push(`## ${taskId} — ${countLabel}`);
    lines.push("");
    for (const ask of taskAsks) {
      lines.push(renderAsk(globalIndex, ask));
      lines.push("");
      globalIndex++;
    }
  }

  // Footer
  if (openState) {
    const closeTime = openState.expectedCloseAt.toTimeString().slice(0, 5);
    lines.push(`Window closes ${closeTime} · respond [N | NA | NB | skip N | done]`);
  } else {
    lines.push(`respond [N | NA | NB | skip N | done]`);
  }

  return lines.join("\n");
}

/**
 * Core domain function for the window.service command.
 *
 * Loads the pending-ask cohort for `windowKey`, renders the digest, reads
 * operator commands line-by-line, and propagates responses to Ask state
 * via `repo.respondAndClose`.
 *
 * Returns a structured result with counts of responded / skipped / remaining.
 *
 * @param repo           Ask repository (injectable — real or fake for tests).
 * @param windowKey      The window key to service.
 * @param stdinReader    Line-based stdin reader (injectable for tests).
 * @param outputWriter   Stdout writer function (injectable for tests).
 * @param nowMs          Current timestamp (injectable for tests).
 * @param loadCohort     Cohort loader (injectable for tests; defaults to pendingAsksForWindow).
 * @param openState      The open-window registry state (optional; used for close-time display).
 */
export async function serviceWindow(
  repo: AskRepository,
  windowKey: string,
  stdinReader: StdinReader,
  outputWriter: (text: string) => void,
  nowMs: number = Date.now(),
  loadCohort: (
    repo: AskRepository,
    windowKey: string,
    nowMs: number
  ) => Promise<Ask[]> = pendingAsksForWindow,
  openState?: OpenWindowState
): Promise<WindowServiceResult> {
  const asks = await loadCohort(repo, windowKey, nowMs);

  if (asks.length === 0) {
    outputWriter(`No pending asks for window "${windowKey}".`);
    return { windowKey, responded: 0, skipped: 0, remaining: 0 };
  }

  const digest = renderCohortDigest(windowKey, asks, openState, new Date(nowMs));
  outputWriter(digest);

  // Track which asks have been handled (responded or skipped) in this session.
  const handledSet = new Set<number>(); // 1-based indices

  let responded = 0;
  let skipped = 0;

  // Service loop
  while (handledSet.size < asks.length) {
    const raw = await stdinReader.readLine();
    if (raw === null) {
      // EOF — treat as "done"
      break;
    }

    const cmd = parseServiceCommand(raw);
    if (cmd === null) {
      outputWriter(`Unrecognised input: "${raw.trim()}". Use N<letter> | skip N | done`);
      continue;
    }

    if (cmd.type === "done") {
      break;
    }

    if (cmd.type === "skip") {
      const idx = cmd.index;
      if (idx < 1 || idx > asks.length) {
        outputWriter(`Index ${idx} out of range (1–${asks.length}).`);
        continue;
      }
      if (handledSet.has(idx)) {
        outputWriter(`Ask ${idx} already handled.`);
        continue;
      }
      handledSet.add(idx);
      skipped++;
      outputWriter(`Ask ${idx} deferred.`);
      continue;
    }

    // cmd.type === "respond"
    const idx = cmd.index;
    if (idx < 1 || idx > asks.length) {
      outputWriter(`Index ${idx} out of range (1–${asks.length}).`);
      continue;
    }
    if (handledSet.has(idx)) {
      outputWriter(`Ask ${idx} already handled.`);
      continue;
    }

    const ask = asks[idx - 1];
    if (!ask) {
      outputWriter(`Internal error: ask ${idx} not found.`);
      continue;
    }

    // Map letter to option value (A = index 0, B = index 1, …)
    const letterIndex = cmd.optionLetter.charCodeAt(0) - "A".charCodeAt(0);
    let payloadValue: unknown;

    if (ask.options && ask.options.length > 0) {
      const option = ask.options[letterIndex];
      if (!option) {
        outputWriter(
          `Option ${cmd.optionLetter} is out of range for ask ${idx} ` +
            `(valid: A–${"ABCDEFGHIJKLMNOPQRSTUVWXYZ"[ask.options.length - 1] ?? "?"}).`
        );
        continue;
      }
      payloadValue = { option: String(option.value), chosen: String(option.value) };
    } else if (ask.kind === "authorization.approve") {
      payloadValue = { approved: cmd.optionLetter === "A" };
    } else if (ask.kind === "quality.review") {
      payloadValue = { approved: cmd.optionLetter === "A" };
    } else {
      payloadValue = { option: cmd.optionLetter };
    }

    const respondPayload = {
      responder: "operator" as const,
      payload: payloadValue as Record<string, unknown>,
    };
    const closePayload = {
      responder: "operator" as const,
      payload: payloadValue as Record<string, unknown>,
      attentionCost: {
        transport: "inbox" as const,
        resolvedIn: "inbox" as const,
      },
    };

    try {
      await repo.respondAndClose(ask.id, { response: respondPayload }, { response: closePayload });
      handledSet.add(idx);
      responded++;
      outputWriter(`Ask ${idx} responded (${cmd.optionLetter}).`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputWriter(`Error responding to ask ${idx}: ${msg}`);
    }
  }

  const remaining = asks.length - responded - skipped;
  return { windowKey, responded, skipped, remaining };
}

// ---------------------------------------------------------------------------
// Default stdin reader (process.stdin)
// ---------------------------------------------------------------------------

/**
 * Build a `StdinReader` that reads one line at a time from `process.stdin`.
 *
 * Uses `node:readline` createInterface, which handles line buffering and
 * EOF detection without needing the AsyncIterable cast that lints would
 * flag as a risky `as unknown` assertion.
 */
export function makeProcessStdinReader(): StdinReader {
  const lineQueue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  let rl: ReturnType<typeof createReadlineInterface> | null = null;

  function ensureReader() {
    if (rl) return;
    rl = createReadlineInterface(process.stdin as NodeJS.ReadableStream);
    rl.on("line", (line: string) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        lineQueue.push(line);
      }
    });
    rl.on("close", () => {
      closed = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w(null);
      }
    });
  }

  return {
    async readLine(): Promise<string | null> {
      if (lineQueue.length > 0) {
        return lineQueue.shift() ?? null;
      }
      if (closed) return null;
      ensureReader();
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
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

        // Compute pending Ask counts per open window when a repository is available.
        let pendingByWindow: Record<string, number> | undefined;
        const repo = await buildAskRepository(container);
        if (repo && openWindows.length > 0) {
          const nowMs = Date.now();
          pendingByWindow = {};
          await Promise.all(
            openWindows.map(async (w) => {
              const asks = await pendingAsksForWindow(repo, w.windowKey, nowMs);
              if (pendingByWindow) {
                pendingByWindow[w.windowKey] = asks.length;
              }
            })
          );
        }

        return { openWindows, count: openWindows.length, pendingByWindow };
      },
    })
  );

  // -------------------------------------------------------------------------
  // window.service
  // -------------------------------------------------------------------------
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "window.service",
      category: CommandCategory.TOOLS,
      name: "service",
      description:
        "Load the pending-ask cohort for a window, render a terminal digest, and accept operator responses",
      requiresSetup: false,
      parameters: {
        key: {
          schema: z.string().min(1),
          description: "Window key to service (e.g. ask-hours)",
          required: true,
        },
      },
      execute: async (params): Promise<WindowServiceResult> => {
        const repo = await buildAskRepository(container);
        if (!repo) {
          throw new Error(
            "window.service: AskRepository unavailable — persistence provider does not support SQL"
          );
        }

        const windowKey = params.key as string;
        const openState = globalRegistry.getOpen(windowKey);

        // Default stdin reader — reads one line at a time from process.stdin.
        // Bun's process.stdin is an AsyncIterable<Buffer>; we read chunks and
        // return the first complete line (up to the first newline).
        const stdinReader: StdinReader = makeProcessStdinReader();

        return serviceWindow(
          repo,
          windowKey,
          stdinReader,
          (text) => {
            process.stdout.write(`${text}\n`);
          },
          Date.now(),
          pendingAsksForWindow,
          openState ?? undefined
        );
      },
    })
  );
}
