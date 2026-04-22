# Conversational Knowledge Sources — Research Memo

**Task**: mt#1029  
**Date**: 2026-04-21  
**Status**: Go — with phased plan starting with Slack  
**Recommendation**: Conversational sources belong in a **third category** (ephemeral/conversational), not the KB and not the Mesh. Slack should be the first target, using Slack's Real-time Search API (not bulk indexing), with thread as the chunking unit, rich provenance metadata, and two distinct retrieval modes.

---

## 1. KB/Mesh Boundary — Does It Survive the Leak-Coverage Framing?

### The original boundary

Phase 1 design drew this line:

> "Proper knowledge bases only — Notion, Confluence, Google Docs. Not Slack (that's the Mesh)."

The Mesh in Minsky's VSM framing is System 2: cross-session coordination signals and reasoning streams that let concurrent agents know what other agents are doing without requiring central direction. The Mesh RFC describes it as anti-oscillatory infrastructure — preventing agents and humans from interfering with each other.

Slack was placed in the Mesh because conversational content was seen as coordination data: ephemeral, event-driven, primarily useful for synchronizing real-time state rather than preserving durable knowledge.

### The leak-coverage challenge

The 2026-04-21 reframing established that the KB's job is to **catch knowledge wherever it leaks**, not to index official documentation surfaces. Under this framing, Slack is one of the most significant leak targets in a typical engineering team:

- Architecture decisions made in a `#engineering` thread and never migrated to Notion
- API design rationale explained in a DM thread to the new hire and never written up
- Postmortem findings discussed in `#incidents` but only partially captured in the official doc
- "Why did we choose tsyringe?" answered in a Slack thread that is now the only surviving record

The "Slack = Mesh" assignment did not anticipate this. It assumed Slack messages are transient coordination signals — the kind of thing you'd want an agent to consult before starting work on a file (to avoid conflicts), not the kind of thing you'd want an agent to consult to understand why the system was designed a certain way.

### The three-category resolution

After analysis, the original binary (KB vs Mesh) does not cleanly contain conversational sources. The right model is **three categories**:

| Category                                  | What it is                                                      | Examples                                                        | Primary use                                             |
| ----------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| **KB** (canonical)                        | Deliberately authored, document-shaped, durable                 | Notion, Google Docs, Confluence                                 | Semantic search, authority resolution, reconciliation   |
| **Mesh** (coordination)                   | Real-time agent coordination signals                            | Session state, in-progress task graph, cross-agent observations | Avoid conflicts, coordinate parallel work               |
| **Conversational** (ephemeral/persistent) | Chat-shaped, high-noise, variable durability, author-attributed | Slack, Teams, Discord                                           | Decision archaeology, Q&A retrieval, historical context |

The Conversational category is neither KB nor Mesh:

- It is **not KB** because it is not document-shaped. Chunking, ingestion, reconciliation, and retrieval modes that work for Notion pages do not work for Slack threads without significant adaptation.
- It is **not Mesh** because it is not real-time coordination. A Slack thread from 18 months ago about why the team chose Postgres is not a coordination signal — it is durable institutional memory that happens to be stored in a chat interface.

The KB/Mesh boundary survives the reframing but needs a **third track** alongside it. The Mesh RFC remains intact; it describes a specific coordination infrastructure problem that Slack content cannot solve and does not need to solve.

**Verdict**: The KB/Mesh boundary is coherent under the leak-coverage framing. Slack/Teams/Discord belong in a third track: Conversational. The boundary between KB and Conversational is: KB sources are _authored_ as documentation; Conversational sources are _produced_ as communication and repurposed for retrieval.

---

## 2. Chunking Unit

### Why document-level chunking fails

The current KB ingestion pipeline (`src/domain/knowledge/ingestion/chunker.ts`) uses a hierarchical strategy designed for Markdown documents: split on `##` headings, then `###` subheadings, then paragraphs, then tokens. This strategy assumes:

1. Content has semantic structure (headings, sections)
2. A document has a coherent scope that can be boundary-detected by formatting
3. Chunks carry their own context (heading hierarchy)

None of these hold for Slack channels. A channel is an unbounded stream. A message is 1–3 sentences. A thread is a bounded Q&A or decision unit. A channel month is massive noise with sparse signal.

### Ecosystem evidence on chunking

**Guru**: The fundamental unit is the **thread**, not the individual message. Guru's sync count reports thread count, not message count. Near-real-time sync as threads post.

**Snyk's production RAG**: Attempted rolling-window and daily chunking — both failed ("lacked consistency and focus"). Pivoted to **Q&A-centric threading**: each thread asking a question + receiving a response became a single structured document chunk. LLM summarization (Gemini) extracted the canonical question and answer; only the question was embedded; the answer was stored as metadata for retrieval.

**Question Base**: Enforces "one topic per thread" as a hygiene rule. Captures threads via emoji reaction or command. Treats each captured thread as a single FAQ entry.

**Notion AI**: Indexes public channels; each thread is the retrievable unit. 30-minute latency for new messages.

**General RAG research (2024-2025)**: For chat logs, 200–400 token chunks outperform larger windows. Semantic chunking (boundary detection by meaning shift rather than token count) improves retrieval precision by keeping topically coherent exchanges together. Speaker turns with timestamps are first-class metadata, not stripped content.

### Recommended chunking strategy

**Primary unit: the thread.** A Slack thread (the root message + all replies) is the natural semantic unit. It has:

- A defined start (the root message)
- A defined scope (the topic or question that generated the thread)
- A defined end (the last reply, or no replies if a standalone message)
- Authorship attribution at the message level
- Temporal structure

**Boundary cases**:

1. **Standalone messages with no replies**: Treat as single-message threads. Embed as-is if the message is substantive (>50 tokens); skip if it is purely social (emoji reactions, "+1", acknowledgments). Use an LLM classifier to distinguish.

2. **Very long threads (>100 messages)**: Apply LLM summarization to extract the central Q&A or decision; embed the summary + canonical question; store original thread reference in metadata. This is the Snyk approach and it works.

3. **Channel-level signals without thread structure**: Announcements in `#releases`, `#deployments`, `#incidents` that are standalone messages carry high signal. Treat them as single-message threads with `messageType: "announcement"` metadata.

4. **Topic-cluster extraction**: As a Phase 2 enhancement (not Phase 1), use HDBSCAN clustering over thread embeddings within a channel + time window to identify topic-clusters. This enables "summarize all threads about the migrations work over Q3" but requires the base threading ingestion to already work.

**Anti-patterns to avoid**:

- Channel-as-document: channels are unbounded and incoherent; they cannot be chunked as documents
- Fixed sliding windows (e.g., 24h of messages): no relationship to semantic boundaries; produces incoherent chunks
- Message-as-chunk: loses context; "yes" and "sounds good" are meaningless without the thread that precedes them
- Topic-cluster as primary unit: useful but complex; not achievable without thread-level ingestion as a prerequisite

---

## 3. Attribution Model

### Why attribution matters more for conversational sources

In KB sources (Notion, Google Docs), attribution carries moderate weight:

- Who wrote the document establishes baseline authority
- Last-modified date signals freshness
- Conflicts between two docs require NLI, not attribution reasoning

In conversational sources, attribution is primary:

- "We decided to use tsyringe" from the tech lead in a `#architecture` thread means something different from the same statement from a junior dev in `#random`
- "We should probably migrate off X" is speculation without a follow-up decision
- A thread from 3 years ago is not the same as a thread from last week — especially for design decisions that may have been superseded
- Multiple people may contradict each other within the same thread; knowing who said what is required to interpret the thread

### Current KB output shape (Phase 2a target)

The Phase 2a (mt#988) output shape adds `freshness` and `authority` slots to the KB document. The Phase 2b (mt#1027) layer adds `conflicts` and `redundancies`. For conversational sources, the required provenance shape is richer:

### Proposed provenance shape for conversational chunks

```typescript
interface ConversationalChunkMetadata {
  // Source identification
  sourceType: "slack" | "teams" | "discord";
  sourceName: string; // configured source name
  channelId: string;
  channelName: string;

  // Thread identification
  threadTs: string; // Slack thread_ts (root message timestamp)
  threadUrl: string; // permalink to the thread

  // Temporal provenance
  threadStarted: Date; // when the root message was posted
  threadLastActivity: Date; // last reply timestamp
  threadAgeAtIndex: number; // hours since last activity when indexed

  // Author provenance
  rootAuthorId: string; // user ID of the person who started the thread
  rootAuthorDisplayName: string;
  participantIds: string[]; // all participants in the thread
  participantCount: number;

  // Content provenance
  messageCount: number; // total messages in thread
  chunkType: "thread" | "standalone" | "announcement" | "summary";
  hasLLMSummary: boolean; // whether content was LLM-summarized before embedding

  // Signal quality
  reactionCount: number; // total emoji reactions (proxy for signal quality)
  hasResolution: boolean; // LLM-inferred: does the thread reach a conclusion?
  decisionConfidence: number; // LLM-inferred: 0.0–1.0, is this a decision vs discussion?

  // Phase 2a compatibility
  freshness: "current" | "aging" | "stale"; // based on threadLastActivity age
  authority: string[]; // channel + author role signals (where available)
}
```

### KB output shape changes required

The `KnowledgeDocument` interface (`src/domain/knowledge/types.ts`) currently has:

```typescript
interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  url: string;
  parentId?: string;
  lastModified: Date;
  metadata: Record<string, unknown>;
}
```

For conversational sources, `parentId` would carry the `channelId`, and `metadata` would carry the full `ConversationalChunkMetadata` above. The core interface is flexible enough via `metadata`; no breaking changes to `KnowledgeDocument` are needed. The `KnowledgeSourceConfig` type union (`"notion" | "confluence" | "google-docs"`) would need `"slack" | "teams" | "discord"` added.

The larger change is in the query layer: `knowledge.search` currently returns raw chunk content. For conversational results, callers need provenance rendered in the response — "According to a Slack thread in #engineering on 2025-03-12 (started by Alice, 8 replies)..." — not just the chunk text.

---

## 4. Use-Case Differentiation

Two use cases appear superficially similar but require different retrieval modes:

### Use Case A: "Find the thread where we decided to use tsyringe"

**Characteristics**:

- The user knows a decision was made; they want to locate the specific artifact
- High precision required, low recall acceptable (there is probably one correct answer)
- Temporal and authorship context are load-bearing — the answer is not just the decision but who made it and when
- Failure mode: returning 10 vaguely relevant threads instead of the one definitive thread

**Retrieval mode**: Hybrid search (semantic + keyword), with **strong reranking** based on `decisionConfidence` and `hasResolution` metadata signals. Thread-level retrieval (return the full thread permalink + summary), not chunk-level retrieval. This is closer to "find" than "search."

### Use Case B: "Semantic search across 6 months of #engineering"

**Characteristics**:

- The user wants to explore a topic area without knowing a specific artifact exists
- High recall preferred; moderate precision acceptable
- Temporal clustering may be useful (group findings by time period)
- Failure mode: missing relevant threads because the vocabulary doesn't exactly match

**Retrieval mode**: Dense vector search over thread embeddings, with temporal filtering and optional topic-cluster presentation. This is closer to "explore" than "find."

### Are these the same retrieval mode?

No. They require different query strategies:

| Dimension    | Use Case A (Find)                           | Use Case B (Explore)                 |
| ------------ | ------------------------------------------- | ------------------------------------ |
| Query type   | Hybrid (semantic + BM25)                    | Dense vector primary                 |
| Reranking    | Decision confidence, recency                | Topic diversity, temporal clustering |
| Result shape | Single thread + context + permalink         | Top-N threads + time distribution    |
| Provenance   | Author + date + resolution status prominent | Channel + time period summary        |
| Scope        | Single thread                               | Cross-thread synthesis               |

Both use cases are in-scope and achievable with the thread-as-chunk model. Use Case A is the primary use case for Phase 1 (it has the clearest value proposition and the clearest success metric). Use Case B is Phase 2 (requires topic-cluster layer on top of thread ingestion).

### Use cases explicitly out of scope

- **Full-channel archival search**: "Search everything ever said in #general" — too noisy; no signal-to-noise threshold is achievable
- **DM search**: Legal risk, privacy constraints, and limited enterprise value relative to channel search
- **Real-time presence/activity monitoring**: That is the Mesh use case, not the KB/Conversational use case
- **Cross-workspace or cross-org search**: No API path for this at acceptable cost
- **Automated decision migration**: "Detect a decision in Slack and auto-create a Notion page" — out of scope for ingestion; could be a separate agent action later
- **LLM training on Slack data**: Explicitly prohibited by Slack ToS (May 2025 update)

---

## 5. Platform Survey — What Existing Tools Do

### Glean

**Approach (pre-May 2025)**: Full Slack message indexing into Glean's proprietary search index. Indexed public channels, private channels (as permissioned), DMs (as permissioned). Stored messages externally for ranked retrieval.

**Approach (post-May 2025)**: Pivoted to **federated search via Slack's Real-time Search API**. Glean no longer indexes Slack message bodies. Instead, it:

1. Crawls identity and metadata only (users, channels, memberships) — stored in Glean
2. At query time, calls Slack's RTS API (`assistant.search.context`) to retrieve live results
3. Processes message bodies in memory only (not persisted)
4. Returns enriched results combining live Slack data with cross-source context from other indexed sources

**Required scopes (RTS mode)**: `search:read.public` (mandatory), plus optional `search:read.private`, `search:read.im`, `search:read.mpim` for private content. User tokens required for non-public content.

**What works**: Real-time accuracy (results always current), permission-correct (results respect Slack ACLs automatically), ToS-compliant (no bulk storage).

**What doesn't work**: No offline/batch queries, no historical analysis (only live query-time results), no cross-source reconciliation against stored Slack data, search quality depends entirely on Slack's RTS ranking rather than Glean's proprietary ranking.

**Key lesson**: The May 2025 Slack API terms change was a forcing function. Glean's documented pivot to RTS demonstrates the industry consensus that bulk Slack indexing is no longer viable for third-party tools.

### Guru

**Approach**: Thread-as-unit indexing with near-real-time sync. Guru is installed in channels via `@guru` invitation. As threads post in enabled channels, they flow to Guru for indexing. The "Record" count is thread count, not message count.

**Permission model**: Inherits Slack permissions. Admin authentication required to connect private channels. Bot added to specific channels by explicit invitation.

**What works**: Thread granularity is correct. Permission inheritance is clean. Near-real-time sync.

**What doesn't work**: Guru does not appear to filter out low-signal threads (social, "+1", emoji-only). No mention of LLM summarization for long threads. Knowledge quality depends on channel hygiene. Requires explicit bot invitation per channel.

**Key lesson**: Thread-as-unit is the correct choice. Channel-level opt-in via bot invitation is a sensible permission model that keeps scope bounded and earns explicit admin consent.

### Notion AI

**Approach**: Public-channel indexing via Notion AI connector (Business/Enterprise plan required). Indexes approximately 1 year of historical messages from connection date. New messages searchable within 30 minutes.

**Permission model**: User-level authentication mapping (Slack members → Notion members). Individual users can additionally connect private channels and DMs to their personal Notion AI context. Guest users excluded. Slack Connect (external partner) channels excluded entirely.

**What works**: User-level permission mapping is the right privacy model — users only see what they had access to in Slack. The 1-year historical window is a practical compromise between value and data volume.

**What doesn't work**: Public-channels-only for the shared workspace context means load-bearing decisions in private channels (common in enterprise engineering) are invisible. The 30-minute latency is acceptable for knowledge retrieval but means Notion AI cannot be used for real-time context.

**Key lesson**: User-level permission mapping is essential if any private channel or DM access is contemplated. The "workspace-level connector pulls public channels; user-level extends to private" split is a practical pattern worth adopting.

### Dust

**Approach**: Slack as a first-class data source alongside Google Drive, Notion, Confluence, GitHub. Handles chunking and embeddings internally. Real-time search via personal Slack credentials where possible.

**Pivot (May 2025)**: Like Glean, Dust pivoted after Slack's API terms update. Slack MCP tools now provide real-time search via personal Slack credentials rather than bulk indexing. Semantic search available only when the workspace has Slack AI enabled.

**What works**: Multi-source retrieval (combining Slack results with Notion, Google Drive, etc.) in a single agent context. Dust's open-source approach (Qdrant for vectors) is more inspectable than Glean's.

**What doesn't work**: Dependency on Slack AI subscription for semantic search (not available to all workspaces). Personal-credentials model is fragile for agent use cases (requires individual user OAuth, not a service account).

**Key lesson**: Multi-source synthesis (Slack + docs + tickets in the same retrieval pass) is the end-state that matters, but the path to it runs through per-source ingestion quality. Getting Slack chunking right first is more important than immediate cross-source synthesis.

### Atlassian Rovo

**Approach (pre-October 2025)**: Indexed Slack public conversations into Rovo's search index alongside Jira and Confluence.

**Approach (post-October 2025)**: For new connections after October 2, 2025, Rovo uses Slack's search API directly (federated, no indexing). Slack messages are not indexed by Atlassian. Does not count toward Rovo's indexed objects quota.

**What works**: Integration with Jira/Confluence context makes Rovo useful for finding Slack threads that relate to specific tickets or docs.

**What doesn't work**: No semantic search without Slack AI. Limited historical depth without indexing.

**Key lesson**: The federated pivot happened twice in 2025 (Glean, then Rovo). The industry has converged: **bulk Slack indexing by third-party tools is finished**. The Real-time Search API is the only compliant path.

### Snyk (in-house RAG)

**Approach**: Production RAG implementation indexing internal Slack channels. Started with rolling-window and daily chunking (failed). Pivoted to Q&A-centric thread chunking with LLM summarization.

**Chunking**: Thread = chunk. Long threads get LLM-summarized (Gemini). Only the extracted question is embedded. The answer is stored as metadata.

**What works**: Q&A thread structure yields much higher retrieval precision than arbitrary windowing. Embedding only the question (not the full thread) reduces embedding noise.

**What doesn't work**: Requires identifying Q&A channels specifically (#ask-product, #ask-engineering). General discussion channels produce lower quality retrieval even with the same approach.

**Key lesson**: Channel selection is critical. Q&A-designated channels yield dramatically better signal-to-noise than general discussion channels. Phase 1 should target designated Q&A or decision channels, not all channels.

### Question Base (Slack-native)

**Approach**: Slack-native knowledge capture. Bot monitors channels; users capture threads via emoji reaction. One topic per thread hygiene. Integrates with Notion, Confluence, Google Drive as a knowledge push destination.

**What works**: Human-curated capture (emoji trigger) provides a quality filter that automated indexing lacks. Thread-as-unit is correct.

**What doesn't work**: Requires user behavior change (people must remember to trigger capture). Not useful for mining historical threads.

**Key lesson**: Human-curated capture and automated indexing are complementary, not competing approaches. For a first implementation, start with automated but use quality signals (reaction count, thread length, resolution detection) to approximate curation.

---

## 6. API and Auth Constraints Per Platform

### Slack

**API model**: REST API with bot tokens (`xoxb-`) or user tokens (`xoxp-`). Two relevant access patterns:

**Pattern A: Bulk historical ingestion (conversations.history)**

| Scope              | Access                                       |
| ------------------ | -------------------------------------------- |
| `channels:history` | Public channels the bot is member of         |
| `groups:history`   | Private channels the bot is member of        |
| `im:history`       | DM conversations (bot must be a participant) |
| `mpim:history`     | Group DM conversations                       |

Rate limits (post-May 2025, non-Marketplace apps): **1 request/minute, 15 messages/request maximum**. This makes bulk historical ingestion functionally unusable for non-Marketplace apps.

Rate limits (Marketplace apps or Enterprise Grid with agreement): Standard Tier 3 — 50+ requests/minute. Viable for historical backfill.

**Pattern B: Real-time search (Slack RTS API)**

| Scope                 | Access                                       |
| --------------------- | -------------------------------------------- |
| `search:read.public`  | Required; public channel search              |
| `search:read.private` | Optional; private channels (user token only) |
| `search:read.im`      | Optional; DMs (user token only)              |
| `search:read.mpim`    | Optional; group DMs (user token only)        |

The RTS API (`assistant.search.context`) is the only viable pattern for non-Marketplace tools. Results are returned live from Slack's own index. No external storage of message bodies permitted.

**DM handling**: Bot tokens cannot access DMs unless the bot is a participant. User tokens can access DMs the authenticated user is part of. For enterprise knowledge base purposes, **DMs should be excluded entirely** — they are personal, likely to contain sensitive content, and the value-to-risk ratio is unfavorable.

**Retention policy variance**: Enterprise Grid allows admins to configure custom retention policies (7 days to forever). Non-Grid free/pro workspaces have 90-day message history on free tiers. Indexed content must be treated as potentially ephemeral.

**Data storage prohibition (May 2025)**: Slack API ToS explicitly prohibits bulk export, long-term external storage, and LLM training on Slack data. Enterprise Grid customers with a separate Discovery API agreement are exempt for compliance/eDiscovery use cases — but this carve-out is specifically for legal compliance, not knowledge management.

**Conclusion for Slack**: The only compliant path for a non-Marketplace tool is the Real-time Search API. Bulk historical indexing via `conversations.history` is ToS-prohibited for external storage and rate-limited to the point of impracticality even if the ToS allowed it. A Marketplace app with a signed agreement could access historical data, but this path requires Slack approval and is out of scope for Phase 1.

### Microsoft Teams

**API model**: Microsoft Graph API with two permission models:

**Application permissions (tenant-wide)**: `ChannelMessage.Read.All` grants read access to all channel messages across all teams in the tenant. Requires admin consent. This is the path for enterprise knowledge management tools. The Microsoft Graph endpoint `/teams/{teamId}/channels/{channelId}/messages` returns paginated message history.

**Resource-specific consent (RSC)**: `ChannelMessage.Read.Group` is scoped to the specific team where the bot is installed. Teams channels the bot is not installed in are inaccessible. Lower privilege but narrower scope.

**DM handling**: `/chats` endpoint is available via delegated permissions only (user must be signed in). No application-permission path for DM access exists. This effectively makes DMs inaccessible for automated ingestion, which is appropriate.

**Rate limits**: Microsoft Graph standard limits — 10,000 requests per 10 minutes per tenant. Significantly more generous than Slack's post-2025 limits.

**Data storage**: Microsoft's terms do not prohibit bulk message indexing in the same explicit way Slack's ToS does. Compliance requirements (GDPR, HIPAA) govern data handling; Microsoft's compliance framework (Purview) handles eDiscovery internally.

**Auth complexity**: OAuth 2.0 with Azure AD application registration required. Admin consent needed for application-level permissions. More complex setup than Slack but more permissive once granted.

**Conclusion for Teams**: Technically more permissive than Slack (no ToS prohibition on bulk indexing, more generous rate limits). However, the auth complexity (Azure AD, admin consent) and the enterprise-specific nature of Teams make it appropriate for Phase 2 rather than Phase 1.

### Discord

**API model**: Gateway-based with REST API. Message access requires:

- `MESSAGE_CONTENT` privileged intent: required to read message bodies (not just IDs). Must be explicitly enabled in the Discord Developer Portal.
- Verification required for bots in 75+ guilds to use privileged intents. Discord's approval process evaluates whether the use case is "unique, compelling, and transformative."
- `READ_MESSAGE_HISTORY` channel permission for accessing past messages.

**DM handling**: Bots can access DMs they are participants in via the gateway. However, Discord's Developer Policy restricts data collection to what is necessary for the bot's stated function. Bulk DM archival is unlikely to pass Discord's intent review.

**Rate limits**: 120 gateway events per 60 seconds. REST API rate limits vary by endpoint. Significantly lower volume than Slack or Teams for bulk ingestion.

**Data storage**: Discord's Developer Policy prohibits storing data beyond what is necessary for functionality, and prohibits use cases that "put undue load on Discord's databases." Bulk archival indexing is the specific prohibited pattern.

**Use-case profile**: Discord is relevant for open-source projects and developer communities (e.g., a project's public Discord server). It is not a typical enterprise communication platform. For Minsky's current use cases (engineering team knowledge management), Discord is low priority.

**Conclusion for Discord**: Technically accessible but has the weakest case for enterprise knowledge management. The privileged intent review process, rate limits, data storage restrictions, and non-enterprise target market make Discord Phase 3 at earliest.

---

## 7. Reconciliation Fit

### Current Phase 2b reconciliation design (mt#1027)

Phase 2b proposes two layers:

- **Layer 3**: Near-duplicate clustering (HDBSCAN/agglomerative on cosine similarity) to identify redundant chunks across sources
- **Layer 4**: NLI-based contradiction detection (Haiku 4.5) at batch time (within clusters) and query time (over retrieved top-K)

This was designed for document-shaped sources (Notion pages, Google Docs) where:

- Chunks are moderately sized (hundreds of tokens)
- Content is authored with intent (deliberate choices of wording)
- Two chunks can be semantically compared as statements of fact or guidance

### Why conversational chunks are different

Conversational chunks (threads) have properties that complicate standard reconciliation:

1. **High intra-source redundancy**: Many threads in `#engineering` may discuss the same topic. This is noise, not a conflict. Near-duplicate clustering would produce enormous cluster sizes that are meaningless for reconciliation.

2. **Time-ordered authority**: A newer thread saying "we moved off X" supersedes an older thread saying "we use X." This is not a contradiction to be flagged — it is temporal evolution. Standard NLI conflict detection would flag this as a contradiction and alert unnecessarily.

3. **Speculation vs. decision**: "We should probably do X" and "We decided to do X" look semantically similar but are not equivalent. NLI as implemented in Phase 2b is not designed to distinguish epistemic state (speculation vs. decision).

4. **Cross-source reconciliation**: A Slack thread saying "we decided to use tsyringe" should be reconciled against a Notion page saying "we use inversify" (if one exists). This cross-source reconciliation is valuable but requires the conversational chunk to be a first-class participant in reconciliation, which means its provenance (author, date, channel) must be weighted in the conflict resolution logic.

### Recommendation

Conversational sources **can** plug into Phase 2b's reconciliation framework, but they need **two adaptations** before doing so:

**Adaptation 1: Temporal override rule.** When two chunks from the same source (or cross-source) cover the same semantic concept, and one is significantly newer than the other (e.g., >6 months), classify as "temporal supersession" rather than "conflict." Surface to agents as: "Newer thread (date: X) may supersede older thread (date: Y) — verify the older doc is updated."

**Adaptation 2: Epistemic state metadata.** The `decisionConfidence` field in the proposed `ConversationalChunkMetadata` (see Section 3) should be used during reconciliation to weight conversational chunks. High-confidence decision threads are first-class sources for conflict detection. Low-confidence speculation threads should be excluded from conflict detection entirely (they cannot contradict a document — they are observations, not assertions).

**Phase ordering recommendation**: Do not add conversational sources to Phase 2b until Phase 2b ships and is stable. Conversational sources in reconciliation are an enhancement to Phase 2b, not a prerequisite. The right sequence is:

1. Phase 2a: Google Docs + freshness/authority (mt#988)
2. Phase 2b: Reconciliation for document sources (mt#1027)
3. Conversational Phase 1: Slack ingestion + thread chunking + provenance metadata (new task)
4. Conversational Phase 2: Plug conversational sources into Phase 2b reconciliation with temporal override + epistemic state adaptations

---

## 8. Go/No-Go Recommendation

### Recommendation: Go

**Rationale**:

1. **The leak is real.** Engineering teams routinely make load-bearing design decisions in Slack that are never migrated to documentation. The leak-coverage framing is well-founded and Slack is the largest single leak target for most engineering teams.

2. **The retrieval problem is solved at the thread level.** Snyk's production implementation, Guru's architecture, and the broader RAG research consensus all converge on thread-as-chunk as the correct unit. The core problem is not unsolved.

3. **The compliance path exists.** Slack's Real-time Search API is the correct mechanism. It requires no bulk storage, respects permissions automatically, and is ToS-compliant. The tooling constraint (must use RTS API) simplifies the architecture: no sync scheduler, no content hash checking, no vector storage for Slack bodies.

4. **The primary use case is high-value and measurable.** "Find the thread where we decided X" is a concrete, testable use case with a clear success metric (did the agent find the right thread?).

5. **Phase 2b reconciliation is not a prerequisite.** Phase 1 conversational ingestion (or RTS-based search) can ship independently of reconciliation.

**Constraining factors (not blockers)**:

- Slack Marketplace approval is required for historical backfill at scale. Phase 1 using RTS-only is the correct starting point without requiring Marketplace status.
- The `KnowledgeSourceConfig` type union needs extension; no architectural refactoring.
- Auth complexity (user token vs bot token for private channels) requires a clear policy choice at setup time.

---

## 9. Implementation Architecture (Go Path)

### Platform: Slack first

Target Slack as the first platform. Reasons:

- Largest install base among engineering teams
- Real-time Search API is the clearest compliance path
- Ecosystem consensus (Glean, Rovo, Dust all pivoting to RTS) validates the approach
- Teams and Discord are Phase 2 and Phase 3 respectively

### Architecture for Phase 1 (Slack RTS)

```
SlackConversationalProvider
  ├── Auth: OAuth 2.0, user token preferred (for private channel search)
  ├── Pattern: Real-time Search API (assistant.search.context)
  ├── No persistent message body storage
  ├── Query-time retrieval only (no sync runner)
  └── Returns: ConversationalChunkResult with full provenance metadata

ConversationalSearchMode
  ├── Mode A: Find (hybrid, decision-confidence reranking)
  └── Mode B: Explore (dense, temporal clustering)

knowledge.conversational_search (new MCP tool)
  ├── Parameters: query, channelFilter?, afterDate?, beforeDate?, mode ("find" | "explore")
  └── Returns: ConversationalSearchResult[] with thread permalinks and provenance
```

**Key architectural difference from KB providers**: The existing `KnowledgeSourceProvider` interface uses `listDocuments()` + `runSync()` for pull-based batch ingestion. Slack RTS does not fit this pattern — it is query-time retrieval, not batch sync. A `ConversationalSourceProvider` interface should be defined alongside `KnowledgeSourceProvider`:

```typescript
interface ConversationalSourceProvider {
  sourceType: "slack" | "teams" | "discord";
  sourceName: string;

  /**
   * Search for conversational threads relevant to a query.
   * Returns results live from the platform; no local storage of message bodies.
   */
  search(
    query: string,
    options?: ConversationalSearchOptions
  ): Promise<ConversationalSearchResult[]>;
}

interface ConversationalSearchOptions {
  channelFilter?: string[];
  afterDate?: Date;
  beforeDate?: Date;
  mode: "find" | "explore";
  maxResults?: number;
}

interface ConversationalSearchResult {
  threadUrl: string;
  threadSummary: string; // first message or LLM summary
  rootAuthor: string;
  participantCount: number;
  threadStarted: Date;
  threadLastActivity: Date;
  channelName: string;
  relevanceScore: number;
  decisionConfidence?: number; // LLM-inferred, added post-retrieval
  hasResolution?: boolean; // LLM-inferred
}
```

### Auth plan

| Scenario                  | Token type | Scopes                                      | Setup                                                |
| ------------------------- | ---------- | ------------------------------------------- | ---------------------------------------------------- |
| Public channels only      | Bot token  | `search:read.public`                        | Simple; no user interaction                          |
| Public + private channels | User token | `search:read.public`, `search:read.private` | Requires per-user OAuth; preferred for full coverage |
| DMs                       | User token | `search:read.im`, `search:read.mpim`        | Excluded from Phase 1                                |

**Phase 1 auth choice**: Bot token with `search:read.public` scope. This covers the primary use case (Q&A and decision threads in public channels) without requiring per-user OAuth. Private channel support via user token can be added in Phase 2.

### Retrieval mode implementation

**Mode A (Find)**:

1. Call `assistant.search.context` with the user's query
2. Apply keyword boost if the query contains specific proper nouns (e.g., "tsyringe", "postgres")
3. Post-process results with a lightweight LLM call to classify `decisionConfidence` for top-5 results
4. Rerank by: `relevanceScore * 0.6 + decisionConfidence * 0.3 + recency * 0.1`
5. Return top-3 with full provenance metadata and thread permalink

**Mode B (Explore)**:

1. Call `assistant.search.context` with the user's query
2. Group results by `channelName` and time period (month-bucket)
3. If >10 results, apply LLM summarization to produce a topic-cluster summary per group
4. Return grouped results with temporal distribution visible to the caller

### First platform: Slack

Target the following channels for Phase 1 default scope:

- All public channels with `ask-*` naming pattern (Q&A channels)
- All public channels with `architecture`, `decisions`, `rfcs`, or `design` in the name
- Configurable channel allowlist in `.minsky/config.yaml`

### Configuration shape

```yaml
knowledgeBases:
  - name: "eng-slack"
    type: "slack" # new type value
    auth:
      token: "xoxb-..." # bot token for public channels
      # userToken: "xoxp-..."        # optional: user token for private channels
    conversational:
      channelAllowlist: # optional: specific channels to search
        - "C12345678" # channel IDs preferred over names
        - "C87654321"
      channelPatterns: # alternative: name-based patterns
        - "ask-*"
        - "*-decisions"
        - "*-architecture"
      excludeChannelTypes:
        - "dm"
        - "mpim"
      defaultMode: "find" # "find" | "explore"
      decisionClassification: true # run LLM decision-confidence classification
```

---

## 10. Follow-Up Tasks

Based on the Go recommendation, the following implementation tasks have been filed:

### mt#1039 — Slack Conversational Provider (Phase 1)

**Scope**: Implement `SlackConversationalProvider` using the Real-time Search API. New `ConversationalSourceProvider` interface alongside (not replacing) `KnowledgeSourceProvider`. New `knowledge.conversational_search` MCP tool with Find and Explore modes. Auth: bot token, public channels. Configuration schema extension.

**Dependencies**: mt#988 (Phase 2a) for output shape compatibility, mt#896 (TokenProvider Phase 2) for auth token management.

**Sizing**: ~2 weeks. ~8–12 files across domain/knowledge, adapters/shared/commands/knowledge, configuration.

**Go/no-go gate**: Successful retrieval of a known decision thread from a test workspace using the RTS API, with correct provenance metadata populated, plus ≥30% top-3 retrieval accuracy against a ≥50-decision evaluation set.

### mt#1040 — Conversational Reconciliation Adaptations (Phase 2)

**Scope**: Extend Phase 2b reconciliation (mt#1027) with temporal override rule and epistemic state metadata for conversational chunks. Requires Phase 2b to be shipped first.

**Dependencies**: mt#1027 (Phase 2b), mt#1039 (Slack Phase 1).

**Sizing**: ~1 week. Modification to existing reconciliation layer.

---

## 11. Deferral Criteria (For Revisiting If Blocked)

If the recommendation cannot proceed, the explicit conditions for revisiting are:

1. **Slack ToS compliance path closes**: If Slack revokes third-party RTS API access or imposes prohibitive usage terms on the RTS API (as they did with bulk indexing), the Slack path would close. Revisit if a compliant API path re-opens.

2. **Phase 2a (mt#988) is indefinitely blocked**: The output shape compatibility with conversational provenance metadata depends on Phase 2a's freshness/authority shape being stable. If Phase 2a is blocked >3 months, conversational Phase 1 can proceed with a standalone output shape that is later aligned.

3. **Evaluation against retrieval baselines fails**: If a structured evaluation (>50 known decisions from test Slack workspace) shows <30% top-3 retrieval accuracy with the RTS API, the platform constraint (no bulk indexing = limited ranking control) may make the use case unsatisfiable. In this case, defer until Slack provides better ranking controls or a Marketplace path becomes viable.

---

## References

- Glean Slack RTS connector documentation: [https://docs.glean.com/connectors/native/slack/setup/slack-rts-connector/home](https://docs.glean.com/connectors/native/slack/setup/slack-rts-connector/home)
- Glean: Federated vs indexed enterprise AI: [https://www.glean.com/blog/federated-indexed-enterprise-ai](https://www.glean.com/blog/federated-indexed-enterprise-ai)
- Guru Slack source setup: [https://help.getguru.com/docs/setting-up-slack-as-a-source](https://help.getguru.com/docs/setting-up-slack-as-a-source)
- Notion AI Slack connector: [https://www.notion.com/help/notion-ai-connectors-for-slack](https://www.notion.com/help/notion-ai-connectors-for-slack)
- Slack API terms update (May 2025): [https://docs.slack.dev/changelog/2025/05/29/tos-updates/](https://docs.slack.dev/changelog/2025/05/29/tos-updates/)
- Slack Real-time Search API: [https://docs.slack.dev/apis/web-api/real-time-search-api/](https://docs.slack.dev/apis/web-api/real-time-search-api/)
- Slack conversations.history method: [https://docs.slack.dev/reference/methods/conversations.history/](https://docs.slack.dev/reference/methods/conversations.history/)
- Snyk: From Slack threads to structured knowledge: [https://snyk.io/articles/from-slack-threads-to-structured-knowledge-implementing-rag-at-snyk/](https://snyk.io/articles/from-slack-threads-to-structured-knowledge-implementing-rag-at-snyk/)
- Atlassian Rovo: Slack connector federated pivot (Oct 2025): [https://support.atlassian.com/organization-administration/docs/connect-slack-to-rovo/](https://support.atlassian.com/organization-administration/docs/connect-slack-to-rovo/)
- Discord Message Content Privileged Intent: [https://support-dev.discord.com/hc/en-us/articles/4404772028055-Message-Content-Privileged-Intent-FAQ](https://support-dev.discord.com/hc/en-us/articles/4404772028055-Message-Content-Privileged-Intent-FAQ)
- Microsoft Teams RSC permissions: [https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- Chunking for RAG (Weaviate): [https://weaviate.io/blog/chunking-strategies-for-rag](https://weaviate.io/blog/chunking-strategies-for-rag)
- Anthropic Contextual Retrieval: [https://www.anthropic.com/news/contextual-retrieval](https://www.anthropic.com/news/contextual-retrieval)
