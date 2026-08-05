/**
 * Inline rewind markers for superseded operator prompts (mt#3323 / PR #2449 R1).
 *
 * Extracted verbatim from `../widgets/ConversationView.tsx`, which had grown past
 * the 1500-line hard limit — the same reason mt#3262 moved the per-element
 * renderers into `ConversationElementRenderers.tsx`. Behavior is unchanged; this
 * is a move, not a rewrite.
 */
import { useState } from "react";
import { snapshotBlocksToConversation } from "@minsky/domain/transcripts/conversation-elements";
import type { ConversationElement } from "@minsky/domain/transcripts/conversation-elements";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

export interface SupersededPrompt {
  /** The abandoned block's id — a stable React key. */
  blockId: string;
  /** The prompt as the operator originally typed it. */
  text: string;
}

/**
 * A run of superseded prompts, positioned by the live block that replaced them.
 *
 * `anchorIndex` is an index into `allBlocks`, not into the rendered turns: the
 * turn stream is filtered and windowed downstream, so an index into it would
 * not survive. Every downstream stage preserves ORDER, which is all the render
 * needs to interleave markers back into position.
 */
export interface SupersededGroup {
  anchorIndex: number;
  prompts: SupersededPrompt[];
}

/**
 * A marker's React identity.
 *
 * Keyed on the first abandoned prompt's block id, NOT on `anchorIndex`: the
 * index is positional and shifts whenever `allBlocks` changes shape — a
 * re-fetched snapshot carrying earlier blocks, or live-tail appends ahead of a
 * trailing group. A shifting key remounts the marker and silently discards the
 * operator's expanded state, which is the one thing they opened it to read
 * (PR #2449 R1). Block ids are stable per session.
 */
export function supersededMarkerKey(group: SupersededGroup): string {
  return `superseded-${group.prompts[0]?.blockId ?? `anchor-${group.anchorIndex}`}`;
}

/** The prompt's text, recovered by running the abandoned block through the same
 * block→turn transform the live blocks take. */
export function supersededPromptText(block: SessionContextSnapshotBlock): string {
  const elements = snapshotBlocksToConversation([block])[0]?.elements ?? [];
  return elements
    .filter((e): e is Extract<ConversationElement, { kind: "text" }> => e.kind === "text")
    .map((e) => e.text.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/**
 * An inline marker for a rewind, at the point in the thread where it happened.
 *
 * mt#3323 shipped this as one global tally at the top of the view, which
 * reports that a rewind occurred but not WHERE — in the originating
 * conversation the two rewinds are ~700 turns apart and the view said "2".
 *
 * Collapsed by default: a superseded prompt is not part of the conversation the
 * agent had, so it must not compete with real turns. Expandable because the
 * abandoned draft is sometimes the one worth reading — in the originating
 * incident it read BETTER than the live version, which the dictation pipeline
 * had mangled (mem#759).
 */
export function SupersededPromptMarker({ prompts }: { prompts: SupersededPrompt[] }) {
  const [open, setOpen] = useState(false);
  const count =
    prompts.length === 1 ? "1 superseded message" : `${prompts.length} superseded messages`;

  return (
    <div data-testid="superseded-prompt-marker" className="flex flex-col gap-1 py-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 self-start text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        <span aria-hidden className="text-[9px]">
          {open ? "▼" : "▶"}
        </span>
        <span>
          {count} — the operator rewrote {prompts.length === 1 ? "this prompt" : "these prompts"};
          the agent never received {prompts.length === 1 ? "it" : "them"}.
        </span>
      </button>
      {open && (
        <div
          data-testid="superseded-prompt-text"
          className="ml-3 flex flex-col gap-2 border-l-2 border-dashed border-border pl-3"
        >
          {/* Labeled on the content itself, not only on the toggle: an expanded
              block scrolled away from its own marker must still say what it is. */}
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
            superseded — the agent never received this
          </p>
          {prompts.map((p) => (
            <p key={p.blockId} className="whitespace-pre-wrap text-xs italic text-muted-foreground/80">
              {p.text.length > 0 ? p.text : "(no text recorded for this prompt)"}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
