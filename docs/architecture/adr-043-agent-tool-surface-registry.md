# ADR-043: One registry compiles the agent tool surface; the two shipped mechanisms become its outputs

**Status:** Proposed — 2026-08-18 (mt#4245, reconciling RFC 390937f0 Piece C1)

## Decision

**Build the capability registry as data plus a compiler, and make the two shipped mechanisms its
compilation targets rather than independent opinions. Do not build or adopt an MCP gateway.**

- `cockpit.drivenSession.mcpServers` is **retained as separate** — it answers "what does this
  installation provide," which is not the question C1 asks. It is not deleted.
- Agent-definition `tools:` is **retained as storage** — it stays the harness-native artifact, but
  becomes validated against, and eventually generated from, the registry.
- The declared capability set (C1) is **the source**, and earns its existence only by becoming what
  the other two compile from.
- **The escalation loop cannot get its signal from the harness.** Withholding an MCP tool is
  structurally silent, so RFC 390937f0's `capability.escalate` trigger must come from
  tool-emitted `CAPABILITY_REQUIRED` (mt#2588). Third-party MCP tools can emit neither, and that
  gap — not gateway convenience — is what would justify a credential broker later.

Accepting this ADR = agreeing that C1 ships as a compiler over the existing mechanisms, that no
runtime interposition is added, and that per-tool escalation coverage for third-party MCP servers
is knowingly deferred.

## Context

Three mechanisms independently answer "what tools does this agent have":

|                                    | Governs                           | Grain           | Where                       |
| ---------------------------------- | --------------------------------- | --------------- | --------------------------- |
| Agent-definition `tools:`          | dispatched subagents, by TYPE     | individual tool | `.minsky/agents/*/agent.ts` |
| `cockpit.drivenSession.mcpServers` | driven sessions, per INSTALLATION | MCP server      | cockpit config (mt#4239)    |
| Declared capability set (C1)       | any agent, per SESSION            | capability      | agent identity (ADR-006)    |

**Where `tools:` actually lives.** The authoritative site is `.minsky/agents/<name>/agent.ts` — a
`defineAgent({ tools: [...] })` call. `.claude/agents/*.md` is GENERATED from it by the compile
pipeline, so its frontmatter is an output, not a source. Earlier notes on this work (including
mt#4245's own spec) name the `.claude` path, because that is the file an agent reads at dispatch
time; both describe the same declaration, and anything that edits or validates it must target the
`.minsky` source.

RFC 390937f0 (Accepted 2026-07-01) already decided this belongs on identity; the two shipped
mechanisms were built without reference to it, because gate (p) could not see a Notion-hosted RFC
until mt#4244. The live incoherence: `.minsky/agents/reviewer/agent.ts` declares
`mcp__github__get_file_contents`, and a driven session running that agent type had no `github`
server at all until mt#4239 merged — a declaration naming a tool its substrate cannot provide,
undetected.

### What the harness actually offers (probed, not inferred)

The design turns on how Claude Code withholds a tool. Measured against `claude` 2.1.226; full
probe record in mt#4245 `## Premise probe results`.

| lever                                  | grain               | agent-visible signal when withheld      |
| -------------------------------------- | ------------------- | --------------------------------------- |
| `--mcp-config` / `--strict-mcp-config` | which SERVERS load  | none — tool is simply absent            |
| deny rule, **bare** tool name          | one tool, or a glob | none — removed from context             |
| deny rule, **scoped** (`Bash(rm *)`)   | one call shape      | `permission_denials` in the result JSON |

`--disallowedTools` and settings `permissions.deny` are equivalent; the axis is bare-vs-scoped.
**MCP rules have no scoped form** — per `code.claude.com/docs/en/permissions`, an MCP rule is a
server name "optionally followed by the name of a tool from that server." Verified live: denying
`mcp__minsky__tasks_get` removed it from the child's registry entirely (its siblings from the same
server stayed visible) and produced `permission_denials: []`.

Two consequences follow, and they drive the decision:

1. **Enforcement grain for MCP is (server, tool) and can be no finer.** A registry may name
   capabilities, but what it can _emit_ bottoms out at a tool name.
2. **Withholding an MCP tool is unobservable to the agent that lost it.** There is no denial event,
   so no harness-side signal exists to escalate on.

## Consequences

### The registry compiles to three surfaces

Capability → set of `(server, tool)` pairs. From that one declaration:

- **driven-session spawn** — the `--mcp-config` server set is the union of servers over the
  capability's tools; tools inside a loaded server that the capability excludes become deny rules.
- **subagent dispatch** — the frontmatter `tools:` list is checked against, and later generated
  from, the same pairs.
- **Minsky's own MCP daemon** — where `_meta["io.minsky/agent_id"]` already arrives on every call,
  so policy can be enforced server-side rather than in argv. This is the seam RFC 34c937f0's
  policy layer already claims; the registry supplies its input rather than competing with it.

### Why not a gateway

A gateway is a data-plane answer for operators who do not control their agents' launch. Minsky
controls the spawn argv of every agent it runs, so policy belongs at that control-plane moment. The
migration cost is also concrete: 23 files across `.minsky/rules`, `.claude/agents`, `.minsky/hooks`
and `.claude/skills` reference `mcp__github__*` literally across 16 distinct tool names, and any
gateway that renames tools on re-exposure invalidates all of them at once.

### What this knowingly does not cover

Sorting the tool surface by whether a withheld tool can produce an escalation signal:

| tool class                                   | signal when access is withheld                                            |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| built-in (`Bash`, `Read`, …)                 | `permission_denials`, via a scoped rule                                   |
| Minsky MCP tools                             | tool-emitted `CAPABILITY_REQUIRED` (mt#2588) — Minsky is in the call path |
| **third-party MCP tools** (`github`, Notion) | **neither** — removed silently, and Minsky is not in the call path        |

The third row is uncovered by this decision. It is the honest trigger for a credential broker
(RFC 390937f0's Piece C2 territory), alongside multi-machine operation and per-agent upstream
identity — not the token-management convenience that off-the-shelf gateways advertise.

**This also revises an earlier proposal.** A staged plan considered in mt#4245 would have enforced
Stage 1 with `--disallowedTools` masking and triggered Stage 2 by harvesting `permission_denials`.
Those two choices are incompatible: the masking generates no denial event, so the harvest would have
returned empty — exit 0, `is_error: false`, nothing to notice. Every motivating incident in
RFC 390937f0 is an MCP tool, so that harvest would have covered none of them.

### Immediate, independent of the registry

The declaration/substrate mismatch becomes detectable now:
`scripts/check-agent-tool-provisioning.ts` resolves every `mcp__<server>__<tool>` an agent
definition declares against the server set driven sessions actually provision, and fails on a
mismatch. It retires the observed failure class on its own, and does not depend on C1 shipping.

A withheld MCP tool presents to the agent exactly as a dead server does — the same
`No such tool available` string mt#3779 traces to four distinct causes. This check removes one of
them from the guessing game by catching it before it ships.

## References

- RFC 390937f0 — Capability-escalation loop (Accepted); Piece C1 is the decision this implements
- RFC 34c937f0 — policy layer for agent-agnostic enforcement (mt#762); the daemon-side seam
- ADR-006 (agent identity), ADR-038 (local shared MCP daemon), ADR-042 (gate-battery enforcement)
- mt#4245 (this reconciliation, and the probe record), mt#2587 (RFC umbrella), mt#2588 (Phase 2
  signal), mt#4239 (the config key), mt#3435 (accepted risk whose Option 2 these probes retire),
  mt#3779 (the `No such tool available` family)
- `code.claude.com/docs/en/permissions`, `code.claude.com/docs/en/cli-reference`
