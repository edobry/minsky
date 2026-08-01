/**
 * Provenance of a workspace -> conversation link (mt#3529).
 *
 * Its own module, with NO imports, because both sides of the wire need it: the
 * server route that emits the field (`routes/agents.ts`, via
 * `derived-conversation-link.ts`) and the SPA type that reads it
 * (`web/widgets/RunDetail.tsx`). Declaring the union twice would let the web
 * copy go stale the first time a third provenance is added — the drift this
 * module exists to prevent. Keep it dependency-free so the web bundle can
 * import it without pulling drizzle or the domain schemas in behind it.
 *
 *   - `link-row` — a row a writer stamped in `minsky_session_links`
 *     (`session_creator`, `pr_author`, `subagent_spawn`, `driven_spawn`,
 *     `cwd_match`). The authoritative case.
 *   - `derived-agent-id` — derived from the workspace record's own `agentId`
 *     because no writer stamped a row. Existence-checked against
 *     `agent_transcripts`, but resting on a weaker basis: ADR-006
 *     §Consequences gives the identity scheme no forgery defense, so this is
 *     reported distinctly rather than folded into the stamped set.
 */
export type ConversationLinkSource = "link-row" | "derived-agent-id";
