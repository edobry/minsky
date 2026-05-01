# mt#1526 — Agent Inbox Ecosystem Comparison

**Status:** Initial sweep complete. Recommendation grounded in the Shape B v1 surface that shipped via mt#1456 / mt#1457 / mt#1458 / mt#1470 and the AskState lifecycle in mt#1235.

**Companion task:** mt#1526 (this brief) is one of five research children of mt#454. Sibling tasks own data-model refinement (mt#1528), CLI UX spec (mt#1529), and mt#327 integration (mt#1531). The implementation breakdown task (mt#1532) consumes all four.

## Goal

Decide whether v1 inbox UX should adopt one of the existing frameworks or stay DIY. Output is a comparison brief plus a recommendation; no implementation, no migrations.

## What's already shipped (the DIY baseline)

Before evaluating external frameworks, take an honest inventory of what Minsky already has. The DIY position is not "build from scratch" — it is "extend what's already on main."

- **Persistence**: Drizzle-backed `asksTable` ([`src/domain/storage/schemas/ask-schema.ts`](../../src/domain/storage/schemas/ask-schema.ts)) with the full lifecycle columns (state, routedAt, suspendedAt, respondedAt, closedAt, response JSONB, metadata JSONB).
- **Domain contract**: `AskRepository` interface ([`src/domain/ask/repository.ts`](../../src/domain/ask/repository.ts)) with create / getById / listByParentTask / listByState / transition / respond / close / respondAndClose / findOpenByTaskIds. DrizzleAskRepository for prod, FakeAskRepository for tests.
- **State machine**: [`src/domain/ask/state-machine.ts`](../../src/domain/ask/state-machine.ts) with `VALID_TRANSITIONS`, `guardTransition`, `isTerminal`, `TERMINAL_ASK_STATES`. Single source of truth (mt#1470).
- **Lifecycle**: `detected → classified → routed → suspended → responded → closed`, plus terminal `cancelled` and `expired`. State-machine-aware re-entry (mt#1457 R1) so dispatchers can be idempotent.
- **Transports**: subagent (mt#1070), elicitation (mt#1457) with capability-aware routing (mt#1456 ClientCapabilityRegistry).
- **CLI surface (v1)**: `minsky asks list` (mt#1240), `minsky asks create` (mt#1456), `minsky asks respond` (mt#1458). Producer + observer + consumer loop is closed.
- **Reconciler-driven side effects**: post-response notifications (mt#1240), wake-on-respond (mt#1481).
- **Render-time enrichment**: `tasks_list` BLOCKED-subtype enrichment via batch `findOpenByTaskIds` (mt#1470).

What is **missing** at the DIY baseline, relative to a richer inbox UX:

- A web UI (we have CLI only).
- Multi-operator concurrency primitives (claim / release / assignee).
- Soft / hard deadline modeling beyond the existing `deadline` column.
- An escalation / notification framework for missed deadlines.
- Saved filters / custom views.

## Candidate 1 — LangGraph Agent Inbox

**What it is.** Open-source UI ([langchain-ai/agent-inbox](https://github.com/langchain-ai/agent-inbox)) for rendering and responding to LangGraph workflow interrupts. The inbox surfaces `interrupt()` calls from LangGraph runs as cards; an operator clicks through, responds, the workflow resumes from the checkpoint.

**Architectural model.** Tied to LangGraph's runtime: agents are state graphs; HITL is `interrupt()` mid-graph; state is checkpointed (Postgres or local) so the runtime can resume after the operator response. The inbox UI is a thin React client over LangSmith's API or a self-hosted LangGraph deployment.

**Native ask-kind coverage.**
| Kind | Handles natively? | Adapter glue required |
|---|---|---|
| `direction.decide` | Yes | Maps to `interrupt()` with `Command.resume(value)`. |
| `authorization.approve` | Yes | Same shape — interrupt + boolean resume. |
| `quality.review` | Partial | Body content fits, but multi-round review (R1 → fix → R2) requires re-entering the graph; with the current AskState lifecycle (terminal `closed` only — no `reopened`), each new review round is a fresh `Ask` referencing the prior one via `metadata`. That referencing pattern is more natural to express in our domain than as a re-interrupt. |
| `capability.escalate` | No | LangGraph interrupts are operator-pause-and-resume; capability escalation is agent-to-agent dispatch, not a HITL pause. |
| `coordination.notify` | No | One-way notification doesn't fit the resume model. |
| `information.retrieve` | No | Routed to retriever transport (mt#1448), not operator. |
| `stuck.unblock` | No | Same as escalation — agent-to-agent. |

**Adapter point.** Two viable adapters, neither cheap. (a) `Ask` (`detected → routed`) → emit a LangGraph `interrupt({ value: { kind, title, question, options, contextRefs, askId } })` on a sidecar graph; the response from `Command.resume(value)` calls back into `respondToAsk` to advance AskState (`responded → closed`). (b) Port AskRepository to back LangGraph's checkpointer interface, so AskState transitions _are_ LangGraph state edits. Path (a) creates two sources of truth (sidecar graph state + AskRepository); path (b) inverts the architecture and imposes the LangGraph runtime on every Ask, including ones that have nothing to do with HITL.

**Integration cost.**

- The runtime mismatch is severe: LangGraph expects state graphs with checkpoints; Minsky has DI-wired domain services with explicit transitions through AskRepository.
- The UI is React + LangSmith API; self-hosting is documented but adds an OAuth + LangSmith proxy concern.
- License is MIT, no immediate lock-in concern, but the architectural lock-in (commit to LangGraph runtime) is real.

**Pros / cons.**

- **+** Ready-made UI with accept / reject / edit / respond actions.
- **+** Active development, well-known in the LangChain ecosystem.
- **−** Forces a runtime model that doesn't match Minsky's current architecture.
- **−** Native coverage is only 2/7 ask kinds (4 if we stretch the definition).
- **−** Adds a second persistence + state authority alongside AskRepository.

## Candidate 2 — LangChain abstractions

**What it is.** Pre-LangGraph LangChain offered HITL through manual prompt-level patterns: `RunnableWithMessageHistory`, `ConversationBufferMemory`, callback hooks. Modern LangChain has largely deferred HITL to LangGraph.

**Architectural model.** Library-of-abstractions, not a runtime. Useful for conversation history, prompt templating, callbacks. None of these are inbox-shaped.

**Native ask-kind coverage.** None. LangChain doesn't define an inbox primitive.

**Adapter point.** If we wanted to use LangChain's conversation primitives (`BaseChatMessageHistory`, `RunnableWithMessageHistory`) for the future thread / conversation context that mt#1531 will design, the adapter would be: `Ask` row → sequence of `BaseMessage` objects (HumanMessage for the question, AIMessage for the response payload, with `Ask.metadata` projected into `additional_kwargs`). This is an inbox-adjacent integration, not an inbox solution.

**Integration cost.** Library import only; no runtime to spin up. The cost is the message-shape adapter and a decision about whether LangChain conversation memory or our own `Ask.response` JSONB is the SoT. Since it doesn't answer the inbox question, the cost is mostly avoidable.

**Pros / cons.**

- **+** No runtime lock-in (it's a library, not a framework).
- **+** Conversation primitives might be useful for mt#1531.
- **−** Doesn't actually answer the inbox question — defers to LangGraph.
- **−** Considered as a standalone HITL path, it's less complete than the Agent Inbox path.

## Candidate 3 — Vercel AI SDK

**What it is.** Frontend-focused SDK ([vercel/ai](https://github.com/vercel/ai)): `useChat` hook, streaming chat UIs, RSC integrations, tool-call resumption patterns. Designed for product chat UIs (assistants, support bots), not inbox surfaces.

**Architectural model.** Lives at the UI / API edge. Has no opinion about state authority — bring your own backend. Good at rendering streaming completions and tool calls; doesn't model durable queues.

**Native ask-kind coverage.** Zero — the SDK is a UI rendering layer, not a queue / state model. We would build the inbox surface ourselves; the SDK only helps at render time.

**Adapter point.** If we built a web inbox on top of `useChat`, the adapter would be: `Ask` row → `Message[]` shape (`{ id, role, content, parts, toolInvocations }`) for `useChat`'s state, plus a `/api/inbox/respond` endpoint that wraps `respondToAsk` and returns the canonical `Ask` shape. The `parts` field could carry `Ask.options`, `Ask.contextRefs`, and reconciler-emitted side-effect summaries. This is a UI-layer adapter only — state authority stays with `AskRepository`.

**Integration cost.**

- Building a web inbox UI on top of our existing AskRepository is feasible with this SDK, but the SDK doesn't reduce the inbox-specific work — only the chat-rendering work.
- Pulls a Next.js / React stack assumption that we don't currently have. Adds a frontend toolchain.

**Pros / cons.**

- **+** Lightweight, no runtime lock-in.
- **+** Modern React patterns, good for a future product UI.
- **−** Doesn't reduce the inbox-specific work; only helps at the render layer.
- **−** Adds a frontend stack we don't currently maintain.

## Candidate 4 — DIY (extend what's on main)

**What it is.** Continue building on the AskRepository / AskState surface that already shipped. Add the missing pieces (multi-operator concurrency, deadline modeling, escalation, optional web UI) as they're needed.

**Architectural model.** Already established and load-bearing. AskRepository is the SoT; AskState encodes lifecycle; transports plug into the same contract. mt#1531 will graft thread / conversation context on top. mt#1528 will add multi-operator concurrency primitives.

**Native ask-kind coverage.** All 7 (we built it).

**Integration cost.** Zero integration cost (it's the baseline). What's left is the _missing_ surface area listed above — most of which is sibling-task work in mt#454's children.

**Pros / cons.**

- **+** Zero lock-in. Full control. AskState is already shipped and battle-tested.
- **+** Native coverage of every ask kind.
- **+** Incremental: each missing feature can be added when there's a concrete consumer.
- **−** We own the bugs and the build cost for the UI when it lands.
- **−** No reference UI to anchor designers / reviewers against.
- **−** Risk of surface-area drift between CLI and a future web UI if not specced together (mt#1529 mitigates this).

## Comparison matrix

| Dimension                   | LangGraph Agent Inbox                                                                                                             | LangChain            | Vercel AI SDK           | DIY                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------- | --------------------------------- |
| Complexity (integration)    | High — port or adapter                                                                                                            | Low (libraries only) | Medium (frontend stack) | Lowest (already shipped)          |
| Lock-in                     | Architectural (runtime)                                                                                                           | Library-only         | Library-only            | None                              |
| Observability               | LangSmith-native                                                                                                                  | Callback hooks       | None native             | Existing logs + reconciler events |
| Local-first compatibility   | Self-host possible, OAuth concerns                                                                                                | N/A (library)        | Yes                     | Yes (already local)               |
| Ask-kind native coverage    | 2/7 (4/7 stretched)                                                                                                               | 0/7                  | 0/7                     | 7/7                               |
| Adapter point               | Two paths: AskState → LangGraph interrupts (sidecar SoT) OR port AskRepository to LangGraph checkpointer (architecture inversion) | N/A                  | UI layer only           | None needed                       |
| Existing surface preserved? | No (parallel SoT)                                                                                                                 | Yes                  | Yes                     | Yes                               |
| Path to UI                  | Built-in                                                                                                                          | Roll your own        | Roll your own           | Roll your own                     |

## Recommendation

**Stay DIY for v1, with specific borrows from the LangGraph Agent Inbox playbook.**

The DIY position is not "build everything ourselves." It's "the SoT is AskRepository / AskState; UI candidates plug _into_ that, not over it." Concretely:

1. **Borrow Agent Inbox's UX taxonomy** (accept / reject / edit / respond) when mt#1529 specs the post-v1 verb set. The shape works; it's been validated by LangChain's user base. Map it onto our state machine.
2. **Borrow Agent Inbox's "human action types" categorization** (response, approval, edit, ignore) when mt#1528 refines the data model. The categorization aligns with our ask kinds and gives the future UI a natural rendering hook.
3. **Reject the LangGraph runtime model.** Adopting it would invert Minsky's architecture, fork persistence, and produce two sources of truth.
4. **Do not commit to Vercel AI SDK yet.** It's a fine choice when we get to a web UI — but that's deferred to mt#1532's implementation breakdown. Premature commitment to a frontend stack would constrain the impl tasks unnecessarily.

### Specific risks of the DIY path

1. **UI build cost will land in one place, eventually.** We will need a web inbox at some point; deferring it doesn't make it cheaper. mt#1532 should size this honestly.
2. **Surface drift between CLI and web UI.** Once a second client exists, every Ask field is a coordination point. Mitigation: mt#1529 specs the canonical CLI surface first; the web UI mirrors it rather than diverging.
3. **No community pull-in for inbox-specific features.** Escalation, deadlines, priority queues, batch ops — every one of these is well-trodden in the agentic ecosystem. We'll re-invent whatever we don't borrow explicitly.
4. **Ecosystem changes.** If LangGraph Agent Inbox or a successor becomes the _de facto_ substrate for agentic HITL UIs, the cost of staying DIY rises over time. Re-evaluate annually or when Minsky moves to multi-host / multi-tenant deployment.

### When to revisit

Re-run this comparison if:

- Minsky moves from single-developer / single-host to multi-tenant or multi-operator at scale.
- A competing standard for "agent inbox protocol" emerges (analogous to MCP for tools or A2A for agent-to-agent — see mt#953 ecosystem survey for prior-art on protocol convergence).
- The cost of building / maintaining our own UI exceeds the integration cost of adopting Agent Inbox or a successor (signal: more than ~3 months of full-time UI work without product traction).

## Out of scope for this brief

- Detailed schema mappings beyond AskRepository (covered by mt#1528).
- CLI verb design (covered by mt#1529).
- Multi-host inbox routing (covered by mt#1531 and the eventual implementation breakdown).
- The implementation task list itself (covered by mt#1532).

## References

- LangGraph Agent Inbox: [`langchain-ai/agent-inbox`](https://github.com/langchain-ai/agent-inbox)
- EAIA integration: [`executive-ai-assistant#Set up Agent Inbox with Local EAIA`](https://github.com/langchain-ai/executive-ai-assistant#set-up-agent-inbox-with-local-eaia)
- Notion guide on the AI Email Assistant pattern: [How to hire and communicate with an AI Email Assistant](https://mirror-feeling-d80.notion.site/How-to-hire-and-communicate-with-an-AI-Email-Assistant-177808527b17803289cad9e323d0be89)
- Vercel AI SDK: [`vercel/ai`](https://github.com/vercel/ai)
- Minsky internal: ADR-008 attention-allocation subsystem (mt#1034); slim research output in mt#454 spec (2026-05-01).
