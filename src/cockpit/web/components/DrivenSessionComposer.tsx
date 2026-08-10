/**
 * DrivenSessionComposer (mt#2751, Rung 2B) — operator input for a driven
 * session. Sends `{"text": ...}` on submit (mt#2750 channel protocol) and
 * `{"type": "stop"}` on the Stop action; composer state reflects the
 * session's `interactionState` (mt#2751 success criterion 3).
 *
 * @see mt#2751 — this component
 * @see ../hooks/useDrivenSession.ts — supplies `interactionState`/`sendText`/`stop`
 * @see ../pages/DrivenSessionPage.tsx — hosts this alongside ConversationView + status
 */
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { DrivenSessionInteractionState } from "../lib/driven-session-accumulator";

export interface DrivenSessionComposerProps {
  interactionState: DrivenSessionInteractionState;
  /**
   * Deliver the operator's text.
   *
   * May return a promise. When it does, the input is cleared only AFTER that
   * promise resolves, and the text is PRESERVED if it rejects — a failed send
   * that also wipes what the operator typed leaves them with no retry path
   * and nothing to retry from (PR #2437 R1 BLOCKING). A caller that returns
   * `void` keeps the original clear-immediately behavior.
   */
  onSend: (text: string) => void | Promise<unknown>;
  /**
   * Stop the in-flight turn. OPTIONAL: when omitted the Stop button is not
   * rendered at all. A host that has nothing to stop — the entity discussion
   * thread (mt#3365), which talks to its agent over REST and has no
   * interrupt channel — would otherwise ship a permanently dead control,
   * which is worse than no control.
   */
  onStop?: () => void;
  className?: string;
  /**
   * Pre-fill the composer input (mt#2986) — e.g. a draft the host wants the
   * operator to review before sending. Seed only: this component never sends
   * on its own. (The task-launch path no longer uses this — it sends its
   * primed command through the channel directly, mt#3375.)
   */
  initialText?: string;
  /**
   * Accessible label for the input. Defaults to the driven-session wording
   * this component was built for; a different host passes its own so a
   * screen reader is not told it is addressing a "driven session" when it is
   * addressing something else (mt#3365).
   */
  ariaLabel?: string;
  /** Placeholder shown when the composer is accepting input. Defaults to the
   * driven-session wording, for the same reason as `ariaLabel`. */
  idlePlaceholder?: string;
}

/**
 * Placeholder per interaction state. `streaming` is NOT a disabled state
 * (mt#3375) — the binary queues a message written mid-turn and runs it as the
 * next turn (probed directly, 2026-07-30), so the placeholder says what will
 * happen rather than refusing the input.
 */
const PLACEHOLDER_BY_STATE: Record<DrivenSessionInteractionState, string> = {
  "awaiting-input": "Send a message…",
  streaming: "Assistant is responding — your message will queue",
  exited: "Session has ended.",
};

export function DrivenSessionComposer({
  interactionState,
  onSend,
  onStop,
  className,
  initialText,
  ariaLabel,
  idlePlaceholder,
}: DrivenSessionComposerProps) {
  const [text, setText] = useState(initialText ?? "");
  const [sending, setSending] = useState(false);
  // Only a terminated session refuses input. While the assistant is streaming
  // the composer stays open and the message queues — the transport has no
  // turn-taking constraint, and the previous whole-turn lockout was a UI
  // restriction with nothing behind it (mt#3375).
  //
  // `sending` still blocks: that is the in-flight guard for an async `onSend`
  // host (mt#3365), preventing a double-submit while delivery is pending. It
  // is about THIS send, not about the assistant's turn.
  const inputDisabled = interactionState === "exited" || sending;
  const canSend = !inputDisabled && text.trim().length > 0;
  const canStop = interactionState !== "exited";
  const placeholder =
    interactionState === "awaiting-input" && idlePlaceholder
      ? idlePlaceholder
      : PLACEHOLDER_BY_STATE[interactionState];

  function submit(): void {
    const trimmed = text.trim();
    if (!trimmed || inputDisabled) return;
    const result = onSend(trimmed);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      // Await the caller's delivery before destroying the operator's draft.
      setSending(true);
      void (result as Promise<unknown>).then(
        () => {
          setSending(false);
          setText("");
        },
        () => {
          // Keep the text exactly as typed: the host surfaces the error, and
          // pressing Send again IS the retry.
          setSending(false);
        }
      );
      return;
    }
    setText("");
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends; Shift+Enter inserts a newline — standard chat-composer convention.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form onSubmit={handleSubmit} className={cn("flex items-end gap-2", className)}>
      <textarea
        // Named so the mt#3737 geometry script can ask about THIS control
        // rather than "the first textarea on the page" — the assertion is
        // whether the operator can still reach the composer, and a broad
        // locator would silently start measuring some other input.
        data-testid="driven-composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={inputDisabled}
        placeholder={placeholder}
        rows={2}
        aria-label={ariaLabel ?? "Message to this session"}
        className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex flex-col gap-1.5">
        <Button type="submit" size="sm" disabled={!canSend}>
          Send
        </Button>
        {onStop ? (
          <Button type="button" size="sm" variant="outline" disabled={!canStop} onClick={onStop}>
            Stop
          </Button>
        ) : null}
      </div>
    </form>
  );
}
