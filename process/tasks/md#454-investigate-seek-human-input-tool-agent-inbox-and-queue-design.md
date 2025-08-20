# Investigate "Seek Human Input" / "Ask Expert" Tool and Agent Inbox Pattern; Queue and Turn-Taking Design

## Status
TODO

## Priority
HIGH

## Category
RESEARCH / ARCHITECTURE

## Context

We want a first-class way for agents to explicitly request human help ("seek human input" / "ask expert"). These requests should be captured in a durable queue (initially in our database) and be discoverable and respondable via the CLI. This aligns with the broader need for a persistent conversation history, clear turn-taking semantics (who speaks/acts next), and potential integration with an inbox-like UI pattern as popularized by agentic frameworks.

Related existing work in this repository already explores conversation history, multi-agent messaging, and subagents:

- Conversation history and execution recording are planned in Phase 6 of the subagent system task.
  - See `md#441-implement-mcp-based-subagent-system-with-task-graph-integration.md` (Conversation History deliverables)
- A general multi-agent messaging architecture with persistent threads, rolling summaries, and multi-party roles is outlined in `md#327-analyze-and-architect-general-message-prompt-system-supporting-human-and-ai-agents-across-contexts.md`.
- Shared DB service extraction and task metadata storage are tracked in `md#315` and `md#407` and may provide the foundation for an initial queue table.
- Multi-layered agent memory (Task `md#279`) may inform how human-expert interactions are summarized and fed back into memory.

External patterns worth studying for an inbox-style experience and human-in-the-loop workflows:

- Agent Inbox / EAIA setup instructions and patterns:
  - Notion guide on working with an AI Email Assistant: [`How to hire and communicate with an AI Email Assistant`](https://mirror-feeling-d80.notion.site/How-to-hire-and-communicate-with-an-AI-Email-Assistant-177808527b17803289cad9e323d0be89)
  - LangChain Agent Inbox repo: [`langchain-ai/agent-inbox`](https://github.com/langchain-ai/agent-inbox/blob/main/README.md)
  - EAIA integration docs: [`executive-ai-assistant#Set up Agent Inbox with Local EAIA`](https://github.com/langchain-ai/executive-ai-assistant#set-up-agent-inbox-with-local-eaia)

## Objectives

1. Define the problem and desired behavior of a "seek human input" / "ask expert" tool including lifecycle states, turn-taking, and visibility.
2. Propose an MVP queue design in our DB (single table initially) to capture and manage human-help requests linked to tasks/sessions/threads.
3. Specify initial CLI workflows to list, query, claim, respond, and resolve items in the queue (research/spec only, no code).
4. Evaluate integration paths with conversation history, turn-taking, and multi-agent messaging (Tasks `md#327`, `md#441`, `md#279`).
5. Research idiomatic implementations in current agentic ecosystems (LangGraph Agent Inbox, LangChain, Vercel AI SDK, or simple DIY) and document trade-offs.
6. Assess conceptual overlap with the MCP-based subagent system (Task `md#441`) to reuse schemas, infra, and execution-history patterns.

## Scope

Research/documentation only. No implementation or migrations in this task.

## Research Questions

- Concept model
  - What are the core entities of a human input request? (request, requester agent, target audience/expert, context links, status, ownership/assignee)
  - How do we represent turn-taking/"whose turn" semantics explicitly? e.g., a field indicating the current expected responder: `human | agent | subagent`.
  - How do we attach requests to existing contexts: task (`md#NNN`), session, PR, or a conversation thread (`md#327`)?

- Queue and lifecycle
  - Minimal viable lifecycle: `OPEN → CLAIMED → RESPONDED → CLOSED` (with optional `CANCELLED`/`EXPIRED`).
  - Ownership: how do humans "claim" items to avoid duplicate effort? Do we need `assignee`, `claimed_at`, `respond_by` deadlines, and `priority`?
  - Auditability: what metadata is required to reconstruct decision trails (timestamps, actor identities, message references)?

- CLI UX (initial)
  - Listing and filtering: `minsky inbox list --status open,claimed --task md#123 --json`.
  - Inspect an item: `minsky inbox get <id> [--json]`.
  - Claim/release: `minsky inbox claim <id>` / `minsky inbox release <id>`.
  - Respond: `minsky inbox respond <id> --message "text" [--attach <file>]`.
  - Close/reopen: `minsky inbox close <id>` / `minsky inbox reopen <id>`.
  - Note: These are specification targets only, to be validated against our command organization and dry-run first policies.

- Conversation history and turn-taking
  - Can we reuse `md#327` message/thread model as the canonical store for conversation artifacts, with the queue holding pointers?
  - How do we model expected next actor (turn owner) at the thread level vs. per-item level?
  - How does this integrate with `md#441` conversation database and execution recording for subagents?

- Ecosystem patterns and libraries
  - Agent Inbox (LangGraph) suitability for human triage and responses; how their linking of graph runs to inbox is modeled.
  - LangChain abstractions vs. DIY: criteria (complexity, lock-in, visibility, portability, local-first).
  - Vercel AI SDK feasibility for a lightweight inbox/dashboard or queue consumer.
  - Migration path from CLI-only to optional UI without changing underlying data model.

- Subagents overlap (Task `md#441`)
  - Treat "ask expert" as a specialized subagent handoff or a tool that enqueues and sets turn to human.
  - Reuse MCP tool schema patterns for request envelopes, metadata, and result recording.
  - Ensure execution history and conversation traces unify across AI and human participants.

## Proposed MVP Data Model (for evaluation)

Non-binding strawman schema for research discussion (final shape to be decided in follow-up tasks):

```
human_help_requests (
  id UUID PK,
  created_at TIMESTAMPTZ,
  created_by TEXT,                 -- agent identity
  status TEXT,                     -- open|claimed|responded|closed|cancelled
  turn_owner TEXT,                 -- human|agent|subagent
  priority TEXT,                   -- low|normal|high (optional)
  title TEXT,
  message TEXT,                    -- request payload
  context JSONB,                   -- links: taskId, sessionId, prNumber, threadId
  assignee TEXT,                   -- optional human owner
  claimed_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  metadata JSONB                   -- extensibility
)
```

Notes:
- Prefer linking to a canonical `threadId` if we adopt `md#327` messaging as the single source of truth for conversation history; queue row serves as a surfaced action item.
- `turn_owner` conveys immediate expectation on who should act next.

## Evaluation Criteria

- Alignment with `md#327` message architecture for durable history and cross-context linking
- Compatibility with `md#441` conversation DB and execution tracing
- MVP feasibility using existing shared DB plans (`md#315`, `md#407`) without premature complexity
- Clear, minimal CLI surface area that supports non-destructive, dry-run-first behavior
- Clean path to an inbox UI (Agent Inbox-like) without changing the data model

## Deliverables (Research Only)

1. A short decision brief comparing: LangGraph Agent Inbox, LangChain, Vercel AI SDK, and a DIY approach for our needs (pros/cons, complexity, lock-in, observability).
2. A refined data model and lifecycle diagram incorporating turn-taking semantics and conversation-thread linkage.
3. A proposed CLI UX spec and help text outline for the inbox queue.
4. An integration plan mapping queue items to `md#327` threads and `md#441` conversation/event records.
5. A follow-up implementation task breakdown (separate tasks), including DB migrations, CLI subcommands, and testing strategy.

## Dependencies / Related Work

- `md#327`: Multi-Agent Collaborative Messaging Architecture
- `md#441`: MCP-Based Subagent System (Conversation History, OODA loop)
- `md#315`: External Task Database / Metadata Storage
- `md#407`: Shared DB Service for Sessions, Tasks, Embeddings
- `md#279`: Multi-Layered Agent Memory System

## Risks & Considerations

- Overlapping storage concerns between queue entries and conversation messages; must avoid duplication by treating queue as a projection on threads/messages.
- Clarity of ownership and SLAs to prevent stale requests; need simple escalation/notifications (out of scope to implement here).
- Vendor lock-in vs. portability; prefer neutral core model with adapters for external inbox UIs.

## Out of Scope

- No code, migrations, or CLI implementation in this task.
- No UI implementation; future work may add an inbox UI reusing the same data model.

