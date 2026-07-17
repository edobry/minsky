# Ask-Permission Bridge (mt#2823)

PreToolUse hook on `Bash` + `mcp__minsky__session_exec` that lets an **operator-approved Ask
authorize the corresponding action** at the harness permission layer — closing the
double-approval round-trip where an approval routed through the Ask substrate still hit a
second, manual approval at the Claude Code auto-mode classifier (originating incident:
conversation c01f89af, 2026-07-13 — the operator approved a bulk mutation via an Ask and then
had to hand-type the literal command because the classifier cannot see Ask contents).

## Mechanism

1. **Issuance** — `bun scripts/grant-ask-action.ts --ask <askId> --command-exact "<cmd>"`
   (or `--command-pattern <regex>`; `--tool` defaults to `Bash`; `--ttl-minutes` defaults
   to 15). The script verifies the ask server-side BEFORE writing a grant to
   `~/.local/state/minsky/ask-grants.json` (`.minsky/hooks/ask-grant-store.ts` — the third
   instance of the ADR-028 D5/D8 file-based grant-store pattern, adding one-shot
   `consumedAt` marking). Overbroad patterns (fewer than 12 literal chars after stripping
   regex metacharacters) are refused — a `.*` grant would be a standing capability, which
   this store must never hold.
2. **Decision** — on a matching tool call, `ask-permission-bridge.ts` re-verifies the
   referenced Ask server-side via `minsky tools asks list` (`.minsky/hooks/ask-verification.ts`):
   the ask must exist among recent responded/closed asks, have kind `authorization.approve`,
   `response.responder === "operator"` (agent/policy/timeout responders refused — the
   self-respond vector), and an approving response value (`{ approved: true }`-shaped;
   conservative default is NOT approving — the inbox `{ message }` payload does not qualify,
   so approval flows through the cockpit's approve control).
3. **Allow** — the grant is consumed (one-shot, BEFORE the decision is emitted), a
   best-effort `hook.fired { decision: "overridden" }` audit event links askId → tool call,
   and the hook emits `permissionDecision: "allow"` with an audit reason naming the askId.

## Decision ladder (fail-safe by construction)

| Situation                                        | Outcome                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Subagent invocation (`agent_id` present)         | silent defer                                                                       |
| Tool not Bash/session_exec, or no command string | silent defer                                                                       |
| Grant store unreadable                           | defer + stderr warning                                                             |
| No matching unconsumed/unexpired grant           | silent defer (the common path)                                                     |
| Ask verification UNAVAILABLE (CLI/DB down)       | defer + warning — never allow on unverifiable state                                |
| Grant matched, ask verification NEGATIVE         | **DENY + loud warning** (fabrication signal; grant left unconsumed for inspection) |
| Grant matched, ask verified, consume race lost   | defer + warning                                                                    |
| Grant matched + verified + consumed              | **ALLOW** + audit                                                                  |

Per the vendor hook contract (https://code.claude.com/docs/en/hooks), exit 0 with no output
means "no decision" — the normal permission flow applies. The harness combines PreToolUse
decisions with deny outranking allow, so the bridge structurally cannot bypass other guards
(git/gh CLI ban, bypass-merge guard): it only preempts the permission classifier when no
other hook denies.

## Composition with mt#2819 (bulk mutations)

`tasks_bulk-edit`'s dry-run mints a scope token binding the approved change set; the
operator-facing Ask carries that token; the grant's command pattern includes the exact
execute command (token embedded), so the bridge allows only that execute call — and
mt#2819's server-side drift check remains an independent second control.

## Registration

Standalone `settings.json` matcher block (NOT `GUARD_REGISTRY`/dispatcher): the dispatcher's
deny-aggregation contract does not carry `permissionDecision: "allow"` outputs — mirrors
`parallel-work-guard.ts`'s standalone precedent. Source in `.minsky/hooks/`; compiled to
`.claude/hooks/` via `minsky compile --target claude-hooks`.

## Residual risk (tracked)

Responder attribution on ask responses is caller-supplied on every surface today (cockpit
resolve body, MCP `asks_respond` param) — the bridge's verification defeats accidental and
naive fabrication (random uuid, unresponded ask, non-approval value, agent-attributed
response) but not a deliberately forged `responder: "operator"` response. Authenticated,
server-ascribed responder attribution is **mt#2898**; when it lands, the bridge's check
becomes trustworthy with no bridge-side change. Until then every grant issuance, allow, and
the underlying ask row remain fully audited (store file + `hook.fired` event + permission
reason), so a forged approval is detectable after the fact even though not preventable.

## Cross-references

- mt#2823 — this hook's tracking task (spec carries the plan decision + vendor-doc citation)
- mt#2819 — bulk-mutation primitives (the dry-run token grants bind to)
- mt#2898 — authenticated responder attribution (residual-risk closure)
- mt#2587 — capability-escalation loop RFC (the authz-failure sibling; its Out-of-scope
  explicitly excludes harness-side classifier denials, which is exactly this hook's surface)
- ADR-028 D5/D8 — the grant-store pattern lineage
- memory `abd245dc` — auto-classifier denials are stateless (the incident class this closes)
- memory `95fa195c` — permission-denial-is-route-not-taken (the confused-deputy guardrail)
