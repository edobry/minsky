# Implement embedding-based rule suggestion (replace AI-based) reusing tasks embeddings infra

## Context

## Summary
Implement embedding-based rule suggestion for `minsky context suggest-rules`, replacing the current AI-completion approach. Reuse the existing embeddings + vector storage infrastructure built for tasks (pgvector-backed, in-memory fallback), and introduce a `rules_embeddings` index plus an indexer command.

## Motivation
- Current rule suggestion relies on AI completion over full rule descriptions; this is costlier and scales poorly.
- We already have proven embeddings infra for tasks. We want consistent, low-latency retrieval for rules using the same patterns.
- This change enables deterministic, instant prefiltering without prompting overhead.

## Scope
- Create `rules_embeddings` storage parallel to `tasks_embeddings` (same dimension, vector ops, timestamps)
- Add rules embedding indexer command: `minsky rules index-embeddings` (embeds rule descriptions or concise content)
- Update `context suggest-rules` to use embeddings-only retrieval by default
- Keep a graceful fallback path (keyword search) only when embeddings are absent/unavailable
- Configuration: reuse embeddings provider/model; allow table override if needed

## Out of Scope
- Neural reranking (tracked separately)
- Hybrid scoring (embeddings + AI reasoning)

## Phases
- Phase 1: Schema + storage + indexer (CLI) for rules embeddings
- Phase 2: Integrate `context suggest-rules` to use embeddings-only retrieval
- Phase 3: Observability and performance tuning (metrics, limits)

## Relationships
- Related: md#182 (AI-powered rule suggestion), md#082 (context analysis), md#253 (task embeddings infra)
- Follow-up: New tasks for cross-cutting reranking and generic similarity-service extraction

## Acceptance Criteria
- `rules_embeddings` table with pgvector and timestamps
- `minsky rules index-embeddings` indexes all current rules without errors
- `minsky context suggest-rules` retrieves via embeddings by default with configurable limits
- Keyword fallback works if embeddings not present
- Docs and help output updated

## Requirements

## Solution

## Notes
