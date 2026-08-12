/**
 * The publish confirmation for a conversation share link (mt#4024).
 *
 * This dialog is a CONTROL, not a courtesy. The scrub gate the server enforces
 * matches credential PATTERNS; it does nothing about PII, file contents,
 * customer data, or anything else sensitive-but-unpatterned that an agent read
 * into a transcript — the categories ADR-025 names as the reason the transcript
 * archive bucket must stay private, and the class mt#3850 records live secrets
 * reaching transcripts through. So an operator is put in the loop before
 * anything becomes world-readable, and is shown WHAT becomes readable rather
 * than asked to remember.
 *
 * That is also what the vendor-canonical pattern does: Cursor's shared
 * transcripts state that redaction is best-effort and "not guaranteed," and
 * recommend reviewing a transcript before sharing.
 *
 * The exposure summary reads the snapshot the conversation view already has in
 * cache (same query key), so opening this dialog costs no extra request.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ConversationId } from "@minsky/domain/ids";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { fetchSnapshot, snapshotQueryKey, snapshotRetry } from "../lib/conversation-snapshot";
import { buildConversationThread, prepareThreadTurns } from "../lib/conversation-thread-model";
import { formatDatedRange } from "../lib/conversation-timeline";
import {
  absoluteShareUrl,
  MintError,
  mintShare,
  sharesQueryKey,
  type MintedShare,
} from "../lib/shares-client";
import type { SessionContextSnapshot } from "@minsky/domain/context/types";

/** What the operator is told is about to become readable. */
interface Exposure {
  turnCount: number;
  range: string | null;
}

export function PublishConversationDialog({
  conversationId,
  conversationLabel,
  open,
  onOpenChange,
}: {
  conversationId: string;
  /** The conversation's own label — the share's default name. */
  conversationLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [minted, setMinted] = useState<MintedShare | null>(null);
  const [copied, setCopied] = useState(false);

  // Same key as ConversationView's own snapshot query, so this is a cache read
  // whenever the operator is looking at the conversation they are publishing.
  const snapshotQuery = useQuery<SessionContextSnapshot, Error>({
    queryKey: snapshotQueryKey(conversationId as ConversationId),
    queryFn: () => fetchSnapshot(conversationId as ConversationId),
    enabled: open,
    retry: snapshotRetry,
    staleTime: 30_000,
  });

  const exposure = useMemo<Exposure | null>(() => {
    const blocks = snapshotQuery.data?.blocks;
    if (!blocks) return null;
    // The SAME preparation the share page renders from, so the count the
    // operator authorizes is the count the reader sees. Counting the raw
    // visible turns instead reported 5 against a page that showed 4 — the
    // tool-result turn is merged into the call above it — which is a control
    // saying something untrue about what it is asking permission for.
    const turns = prepareThreadTurns(buildConversationThread(blocks));
    return {
      turnCount: turns.length,
      range: formatDatedRange(turns[0]?.timestamp, turns[turns.length - 1]?.timestamp),
    };
  }, [snapshotQuery.data]);

  const mint = useMutation<MintedShare, Error>({
    mutationFn: () => mintShare({ conversationId, label: conversationLabel }),
    onSuccess: (share) => {
      setMinted(share);
      void queryClient.invalidateQueries({ queryKey: sharesQueryKey });
    },
  });

  /** The snapshot read settled and produced nothing to show. */
  const exposureUnavailable = !snapshotQuery.isPending && exposure === null;

  const close = (next: boolean) => {
    if (!next) {
      setMinted(null);
      setCopied(false);
      mint.reset();
    }
    onOpenChange(next);
  };

  const shareUrl = minted ? absoluteShareUrl(minted.url) : null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        {minted && shareUrl ? (
          <>
            <DialogHeader>
              <DialogTitle>Link created</DialogTitle>
              <DialogDescription>
                Anyone with this link can read the conversation. Revoke it from Shared links at any
                time; revoking takes effect on the next request.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareUrl}
                aria-label="Share link"
                data-testid="share-url"
                className="w-full rounded border border-border bg-muted/20 px-2 py-1 font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Publish this conversation?</DialogTitle>
              <DialogDescription>
                This creates a link that works without an account. Anyone who has it can read the
                whole conversation.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 text-sm">
              <dl
                className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border border-border bg-muted/10 p-3 text-xs"
                data-testid="share-exposure"
              >
                <dt className="text-muted-foreground">Conversation</dt>
                <dd className="truncate" title={conversationLabel}>
                  {conversationLabel}
                </dd>
                <dt className="text-muted-foreground">Turns</dt>
                <dd>
                  {snapshotQuery.isPending
                    ? "counting…"
                    : exposure
                      ? exposure.turnCount
                      : "could not read"}
                </dd>
                <dt className="text-muted-foreground">When</dt>
                <dd>
                  {snapshotQuery.isPending
                    ? "…"
                    : (exposure?.range ?? (exposure ? "no dated turns" : "unknown"))}
                </dd>
              </dl>

              {/*
                Stated plainly and without softening, because the reader of a
                published transcript sees all of it — not a summary, not the
                prose turns only.
              */}
              <p className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs">
                Everything in this conversation becomes readable by anyone holding the link,
                including file contents, command output, tool results, and anything an agent pasted
                into it. Automated scrubbing catches credential patterns only — it does not remove
                personal data, customer data, or private file contents. Read the conversation before
                you publish it.
              </p>

              {/*
                A confirmation that cannot say what is about to be exposed is
                not a confirmation. If the snapshot read failed, publishing is
                REFUSED here rather than offered with "could not read" in the
                summary — the control exists precisely so the operator sees the
                contents before the contents become public, and failing open
                would leave the button doing its job while the dialog did not
                do its own. Found by looking at the rendered dialog.
              */}
              {exposureUnavailable ? (
                <p className="text-xs text-destructive" role="alert" data-testid="share-no-exposure">
                  Could not read this conversation, so there is nothing to show you about what
                  would become public. Publishing is disabled until it loads.
                </p>
              ) : null}

              {mint.error ? (
                <p className="text-xs text-destructive" role="alert" data-testid="share-mint-error">
                  {mint.error instanceof MintError
                    ? mint.error.message
                    : "Could not create the share link."}
                </p>
              ) : null}
            </div>

            <DialogFooter>
              <Button size="sm" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={mint.isPending || snapshotQuery.isPending || exposureUnavailable}
                data-testid="share-publish-confirm"
                onClick={() => mint.mutate()}
              >
                {mint.isPending ? "Publishing…" : "Publish"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
