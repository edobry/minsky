/**
 * Default `driven_sessions` harness/transport/auth-mode values (mt#4935, PR
 * #3595 R1 finding 3).
 *
 * The single source of truth for "claude-code" / "claude-stream-json" /
 * "subscription" — before this module existed, the same three literals were
 * independently authored in the schema's `.default(...)` calls, the 0117
 * migration's `DEFAULT '...'` clauses, `src/cockpit/driver-transport.ts`'s
 * `DEFAULT_HARNESS_KIND`/`DEFAULT_TRANSPORT_ID`/`DEFAULT_AUTH_MODE` constants,
 * and `ClaudeStreamJsonTransport`'s own `readonly id = "claude-stream-json"`.
 * Four authored copies of the same three strings is how they drift; this is
 * the one place a future default change has to touch.
 *
 * Domain-side (not cockpit-side) because the schema — which needs these for
 * its column defaults — lives here and cannot import from `src/cockpit/**`;
 * the cockpit-side constants (`driver-transport.ts`) re-export from this
 * module instead of declaring their own copies, and the migration SQL
 * restates the literals with a comment pointing back here (a raw `.sql` file
 * cannot `import` a TypeScript constant).
 *
 * @see mt#4935 — the drive record these default
 * @see ./driven-sessions-schema.ts — the schema that imports these
 * @see ../migrations/pg/0117_mixed_doctor_doom.sql — restates them for the backfill
 * @see ../../../../src/cockpit/driver-transport.ts — the cockpit-side re-export
 */

/** Which harness drives a session — `"claude-code"` today; `codex`,
 * `gemini-cli`, `opencode` are added by the ACP sibling (mt#4936) as they
 * are proven. */
export const DEFAULT_HARNESS_KIND = "claude-code";

/** The default `DriverTransport.id` (`src/cockpit/driver-transport.ts`) —
 * must match `ClaudeStreamJsonTransport.id` (`src/cockpit/claude-transport.ts`). */
export const DEFAULT_TRANSPORT_ID = "claude-stream-json";

/** The default credential/identity posture — `"subscription"` or `"api-key"`
 * (`DriverAuthMode`, `src/cockpit/driver-transport.ts`). */
export const DEFAULT_AUTH_MODE = "subscription";

/**
 * The `DriverTransport.id` for the Agent Client Protocol transport (mt#4936,
 * ADR-047) — must match `AcpTransport.id` (`src/cockpit/acp-transport.ts`).
 * Registered in `selectDriverTransport` (`src/cockpit/driven-session-host.ts`)
 * alongside {@link DEFAULT_TRANSPORT_ID}.
 */
export const TRANSPORT_ID_ACP = "acp";

/**
 * Harness kinds driven over the `acp` transport (mt#4936) — the non-Claude
 * ACP agents proven by the spike (`codex`, `@agentclientprotocol/codex-acp`)
 * and Claude Code driven over its own official ACP adapter under
 * `auth_mode: "api-key"` ONLY (`claude-code-acp`,
 * `@agentclientprotocol/claude-agent-acp` — never under `subscription`; see
 * `AcpTransport`'s seam refusal). Distinct from {@link DEFAULT_HARNESS_KIND}
 * (`"claude-code"`, the genuine-binary stream-json driver, mt#4934) — a
 * `harnessKind` of `"claude-code"` always selects the Claude transport, never
 * this one, regardless of `transport_id`.
 */
export const HARNESS_KIND_CODEX = "codex";
export const HARNESS_KIND_CLAUDE_CODE_ACP = "claude-code-acp";
