/**
 * Focus-adapter registry + orchestration (mt#2285).
 */
import { defaultCommandExecutor } from "./executor";
import {
  iterm2FocusAdapter,
  kittyFocusAdapter,
  terminalAppFocusAdapter,
  tmuxFocusAdapter,
  weztermFocusAdapter,
  wmRaiseFocusAdapter,
} from "./adapters";
import type { CommandExecutor, FocusAdapter, FocusAdapterContext, FocusOutcomeKind } from "./types";

/**
 * Ordered adapter registry. Order matters: earlier entries are preferred
 * when multiple signals are present -- e.g. tmux running inside iTerm2 sets
 * BOTH TMUX_PANE and TERM_PROGRAM=iTerm.app; the tmux pane is the more
 * precise target and needs no GUI permission, so it is tried first. wm-raise
 * is last: it matches on the weakest signal (TERM_PROGRAM present, nothing
 * more specific) and is the degraded fallback for every other case.
 *
 * Adding a new emulator means adding a new adapter to this array -- never a
 * change to the command layer (spec's design constraint).
 */
export const FOCUS_ADAPTER_REGISTRY: FocusAdapter[] = [
  tmuxFocusAdapter,
  weztermFocusAdapter,
  kittyFocusAdapter,
  iterm2FocusAdapter,
  terminalAppFocusAdapter,
  wmRaiseFocusAdapter,
];

/** Find the first matching adapter for the given context, or undefined if none matches. */
export function resolveFocusAdapter(
  ctx: FocusAdapterContext,
  registry: FocusAdapter[] = FOCUS_ADAPTER_REGISTRY
): FocusAdapter | undefined {
  return registry.find((adapter) => adapter.matches(ctx));
}

export interface FocusAttachmentOptions {
  executor?: CommandExecutor;
  registry?: FocusAdapter[];
}

export type FocusAttemptResultKind = FocusOutcomeKind | "no-signal";

export interface FocusAttemptResult {
  kind: FocusAttemptResultKind;
  message: string;
  adapter?: string;
}

/** Minimal attachment shape this module needs -- avoids a circular import on the full SessionAttachment type. */
export interface FocusableAttachment {
  terminalContext?: Record<string, string>;
  pid?: number;
  tty?: string;
}

function buildNoSignalMessage(attachment: FocusableAttachment): string {
  const parts: string[] = [];
  if (attachment.pid) parts.push(`pid ${attachment.pid}`);
  if (attachment.tty) parts.push(`tty ${attachment.tty}`);
  const handle = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return (
    `No known focus mechanism for this attachment's terminal context${handle}. Recognized ` +
    "signals (TMUX_PANE, WEZTERM_PANE, KITTY_WINDOW_ID, TERM_PROGRAM) were not present -- " +
    "navigate to it manually using the handle above."
  );
}

/**
 * Attempt to focus ONE resolved attachment. Ambiguity handling across
 * multiple attachments is the caller's job (the command layer), matching the
 * mt#2284 attachment-set semantics named in the spec's success criteria --
 * this function always focuses exactly the attachment it is given, and never
 * silently no-ops: every path returns an actionable message.
 */
export async function focusAttachment(
  attachment: FocusableAttachment,
  options: FocusAttachmentOptions = {}
): Promise<FocusAttemptResult> {
  const executor = options.executor ?? defaultCommandExecutor;
  const registry = options.registry ?? FOCUS_ADAPTER_REGISTRY;

  const ctx: FocusAdapterContext = {
    terminalContext: attachment.terminalContext ?? {},
    pid: attachment.pid,
    tty: attachment.tty,
  };

  const adapter = resolveFocusAdapter(ctx, registry);
  if (!adapter) {
    return { kind: "no-signal", message: buildNoSignalMessage(attachment) };
  }

  const outcome = await adapter.focus(ctx, executor);
  return { kind: outcome.kind, message: outcome.message, adapter: outcome.adapter };
}
