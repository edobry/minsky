# scripts/

Utility and spike scripts for Minsky. These are not part of the main application.

## Scripts

| Script                         | Description                                                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `check-variable-naming.ts`     | Checks codebase for non-ASCII variable/symbol names.                                                                                                                                                                                                                                 |
| `create-github-app.ts`         | Bootstraps a new GitHub App for Minsky bot identity.                                                                                                                                                                                                                                 |
| `deploy-minsky-mcp.ts`         | Deployment helper for the hosted Minsky MCP server on Railway.                                                                                                                                                                                                                       |
| `drizzle-config-loader.ts`     | Loads and validates Drizzle ORM configuration.                                                                                                                                                                                                                                       |
| `fix-variable-naming.ts`       | Auto-fixes non-ASCII variable names found by `check-variable-naming.ts`.                                                                                                                                                                                                             |
| `import-claude-code-memory.ts` | Imports Claude Code memory entries into Minsky's memory backend.                                                                                                                                                                                                                     |
| `poc-agent-loop.ts`            | PoC for mt#216: drives a Minsky task lifecycle via MCP without Claude Code. See `poc-findings.md`.                                                                                                                                                                                   |
| `spike-mcp-signals.ts`         | **THROWAWAY SPIKE** for mt#1315: MCP server that exercises `notifications/message`, stdio exit, and `InitializeResult.instructions` so we can empirically map Claude Code's signaling surface. See `docs/mcp-signaling-spike-findings.md`. Do NOT register in production MCP config. |
| `test-provenance-e2e.ts`       | End-to-end test for the agent-identity provenance pipeline.                                                                                                                                                                                                                          |

## lib/

Shared utilities used by scripts above.

| Module             | Description                         |
| ------------------ | ----------------------------------- |
| `lib/pem-utils.ts` | PEM key parsing/formatting helpers. |

## supabase/

Supabase Management API helpers.

| Script                        | Description                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/restart-project.ts` | Self-serve Supabase project restart via Management API (`POST /v1/projects/{ref}/restart`). Dry-run by default; pass `--execute` to actually restart. Required to reset the Supavisor auth-failure circuit breaker — a fast DB reboot alone is NOT sufficient. See mt#2574 and `docs/incidents/2026-06-28-supabase-connectivity-breaker.md`. |
