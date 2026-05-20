/**
 * Channel → TanStack Query key mapping — mt#1148 Stage 2.
 *
 * Maps each ADR-010 SSE channel to the set of TanStack Query cache keys that
 * should be invalidated when an event fires on that channel. Invalidation
 * triggers the affected widgets to refetch via their existing `useQuery` hooks.
 *
 * QueryKey shapes are derived from the actual `queryKey` arrays in each widget:
 *   - Agents widget:    queryKey: ["agents"]    (Agents.tsx:155)
 *   - Attention widget: queryKey: ["attention"] (Attention.tsx:553)
 *   - Workstreams widget: prop-driven (no useQuery); invalidation is a no-op
 *   - TaskGraph widget:   prop-driven (no useQuery); invalidation is a no-op
 *   - BasicHealth widget: prop-driven (no useQuery); invalidation is a no-op
 *
 * Prop-driven widgets receive data from App-level polling via `fetchWidgetData`
 * and do not use TanStack Query, so SSE-driven invalidation does not apply to
 * them. Their update cadence remains controlled by the App polling loop.
 *
 * When mt#1854 ships new channel producers, extend CHANNEL_TO_QUERY_KEYS.
 * When prop-driven widgets migrate to useQuery (future work), add their
 * queryKeys to the relevant channel mappings.
 */

// ---------------------------------------------------------------------------
// Channel name constants — mirrors server.ts COCKPIT_SSE_CHANNELS values.
// Kept inline (no server import) because the frontend bundle is separate.
// ---------------------------------------------------------------------------

/** Channels with live producers (mt#1411 shipped). */
const CHANNEL_ATTENTION_OPENED = "minsky.attention_window_opened";
const CHANNEL_ATTENTION_CLOSED = "minsky.attention_window_closed";

/** Channels with pending producers (mt#1854). Pre-wired to enable zero-config
 *  invalidation once producers ship. */
const CHANNEL_SESSION_STARTED = "minsky.session.started";
const CHANNEL_SESSION_SCOPE_CHANGED = "minsky.session.scope_changed";
const CHANNEL_TASK_STATUS_CHANGED = "minsky.task.status_changed";
const CHANNEL_TASK_BLOCKING = "minsky.task.blocking";

/** Credential-invalidation channel — mt#1426. Producer:
 *  `notifyCredentialInvalidated` in src/domain/credentials/invalidations.ts. */
const CHANNEL_CREDENTIAL_INVALIDATED = "minsky.credential.invalidated";

// ---------------------------------------------------------------------------
// Channel → query-key map
// ---------------------------------------------------------------------------

/**
 * Maps Postgres NOTIFY channel names to arrays of TanStack Query `queryKey`s
 * to invalidate when the channel fires.
 *
 * Each entry is `channel → ReadonlyArray<queryKey>`, where each `queryKey` is
 * a `ReadonlyArray<string | number>` passed directly to
 * `queryClient.invalidateQueries({ queryKey })`.
 */
export const CHANNEL_TO_QUERY_KEYS: Readonly<
  Record<string, ReadonlyArray<ReadonlyArray<string | number>>>
> = {
  // Attention events — trigger refetch of the attention widget
  [CHANNEL_ATTENTION_OPENED]: [["attention"]],
  [CHANNEL_ATTENTION_CLOSED]: [["attention"]],

  // Session events — trigger refetch of agents widget (session liveness)
  // Workstreams is prop-driven; will add once it migrates to useQuery.
  [CHANNEL_SESSION_STARTED]: [["agents"]],
  [CHANNEL_SESSION_SCOPE_CHANGED]: [["agents"]],

  // Task events:
  //   - `task.status_changed` has no useQuery-based consumer yet (TaskGraph and
  //     Workstreams are prop-driven via App-level polling). Mapped to empty
  //     array; when a self-fetching task-data widget is added, route it here.
  //   - `task.blocking` is intentionally routed to `["attention"]` because the
  //     Attention widget's cohort can include blocking-class asks (per ADR-008
  //     §Ask kinds), so a new blocking event should trigger an attention refetch.
  [CHANNEL_TASK_STATUS_CHANGED]: [],
  [CHANNEL_TASK_BLOCKING]: [["attention"]],

  // Credential invalidation — trigger refetch of the credentials widget.
  [CHANNEL_CREDENTIAL_INVALIDATED]: [["credentials"]],
} as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the list of TanStack Query `queryKey` arrays that should be
 * invalidated when an SSE event fires on `channel`.
 *
 * Returns an empty array for unknown channels (i.e. channels not in
 * `CHANNEL_TO_QUERY_KEYS`). This is safe — an empty result means no
 * cache invalidation is triggered, and widgets fall back to polling.
 *
 * @param channel - Postgres NOTIFY channel name from the SSE event.
 * @returns Array of queryKey arrays (may be empty).
 */
export function queryKeysForChannel(
  channel: string
): ReadonlyArray<ReadonlyArray<string | number>> {
  return CHANNEL_TO_QUERY_KEYS[channel] ?? [];
}
