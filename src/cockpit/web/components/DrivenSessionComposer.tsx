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
  onSend: (text: string) => void;
  onStop: () => void;
  className?: string;
}

const PLACEHOLDER_BY_STATE: Record<DrivenSessionInteractionState, string> = {
  "awaiting-input": "Send a message…",
  streaming: "Assistant is responding…",
  exited: "Session has ended.",
};

export function DrivenSessionComposer({
  interactionState,
  onSend,
  onStop,
  className,
}: DrivenSessionComposerProps) {
  const [text, setText] = useState("");
  const inputDisabled = interactionState !== "awaiting-input";
  const canSend = !inputDisabled && text.trim().length > 0;
  const canStop = interactionState !== "exited";

  function submit(): void {
    const trimmed = text.trim();
    if (!trimmed || inputDisabled) return;
    onSend(trimmed);
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
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={inputDisabled}
        placeholder={PLACEHOLDER_BY_STATE[interactionState]}
        rows={2}
        aria-label="Message to the driven session"
        className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex flex-col gap-1.5">
        <Button type="submit" size="sm" disabled={!canSend}>
          Send
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!canStop} onClick={onStop}>
          Stop
        </Button>
      </div>
    </form>
  );
}
