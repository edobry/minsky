# Explore OpenAI Batch API for Embeddings Indexing

## Status
BACKLOG

## Motivation
Indexing embeddings for many tasks can be slow and rate-limited when calling the embeddings API per-task. OpenAI's Batch API allows submitting large batches of API requests for asynchronous processing with better throughput and potentially lower cost.

## Goals
- Investigate feasibility of using OpenAI Batch API to submit embeddings generation in bulk
- Design a batching strategy (payload format, chunk sizes, retry behavior, idempotency keys)
- Evaluate end-to-end flow: enqueue batch, poll status, retrieve results, map back to task IDs, and write vectors into vector storage (pgvector)
- Compare performance and cost vs synchronous per-task API calls

## Scope
- Batch API usage specifically for embeddings requests (not completions)
- Integration concept with current `tasks.index-embeddings` command and `EmbeddingService`
- Does not implement production code yet; produces a design doc and a minimal prototype plan

## Acceptance Criteria
- Documented design covering:
  - Request format and headers for Batch submission for `/v1/embeddings`
  - Chunking logic and maximum batch size parameters
  - Status polling and result retrieval strategy
  - Error handling, partial failures, and retries
  - Mapping results to tasks and writing to `task_embeddings`
- Prototype plan for integrating with `EmbeddingService` (batch-aware implementation or separate BatchEmbeddingService)
- Risks and trade-offs (latency vs throughput, complexity, cost)
- Decision whether to proceed to implementation

## References
- OpenAI Batch API: https://platform.openai.com/docs/guides/batch
- Current tasks indexing: `tasks.index-embeddings` (session branch)
- Embeddings service: `src/domain/ai/embedding-service-openai.ts`
