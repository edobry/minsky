/**
 * Focus-adapter domain module index (mt#2285).
 */
export type {
  CommandExecResult,
  CommandExecutor,
  FocusAdapter,
  FocusAdapterContext,
  FocusOutcome,
  FocusOutcomeKind,
} from "./types";

export {
  defaultCommandExecutor,
  isAppleScriptPermissionError,
  appleScriptPermissionMessage,
} from "./executor";

export {
  tmuxFocusAdapter,
  weztermFocusAdapter,
  kittyFocusAdapter,
  iterm2FocusAdapter,
  terminalAppFocusAdapter,
  wmRaiseFocusAdapter,
  resolveAppNameForTermProgram,
} from "./adapters";

export { FOCUS_ADAPTER_REGISTRY, resolveFocusAdapter, focusAttachment } from "./registry";
export type {
  FocusAttachmentOptions,
  FocusAttemptResult,
  FocusAttemptResultKind,
  FocusableAttachment,
} from "./registry";
