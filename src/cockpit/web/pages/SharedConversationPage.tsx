/**
 * `/s/:token` — a published conversation, read by someone with no account
 * (mt#4024).
 *
 * This is the only page in the cockpit that renders for an anonymous request,
 * so what it does NOT do is as load-bearing as what it does:
 *
 *   - It mounts outside `AuthGate` and outside `App` (see `main.tsx`), so no
 *     cockpit chrome, no navigation, no SSE, and no widget polling — every one
 *     of which would 401 here and none of which a reader was given access to.
 *   - It reads exactly one endpoint, `/api/shares/public/:token`, the single
 *     entry on the mt#4023 public allow-list. There is no second fetch it could
 *     make: the entity index is empty by construction, so nothing linkifies
 *     into a cockpit route the reader cannot open.
 *
 * The thread itself is the SAME renderer the authenticated conversation view
 * uses (`buildConversationThread` + `buildTurnNodes`), so a shared conversation
 * reads exactly as it does inside the cockpit rather than through a
 * lower-fidelity export that would drift from it.
 */
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { buildConversationThread } from "../lib/conversation-thread-model";
import { buildTurnNodes } from "../components/ConversationTurnView";
import {
  hasRenderablePreparedElement,
  mergeCommandInvocations,
  pairToolInvocations,
} from "../lib/conversation-turn-assembly";
import type { EntityIndex } from "../lib/entity-linkifier";
import { formatLocalTime } from "../lib/conversation-timeline";

/**
 * No entity linkification on a share page.
 *
 * Not an oversight and not a stub to fill in later: every link the index would
 * produce points at a cockpit route (`/task/...`, `/memory/...`) that this
 * reader has no session for, so linkifying would render an app full of dead
 * ends. Building it would also mean fetching the entity id-set, which is
 * behind the gate.
 */
const NO_ENTITY_INDEX: EntityIndex = new Map();

interface SharePayload {
  conversationId: string;
  label: string | null;
  createdAt: string;
  blocks: SessionContextSnapshotBlock[];
}

/** Why a share page cannot be shown — each with its own thing to say. */
type ShareFailure = "revoked" | "unknown" | "unpublishable" | "error";

class ShareFetchError extends Error {
  constructor(readonly failure: ShareFailure) {
    super(failure);
    this.name = "ShareFetchError";
  }
}

async function fetchShare(token: string): Promise<SharePayload> {
  const res = await fetch(`/api/shares/public/${encodeURIComponent(token)}`);
  if (!res.ok) {
    if (res.status === 410) throw new ShareFetchError("revoked");
    if (res.status === 404) throw new ShareFetchError("unknown");
    if (res.status === 422) throw new ShareFetchError("unpublishable");
    throw new ShareFetchError("error");
  }
  const json = (await res.json()) as Partial<SharePayload>;
  if (!Array.isArray(json.blocks) || typeof json.conversationId !== "string") {
    throw new ShareFetchError("error");
  }
  return {
    conversationId: json.conversationId,
    label: typeof json.label === "string" ? json.label : null,
    createdAt: typeof json.createdAt === "string" ? json.createdAt : "",
    blocks: json.blocks,
  };
}

const FAILURE_COPY: Record<ShareFailure, { heading: string; detail: string }> = {
  revoked: {
    heading: "This link has been turned off",
    detail:
      "The conversation was shared and then unshared. Whoever sent you the link can share it again.",
  },
  unknown: {
    heading: "No such link",
    detail: "This address does not name a shared conversation. Check the link you were sent.",
  },
  unpublishable: {
    heading: "This conversation can no longer be shared",
    detail:
      "It failed the check that runs before any transcript is served publicly, so it is not being shown.",
  },
  error: {
    heading: "Could not load this conversation",
    detail: "Something went wrong on our side. Try again in a moment.",
  },
};

function ShareMessage({ failure }: { failure: ShareFailure }) {
  const copy = FAILURE_COPY[failure];
  return (
    <div className="mx-auto flex min-h-screen max-w-xl items-center justify-center p-6">
      <div className="space-y-2 text-center" data-testid={`share-${failure}`}>
        <h1 className="text-lg font-semibold">{copy.heading}</h1>
        <p className="text-sm text-muted-foreground">{copy.detail}</p>
      </div>
    </div>
  );
}

/** A date range reads better than two full timestamps when both fall on one day. */
function formatRange(first: string | undefined, last: string | undefined): string | null {
  if (!first) return null;
  const start = formatLocalTime(first);
  if (!last || last === first) return start;
  return `${start} – ${formatLocalTime(last)}`;
}

export function SharedConversationPage() {
  const { token } = useParams<{ token: string }>();

  const query = useQuery<SharePayload, Error>({
    queryKey: ["share", token],
    queryFn: () => fetchShare(token ?? ""),
    enabled: Boolean(token),
    // A 404/410/422 is the final answer about this link; retrying only delays
    // the explanation the reader is owed.
    retry: (_count, error) => !(error instanceof ShareFetchError),
    staleTime: 60_000,
  });

  const blocks = query.data?.blocks;
  const model = useMemo(() => buildConversationThread(blocks ?? []), [blocks]);
  const preparedTurns = useMemo(
    () =>
      mergeCommandInvocations(
        pairToolInvocations(model.visibleTurns, model.callNameByToolUseId)
      ).filter((t) => t.elements.some(hasRenderablePreparedElement)),
    [model]
  );

  if (query.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading conversation…
      </div>
    );
  }

  if (query.error) {
    return (
      <ShareMessage
        failure={query.error instanceof ShareFetchError ? query.error.failure : "error"}
      />
    );
  }

  const payload = query.data;
  if (!payload) return <ShareMessage failure="error" />;

  const range = formatRange(
    preparedTurns[0]?.timestamp,
    preparedTurns[preparedTurns.length - 1]?.timestamp
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4" data-testid="share-page">
      <header className="flex flex-col gap-1 border-b border-border pb-3">
        <h1 className="text-lg font-semibold">{payload.label ?? "Shared conversation"}</h1>
        <p className="text-xs text-muted-foreground">
          {/* Says what this is, for a reader who has never seen Minsky and
              arrived from a link with no other context. */}
          A read-only copy of one agent conversation, shared from Minsky
          {range ? ` · ${range}` : ""}
          {preparedTurns.length > 0
            ? ` · ${preparedTurns.length} ${preparedTurns.length === 1 ? "turn" : "turns"}`
            : ""}
        </p>
      </header>

      {preparedTurns.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This conversation has no turns to display.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {buildTurnNodes({
            preparedTurns,
            supersededGroups: model.supersededGroups,
            blockIndexById: model.blockIndexById,
            turnIndexByBlockId: model.turnIndexByBlockId,
            entityIndex: NO_ENTITY_INDEX,
            // No expand-all control on this page, so no broadcast to make.
            expandSignal: undefined,
          })}
        </div>
      )}
    </div>
  );
}
