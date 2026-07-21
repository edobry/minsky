/**
 * CopyId — reusable copy-id affordance (mt#2943).
 *
 * Renders an entity id as selectable monospace text plus a small trigger that
 * opens a popover menu with two actions: "Copy ID" (bare id) and "Copy link"
 * (the entity's `minsky://` deeplink, via `entityToMinskyUri`). Generic over
 * `RoutableEntityType` — no per-entity string construction.
 *
 * Established as a shared convention: before this task NO entity detail page
 * had any copy-id affordance (every breadcrumb used the same
 * `font-mono` + `title={id}` + `shortenId()` pattern with no way to copy the
 * full id short of a manual triple-click). This component is the one place
 * that pattern now lives.
 *
 * Copied-state feedback matches the existing clipboard pattern in
 * `ConversationSearchPanel.tsx`'s `CopyResumeButton` (lucide `Copy`→`Check`
 * icon swap + a transient text label for ~2s via local `useState` +
 * `setTimeout`). There is no toast library in this app and none is added
 * here.
 *
 * Long ids (session/ask UUIDs) get their DISPLAY truncated via `shortenId`;
 * both copy actions always operate on the FULL id regardless of display
 * truncation. Short ids (e.g. a task's `mt#2410`) are rendered in full —
 * `truncateAt` only kicks in once `id.length` exceeds it.
 *
 * @see src/cockpit/web/lib/entity-codec.ts — `RoutableEntityType`, `entityToMinskyUri`
 * @see src/cockpit/web/lib/format.ts — `shortenId`
 * @see src/cockpit/web/widgets/ConversationSearchPanel.tsx:124 — copy-feedback style reference
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Check, Link as LinkIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { shortenId } from "../lib/format";
import { entityToMinskyUri, type RoutableEntityType } from "../lib/entity-codec";
import { cn } from "../lib/utils";

export interface CopyIdProps {
  /** The entity type — drives the `minsky://<type>/<id>` deeplink. */
  type: RoutableEntityType;
  /**
   * The canonical entity id — always used to build the "Copy link"
   * `minsky://` deeplink via `entityToMinskyUri`, regardless of `displayId`.
   */
  id: string;
  /**
   * Optional display/primary-copy id (mt#2965), distinct from `id`. When
   * provided, this is what's rendered as text and copied by the "Copy ID"
   * action — e.g. a human-readable short id (`ask#7`) shown in place of the
   * raw uuid `id`. `id` remains the "Copy link" target unconditionally.
   * Defaults to `id` — every caller that only supplies `id` (task, session,
   * memory, changeset) behaves exactly as before this prop was added.
   */
  displayId?: string;
  /**
   * Display-truncation threshold (code points). Ids at or below this length
   * are rendered in full regardless — this only shortens genuinely long ids
   * (session/ask UUIDs), never a short task id like `mt#2410` or `ask#7`.
   */
  truncateAt?: number;
  className?: string;
}

type CopiedKind = "id" | "link" | null;

/** Human label for the trigger's aria-label / title, e.g. "ask id". */
function entityLabel(type: RoutableEntityType): string {
  return `${type} id`;
}

export function CopyId({ type, id, displayId, truncateAt = 8, className }: CopyIdProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<CopiedKind>(null);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending revert timer on unmount so a copy fired shortly before
  // navigating away never calls setState on an unmounted component (PR #2073
  // R1 finding 1).
  useEffect(() => {
    return () => {
      if (revertTimerRef.current !== null) clearTimeout(revertTimerRef.current);
    };
  }, []);

  const shownId = displayId ?? id;
  const displayText = shownId.length > truncateAt ? shortenId(shownId, truncateAt) : shownId;

  const doCopy = useCallback((kind: Exclude<CopiedKind, null>, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      // Clear any timer from a prior copy so rapid re-copies don't stack —
      // only the most recent copy's revert fires.
      if (revertTimerRef.current !== null) clearTimeout(revertTimerRef.current);
      setCopied(kind);
      setOpen(false);
      revertTimerRef.current = setTimeout(() => setCopied(null), 2000);
    });
  }, []);

  const handleCopyId = useCallback(() => doCopy("id", shownId), [doCopy, shownId]);
  const handleCopyLink = useCallback(
    () => doCopy("link", entityToMinskyUri(type, id)),
    [doCopy, type, id]
  );

  const label = entityLabel(type);

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="font-mono text-foreground select-all" title={shownId}>
        {displayText}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Copy ${label}`}
            title={`Copy ${label}`}
            className="inline-flex items-center gap-1 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" />
                <span className="text-[11px]">Copied</span>
              </>
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-36" align="start">
          <button
            type="button"
            onClick={handleCopyId}
            className="w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-left text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Copy className="h-3 w-3" />
            Copy ID
          </button>
          <button
            type="button"
            onClick={handleCopyLink}
            className="w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-left text-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <LinkIcon className="h-3 w-3" />
            Copy link
          </button>
        </PopoverContent>
      </Popover>
    </span>
  );
}
