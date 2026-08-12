/**
 * `/shares` — every conversation that has been published, and the revoke
 * control for each (mt#4024).
 *
 * A publish action with no inventory is how a share outlives its reason: the
 * operator remembers sending one link and has no way to see the other four.
 * This page is the answer to "what is currently readable by anyone with a
 * link," which is a question about exposure, so revoked shares stay listed
 * (dimmed) rather than disappearing — "I turned that off" is worth being able
 * to confirm.
 *
 * Last-access time is the other half: a link nobody has opened in months is a
 * candidate for revocation, and a link opened after you thought the reader was
 * done is worth noticing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { formatLocalTime } from "../lib/conversation-timeline";
import {
  listShares,
  revokeShare,
  sharesQueryKey,
  type ShareSummary,
} from "../lib/shares-client";

function when(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatLocalTime(iso);
  } catch {
    return iso;
  }
}

function ShareRow({ share, onRevoke }: { share: ShareSummary; onRevoke: (id: string) => void }) {
  const revoked = share.revokedAt !== null;
  return (
    <tr
      className={cn("border-b border-border/50 align-top", revoked && "opacity-50")}
      data-testid={revoked ? "share-row-revoked" : "share-row-live"}
    >
      <td className="py-2 pr-3">
        <Link
          to={`/conversation/${encodeURIComponent(share.conversationId)}`}
          className="text-primary underline-offset-4 hover:underline"
        >
          {share.label ?? share.conversationId}
        </Link>
        {share.label ? (
          <div className="font-mono text-[11px] text-muted-foreground">{share.conversationId}</div>
        ) : null}
      </td>
      <td className="py-2 pr-3 text-xs tabular-nums text-muted-foreground">
        {when(share.createdAt)}
      </td>
      <td className="py-2 pr-3 text-xs tabular-nums text-muted-foreground">
        {when(share.lastAccessedAt)}
      </td>
      {/*
        Semantic tokens only (`custom/no-raw-colors-in-cockpit`): this is a
        table, not a declared status-indicator widget. "Live" carries its weight
        by being the only unmuted cell in the column.
      */}
      <td className="py-2 pr-3 text-xs">
        {revoked ? (
          <span className="text-muted-foreground">Revoked {when(share.revokedAt)}</span>
        ) : (
          <span className="font-medium text-foreground">Live</span>
        )}
      </td>
      <td className="py-2 text-right">
        {revoked ? null : (
          <Button size="sm" variant="outline" onClick={() => onRevoke(share.id)}>
            Revoke
          </Button>
        )}
      </td>
    </tr>
  );
}

export function SharedLinksPage() {
  const queryClient = useQueryClient();
  const query = useQuery<ShareSummary[], Error>({
    queryKey: sharesQueryKey,
    queryFn: listShares,
  });

  const revoke = useMutation<void, Error, string>({
    mutationFn: revokeShare,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sharesQueryKey }),
  });

  const shares = query.data ?? [];
  const liveCount = shares.filter((s) => s.revokedAt === null).length;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-lg font-semibold">Shared links</h1>
        <p className="text-xs text-muted-foreground">
          Conversations published as read-only links. {liveCount} readable by anyone holding the
          link.
        </p>
      </div>

      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : query.error ? (
        <p className="text-sm text-destructive" role="alert">
          {query.error.message}
        </p>
      ) : shares.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="shares-empty">
          Nothing is published. Use Share on a conversation to create a link.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">Conversation</th>
              <th className="pb-2 pr-3 font-medium">Published</th>
              <th className="pb-2 pr-3 font-medium">Last opened</th>
              <th className="pb-2 pr-3 font-medium">Status</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {shares.map((share) => (
              <ShareRow key={share.id} share={share} onRevoke={(id) => revoke.mutate(id)} />
            ))}
          </tbody>
        </table>
      )}

      {revoke.error ? (
        <p className="text-sm text-destructive" role="alert">
          {revoke.error.message}
        </p>
      ) : null}
    </div>
  );
}
