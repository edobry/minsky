# Implement chunked embeddings across similarity infra

## Context

Large specs exceed model limits and a single-vector per document reduces recall. We need chunked embeddings with overlap, integrated into our general similarity service and compatible with future reranking (`md#446-extract-generic-similarity-search-service-with-pluggable-backends-and-fallback-chain.md`).

## Summary

Add tokenizer-based chunking and per-chunk storage for tasks first, then rules, with aggregation in search. Provide CLI flags and defaults; preserve staleness skipping and retries.

## Acceptance Criteria

- Tokenizer-based chunking with overlap (default 1000/200) and per-chunk content_hash
- New chunk storage table with PK (task_id, chunk_id); upsert changed chunks, delete orphans
- Search retrieves by chunk and aggregates to task-level results with best-chunk info
- CLI supports `--use-chunks`, `--chunk-size`, `--chunk-overlap` on index and search
- Skips re-embedding when per-chunk content_hash/model unchanged; `--reindex` forces
- Tests cover chunking, skipping, aggregation, and CLI; docs updated

## Notes

- Phase 1: tasks; Phase 2: rules
- Integrate optional reranking from `md#446` after initial K retrieval
