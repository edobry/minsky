/**
 * SessionFilmRedirect — compatibility shim for the retired `/session-film`
 * route (mt#3461).
 *
 * The film used to be a top-level page here, with a picker for choosing which
 * conversation to replay. It is now a Film tab on the conversation itself
 * (`/conversation/:id/film`, `/agents/:id/film`) — a lens on a conversation
 * rather than a separate place, reached by drilling into the entity. The picker
 * went away with the route: a conversation you are already looking at does not
 * need to be picked.
 *
 * This shim exists because `/session-film?session=<id>&t=<n>` links are already
 * out in the world — in ingested transcripts, in PR bodies, in the mt#3184-era
 * memory records. They must keep resolving, so the params are translated rather
 * than dropped: `?session=` becomes the path, `?t=` rides along unchanged.
 *
 * With no `?session=`, there is no conversation to redirect TO, so this lands on
 * `/agents` — the same target `/conversations` already redirects to
 * (`App.tsx`), and the surface from which a conversation is chosen now.
 *
 * @see components/session-film/SessionFilm.tsx — the film body this page used to host
 */
import { Navigate, useSearchParams } from "react-router-dom";

const SESSION_PARAM = "session";
const PLAYHEAD_PARAM = "t";

/** Where a legacy `/session-film` URL should land. Exported for direct unit testing. */
export function legacyFilmRedirectTarget(params: URLSearchParams): string {
  const conversationId = params.get(SESSION_PARAM);
  if (!conversationId) return "/agents";
  const playhead = params.get(PLAYHEAD_PARAM);
  const suffix = playhead ? `?${PLAYHEAD_PARAM}=${encodeURIComponent(playhead)}` : "";
  return `/conversation/${encodeURIComponent(conversationId)}/film${suffix}`;
}

export function SessionFilmRedirect() {
  const [searchParams] = useSearchParams();
  return <Navigate to={legacyFilmRedirectTarget(searchParams)} replace />;
}
