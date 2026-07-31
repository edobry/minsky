/**
 * iTerm-tab correlator (mt#1628 — iTerm-tab binding v0).
 *
 * Correlates Minsky sessions to live iTerm2 tabs and persists the result as
 * each session's `interfaceBinding`.
 *
 * ## Where the candidate signal comes from
 *
 * Rather than re-deriving "which terminal is this session running in" from
 * scratch (cwd-prefix heuristics, tab-name matching, tty→pid cross-checks —
 * all of which the original task spec sketched), this correlator reuses the
 * session-grain runtime-attachment substrate mt#2284/mt#2285 already ship:
 *
 * - `listLiveSessionAttachments()` (`../session/attachment.ts`) returns, per
 *   session, the pid-liveness-confirmed `terminalContext` env bag the
 *   session's own process self-registered at startup — including
 *   `TERM_PROGRAM` and, for iTerm2, `TERM_SESSION_ID` (iTerm2's own stable
 *   per-tab identifier, e.g. `w0t0p0:5B3F...`).
 * - The mt#2285 focus-adapter registry already keys its iTerm2 activation
 *   AppleScript off exactly this `TERM_SESSION_ID` (`../session/focus/adapters.ts`,
 *   `iterm2FocusAdapter.matches`/`focus`) — i.e. `TERM_SESSION_ID` is already
 *   proven, in this codebase, to be the correct iTerm2-native tab identity.
 *
 * So the correlator's job narrows to exactly the piece that self-registration
 * cannot provide: whether that candidate iTerm tab is STILL open right now.
 * A session's process can outlive the tab it started in (operator closes the
 * tab; the agent process, orphaned, keeps running) — this correlator's live
 * `osascript` enumeration is what tells `iterm-tab` (confirmed still open)
 * apart from `unbound` (candidate signal present, but the tab is gone).
 *
 * ## Persistence
 *
 * See the Design Decision note in `../session/types.ts` above the
 * `SessionRecord.interfaceBinding` field, and
 * `docs/architecture/interface-binding-surface-kinds.md`.
 */
import type { CommandExecutor, CommandExecResult } from "../session/focus/types";
import {
  defaultCommandExecutor,
  isAppleScriptPermissionError,
  appleScriptPermissionMessage,
} from "../session/focus/executor";
import type { SessionAttachment } from "../session/attachment";
import type { PresenceClaimRepository } from "../presence/index";
import { isLocalItermCorrelationSupported } from "./deployment-mode";
import type { InterfaceBinding } from "./types";

/**
 * AppleScript that walks every iTerm2 window/tab/session and emits each
 * session's `id` (== `TERM_SESSION_ID`), one per line. Mirrors the loop
 * shape and escaping discipline established by
 * `../session/focus/adapters.ts`'s `buildITerm2ActivateScript` — this is
 * the read-only enumeration counterpart to that write-only activation
 * script; no session/tab/window is mutated.
 */
const ENUMERATE_ITERM_SESSIONS_SCRIPT = [
  "set idList to {}",
  'tell application "iTerm2"',
  "  repeat with w in windows",
  "    repeat with t in tabs of w",
  "      repeat with s in sessions of t",
  "        set end of idList to (id of s)",
  "      end repeat",
  "    end repeat",
  "  end repeat",
  "end tell",
  "set AppleScript's text item delimiters to linefeed",
  "return idList as text",
].join("\n");

export interface ItermEnumerationResult {
  /** Live iTerm2 `TERM_SESSION_ID`-shaped ids, one per currently-open session/tab. */
  ids: Set<string>;
  /** Set when enumeration failed (permission denied, iTerm2 not running/found, etc.). */
  error?: string;
}

/**
 * Enumerate every currently-open iTerm2 session id via `osascript`. Never
 * throws — a failure (permission denied, `osascript` missing, iTerm2 not
 * running) is reported via `error` so callers can distinguish "genuinely no
 * tabs open" (empty `ids`, no `error`) from "could not check" (`error` set).
 */
export async function listLiveItermSessionIds(
  executor: CommandExecutor
): Promise<ItermEnumerationResult> {
  const result: CommandExecResult = await executor([
    "osascript",
    "-e",
    ENUMERATE_ITERM_SESSIONS_SCRIPT,
  ]);

  if (result.exitCode !== 0) {
    if (isAppleScriptPermissionError(result)) {
      return { ids: new Set(), error: appleScriptPermissionMessage("iTerm2") };
    }
    // iTerm2 not running is not an error worth surfacing distinctly here —
    // AppleScript's `tell application "iTerm2"` launches it if not running,
    // so a non-zero exit at this point is a genuine failure (permission,
    // missing osascript, etc.), reported via the generic branch below.
    const detail = result.spawnError
      ? `osascript could not be started: ${result.stderr.trim() || "unknown error"}`
      : result.stderr.trim() || "osascript enumeration failed";
    return { ids: new Set(), error: detail };
  }

  const ids = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { ids: new Set(ids) };
}

/**
 * Pure classification: given one session's live terminal-context attachment
 * and the currently-open iTerm2 session-id set, decide the v0 surface kind.
 *
 * `unbound` covers BOTH "this session isn't attached to iTerm2 at all" (no
 * `TERM_PROGRAM`/`TERM_SESSION_ID` in the attachment) AND "it was, but the
 * tab is now closed" (candidate id present, not in `liveSessionIds`) — v0
 * deliberately does not distinguish these (that's the stale-but-bound vs
 * stale-and-unbound matrix mt#1506 owns; see this task's "Out of scope").
 */
export function classifyAttachment(
  attachment: Pick<SessionAttachment, "terminalContext">,
  liveSessionIds: ReadonlySet<string>,
  observedAt: string = new Date().toISOString()
): InterfaceBinding {
  const termProgram = attachment.terminalContext?.TERM_PROGRAM;
  const termSessionId = attachment.terminalContext?.TERM_SESSION_ID;

  if (termProgram === "iTerm.app" && termSessionId && liveSessionIds.has(termSessionId)) {
    return { kind: "iterm-tab", surfaceId: termSessionId, lastObservedAt: observedAt };
  }
  return { kind: "unbound", lastObservedAt: observedAt };
}

/** Minimal session-provider seam the correlator needs (avoids depending on the full interface). */
export interface CorrelatorSessionProvider {
  updateSession(sessionId: string, updates: { interfaceBinding: InterfaceBinding }): Promise<void>;
}

export interface RunItermCorrelationPassDeps {
  sessionProvider: CorrelatorSessionProvider;
  presenceRepo: PresenceClaimRepository;
  /** Injected for tests; defaults to the real `osascript`-spawning executor. */
  executor?: CommandExecutor;
  /** Test seam for the deployment-mode gate; production never passes this. */
  platformOverride?: string;
}

export interface RunItermCorrelationPassResult {
  /** False when the deployment-mode gate skipped the pass entirely (no osascript call made). */
  ran: boolean;
  /** Set when `ran` is false (gate skip), or when enumeration failed mid-pass. */
  skippedReason?: string;
  updated: Array<{ sessionId: string; binding: InterfaceBinding }>;
}

/**
 * Run one correlation pass: for every session with a live (pid-confirmed)
 * runtime attachment, classify and persist its `interfaceBinding`.
 *
 * Gate ordering matters for the "hosted-Minsky sessions report `unbound`
 * without invoking osascript" acceptance test: `isLocalItermCorrelationSupported`
 * is checked FIRST, before any DB read or `osascript` call.
 *
 * On an enumeration failure (permission denied, osascript unavailable), NO
 * bindings are written this pass — writing `unbound` everywhere on a failed
 * check would silently overwrite a possibly-still-accurate prior
 * observation with a false negative. The failure is reported via
 * `skippedReason` instead.
 */
export async function runItermCorrelationPass(
  deps: RunItermCorrelationPassDeps
): Promise<RunItermCorrelationPassResult> {
  if (!isLocalItermCorrelationSupported(deps.platformOverride)) {
    return {
      ran: false,
      skippedReason: "not a local macOS Minsky deployment",
      updated: [],
    };
  }

  const { listLiveSessionAttachments } = await import("../session/attachment");
  const attachments = await listLiveSessionAttachments(deps.presenceRepo);

  const executor = deps.executor ?? defaultCommandExecutor;
  const enumeration = await listLiveItermSessionIds(executor);
  if (enumeration.error) {
    return { ran: true, skippedReason: enumeration.error, updated: [] };
  }

  const now = new Date().toISOString();
  const updated: Array<{ sessionId: string; binding: InterfaceBinding }> = [];

  for (const attachment of attachments) {
    const binding = classifyAttachment(attachment, enumeration.ids, now);
    await deps.sessionProvider.updateSession(attachment.sessionId, { interfaceBinding: binding });
    updated.push({ sessionId: attachment.sessionId, binding });
  }

  return { ran: true, updated };
}
