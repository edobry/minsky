/**
 * Display labels for a workspace's conversation CANDIDATES (mt#3691).
 *
 * The run-detail switcher used to render each candidate's raw
 * `agentSessionId`, so an operator looking at a workspace with an orchestrator
 * conversation and three subagent transcripts saw four UUIDs. This module
 * gives each candidate the SAME label the run list and the conversation page
 * already show, via the one precedence decision
 * (`@minsky/domain/transcripts/conversation-label`) and the one enrichment
 * lookup (`./conversation-label-enrichment`).
 *
 * Deliberately NOT folded into `routes/agents.ts`'s
 * `resolveWorkspaceConversations`: that function has a second caller,
 * `/api/agents/:id/live-tail`, which pipes candidates straight into
 * `pickBestConversationLink` and discards everything else. Enriching inside it
 * would make every SSE live-tail connect pay for four label-input queries it
 * throws away. Labeling is a separate step the detail route opts into.
 *
 * Batch-shaped for the same reason `widgets/context-inspector.ts` is: one
 * `fetchEnrichment` call covers every candidate, so a five-conversation
 * workspace costs the same number of round-trips as a two-conversation one.
 *
 * `db` and `titleCache` are parameters rather than module reads so the batch
 * can be exercised against a stub without patching an import.
 *
 * @see @minsky/domain/transcripts/conversation-label — the precedence half
 * @see ./conversation-label-enrichment — the input-lookup half
 * @see mt#3343 — the same reuse, for the single-conversation overview route
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { TaskTitleCache } from "./task-title-cache";

/** The per-candidate label inputs this module reads. */
export interface LabelableCandidate {
  agentSessionId: string;
  cwd: string | null;
  startedAt: string | null;
  /** `agent_transcripts.title` — the generated tier-2 title, when one exists. */
  generatedTitle: string | null;
}

/**
 * Compute a display label per candidate, keyed by `agentSessionId`.
 *
 * Every candidate gets an entry: a candidate for which no enrichment tier
 * resolves still gets the tier-4 `deriveFallbackLabel` timestamp·cwd·id
 * string, which is strictly more identifying than the bare uuid this exists to
 * replace. A label is chrome, not data — any failure degrades the whole batch
 * to those fallbacks rather than failing the route.
 */
export async function labelConversationCandidates(
  db: PostgresJsDatabase,
  candidates: LabelableCandidate[],
  titleCache: TaskTitleCache | null
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (candidates.length === 0) return labels;

  const { deriveFallbackLabel } = await import("@minsky/domain/transcripts/conversation-label");

  const fallbackFor = (c: LabelableCandidate): string =>
    deriveFallbackLabel(c.agentSessionId, c.cwd, c.startedAt ? new Date(c.startedAt) : null);

  try {
    const { fetchEnrichment, EMPTY_ENRICHMENT } = await import("./conversation-label-enrichment");
    const { computeConversationLabel } = await import(
      "@minsky/domain/transcripts/conversation-label"
    );

    const enrichment = await fetchEnrichment(
      db,
      candidates.map((c) => c.agentSessionId),
      titleCache
    );

    for (const c of candidates) {
      const e = enrichment.get(c.agentSessionId) ?? EMPTY_ENRICHMENT;
      // The generated title participates in the guard as well as the inputs
      // (mt#3321, mirroring widgets/context-inspector.ts): a conversation whose
      // ONLY label source is its generated title must still reach the
      // precedence function rather than dropping to the fallback.
      const hasTier =
        e.linkedTaskTitle || c.generatedTitle || e.firstUserText || e.subagentDescriptor;
      labels.set(
        c.agentSessionId,
        hasTier
          ? computeConversationLabel({
              agentSessionId: c.agentSessionId,
              cwd: c.cwd,
              startedAt: c.startedAt ? new Date(c.startedAt) : null,
              linkedTaskTitle: e.linkedTaskTitle,
              generatedTitle: c.generatedTitle,
              firstUserText: e.firstUserText,
              subagentDescriptor: e.subagentDescriptor,
            })
          : fallbackFor(c)
      );
    }
    return labels;
  } catch {
    for (const c of candidates) labels.set(c.agentSessionId, fallbackFor(c));
    return labels;
  }
}
