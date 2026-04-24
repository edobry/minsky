# Agent Guidance Mechanisms: rules → skills → subagents

## The spectrum

Minsky uses three mechanisms to guide agent behavior, arranged by structural strength:

```
Rules → Skills → Subagents
weakest                strongest
```

| Mechanism                                            | What it is                                                                         | Failure mode                                                              | Best for                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Rule** (`.cursor/rules/`, CLAUDE.md, memory files) | Text guidance the agent should follow                                              | Easy to ignore as context fills; the agent can choose not to read it      | Always-on style/convention guidance the agent follows continuously                                           |
| **Skill** (`.claude/skills/`, slash commands)        | A reusable instruction template loaded into the _current_ conversation on demand   | Requires user invocation; same context as caller, so no fresh perspective | User-driven workflow expansion that needs the current conversation context                                   |
| **Subagent** (`.claude/agents/`)                     | An isolated worker with its own system prompt, tools, model, and **fresh context** | Requires the parent agent to choose to use it                             | Specialized work that benefits from a fresh perspective, is well-defined upfront, and produces a deliverable |

The deepest distinction: **skills are content, subagents are processes.** A skill loads instructions into the caller's context. A subagent is a separate worker that returns only its output.

## When to use which

- **Always-on guidance** (style, conventions, naming, anti-patterns to avoid) → **rule**
- **User-invoked context expansion** (commit, review-pr, plan) → **skill**
- **Main-agent-invoked specialized worker with fresh perspective** → **subagent**
- **User-invoked work that spawns a fresh worker** → **skill that launches a subagent**

## The verification principle

> **Verification by the doer is structurally weak.** Verification belongs in a subagent the doer invokes after declaring done, not in a rule the doer should remember.

The agent that did the work is biased toward "I did what was asked." A fresh agent comes to the question without that bias. This is why Minsky's verification infrastructure is subagent-based:

- **`refactorer`** subagent (`.claude/agents/refactorer.md`) — has a mandatory 7-question coherence verification protocol that runs after every structural change
- **`auditor`** subagent (`.claude/agents/auditor.md`) — reads the task spec, checks each success criterion against the current codebase, returns structured pass/fail

Both replace older rule-based verification protocols that asked the doer to check their own work.

## Hooks: the fourth mechanism

Hooks (`.claude/settings.json`) are a fourth mechanism that's structurally **even stronger than subagents** because they remove choice entirely — they fire automatically at lifecycle events, not at the agent's discretion.

Minsky's hook architecture:

| Hook                             | Event              | Purpose                                          | Blocks? |
| -------------------------------- | ------------------ | ------------------------------------------------ | ------- |
| `typecheck-on-edit.ts`           | PostToolUse        | Informational type checking with smart filtering | No      |
| `typecheck-on-stop.ts`           | Stop               | Full type check before returning to user         | Yes     |
| `typecheck-on-stop.ts`           | SubagentStop       | Full type check before subagent returns          | Yes     |
| `require-review-before-merge.ts` | PreToolUse (merge) | Blocks merging without a posted review           | Yes     |
| `check-prompt-watermark.ts`      | PreToolUse (merge) | Validates prompt watermark before merge          | Yes     |
| `validate-task-spec.ts`          | PreToolUse         | Validates task spec structure                    | Yes     |

Hooks can't detect semantic coherence (that requires understanding, not pattern matching), but they can enforce mechanical correctness (type checking, lint) and workflow invariants (review required).

## The strength ordering

```
Rules < Skills < Subagents < Hooks
(behavioral)  (invoked)  (structural)  (involuntary)
```

For any concern, use the **strongest mechanism that fits**. If you find yourself writing a rule that says "remember to check X after doing Y," ask: _should this be a subagent the doer invokes, or a hook that fires automatically?_

## Origin

This framework emerged from a specific failure during mt#348: a narrowly-scoped refactor subagent eliminated a class but left stale comments, redundant files, and dead exports. The rule-based prompt to "verify coherence" was forgotten. The fix was structural: bake verification into the agent's identity (the `refactor` subagent), not into a remembered prompt.

For the full analysis, see the Notion insight: [rules → skills → subagents — a structural strength spectrum](https://www.notion.so/33b937f03cb481d5900ecfa84b3c44ff).
