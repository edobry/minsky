/**
 * Client for the conversation share-link endpoints (mt#4024).
 *
 * One module so the publish dialog and the published-links page agree on the
 * wire shape and the query key — the same reason `conversation-snapshot.ts`
 * exists for snapshots.
 */

/** A share as the authenticated endpoints report it. The token is never in it. */
export interface ShareSummary {
  id: string;
  conversationId: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
}

/**
 * The mint response, which additionally carries `url` — the ONLY time the raw
 * token is ever readable. The server stores a hash, so a share whose URL was
 * not captured here cannot be recovered, only revoked and re-minted.
 */
export interface MintedShare extends ShareSummary {
  url: string;
}

/** Distinguishes the refusals worth explaining from a generic failure. */
export type MintFailure = "unscrubbed" | "no-transcript" | "error";

export class MintError extends Error {
  constructor(
    readonly failure: MintFailure,
    message: string
  ) {
    super(message);
    this.name = "MintError";
  }
}

export const sharesQueryKey = ["shares"] as const;

export async function listShares(): Promise<ShareSummary[]> {
  const res = await fetch("/api/shares");
  if (!res.ok) throw new Error(`Could not list share links (${res.status})`);
  const json = (await res.json()) as { shares?: ShareSummary[] };
  return json.shares ?? [];
}

export async function mintShare(input: {
  conversationId: string;
  label?: string | null;
}): Promise<MintedShare> {
  const res = await fetch("/api/shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    if (res.status === 422) {
      throw new MintError(
        "unscrubbed",
        body.detail ??
          "This transcript was ingested before the credential-scrub cutover, so it cannot be published."
      );
    }
    if (res.status === 404) {
      throw new MintError("no-transcript", "No transcript was found for this conversation.");
    }
    throw new MintError("error", body.error ?? `Could not create the share link (${res.status})`);
  }
  return (await res.json()) as MintedShare;
}

export async function revokeShare(id: string): Promise<void> {
  const res = await fetch(`/api/shares/${encodeURIComponent(id)}/revoke`, { method: "POST" });
  if (!res.ok) throw new Error(`Could not revoke the share link (${res.status})`);
}

/**
 * The absolute URL to hand someone, built from the server's relative path.
 *
 * Falls back to the relative path rather than throwing when there is no
 * resolvable base — a non-browser render, or a document whose origin is opaque
 * (`about:blank`, a sandboxed frame, a test DOM). A relative path is a degraded
 * answer but still a usable one; an exception here would take out the dialog
 * that has just successfully published something, which is the worst possible
 * moment to lose the only copy of the token.
 */
export function absoluteShareUrl(path: string): string {
  if (typeof window === "undefined") return path;
  try {
    return new URL(path, window.location.href).toString();
  } catch {
    return path;
  }
}
