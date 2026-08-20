/**
 * Deployment-target declaration for the `minsky-ops` service.
 *
 * Provisioned mt#2132 (2026-07-29). Runs the SAME GHCR image as minsky-mcp
 * (`ghcr.io/edobry/minsky:latest`), with a start-command override so it
 * boots the ops background-loop / health-endpoint process instead of the
 * MCP server.
 *
 * ## Relationship to minsky-mcp
 *
 * Same image, different start command. Both forms below were read back from the
 * live environment on 2026-08-08, not transcribed from intent:
 *
 *   minsky-mcp:  NO override. It runs the image's own CMD, which `Dockerfile`
 *                declares as
 *                `bun run dist/minsky.js mcp start --http --host 0.0.0.0 --port $PORT --require-auth`
 *   minsky-ops:  `sh -c "bun run --preload reflect-metadata dist/minsky.js ops start --port $PORT --host 0.0.0.0"`
 *
 * ## The `--preload reflect-metadata` above is a leftover, not a requirement (mt#3773)
 *
 * It is redundant. mt#3680 moved the polyfill INSIDE the bundle
 * (`src/reflect-polyfill.ts`), so `dist/minsky.js` boots on its own; every other
 * site dropped the flag, including the root `Dockerfile` CMD this override was
 * copied from. minsky-mcp has run the bare form in production since 2026-08-05.
 * So `ops start` does NOT need the preload — the prior claim here that it did,
 * because it boots the same tsyringe container, was true only until mt#3680.
 *
 * **DONE 2026-08-10 — this section describes a state that no longer exists.**
 * The removal (approved as ask#7136) was applied through the Railway GraphQL
 * `serviceInstanceUpdate` mutation, the first proven agent-runnable write to
 * Railway service config (mem#915). Read back live 2026-08-19:
 *
 *     serviceInstance(...).startCommand
 *       = sh -c "bun run dist/minsky.js ops start --port $PORT --host 0.0.0.0"
 *
 * No `--preload reflect-metadata`. The line above showing the flag is the
 * historical value, kept because the rest of this comment explains why it was
 * there. minsky-ops now boots the self-sufficient path like every other service,
 * so a regression of mt#3680 WOULD surface here.
 *
 * Corrected under mt#3353 (2026-08-19). Worth knowing why it stayed wrong for
 * nine days: the change landed out-of-band — through the API, recorded in a
 * memory — so nothing edited the file that describes it, and a later
 * investigation reading THIS comment concluded the action was still pending and
 * nearly left a resolved ask open on that basis. A doc comment about an external
 * system's state is a derived view; the service is the primary source.
 *
 * ## Start-command override mechanism (mt#2132) — the documented invocation is DEAD
 *
 * The Pulumi `railway.Service` resource (terraform-community-providers/railway
 * bridge, see `infra/index.ts`'s `minskyOpsService` comment) has no
 * `startCommand`/`deploy.*` field, so the override is NOT expressed in
 * `infra/index.ts`. It was originally set out-of-band with a JSON patch over
 * stdin: `railway environment edit --json <<< '{"services":{...}}'`.
 *
 * That form no longer exists. On CLI 4.44.0 `--json` is an OUTPUT flag, and the
 * replacement the CLI documents is dot-path:
 *
 *   railway environment edit --service-config <service> deploy.startCommand "<value>"
 *
 * which accepts the write, prints no error, exits 0 — and does not persist.
 *
 * ## This override is dashboard-only. That is a conclusion, not a to-do (mt#3848)
 *
 * Every agent-runnable candidate was tried or ruled out on 2026-08-08. Do not
 * re-derive this list; extend it if Railway ships something new.
 *
 *   1. CLI dot-path, prefixed (`deploy.startCommand`) — no-op. Tried with the
 *      service UUID and with the name `minsky-ops`; read-back byte-identical.
 *   2. CLI dot-path, un-prefixed (`startCommand`) — no-op, same read-back. The
 *      docs' own examples use section prefixes (`build.buildCommand`,
 *      `source.rootDirectory`) but never enumerate the valid path set, and
 *      `deploy.startCommand` is evidently not in it.
 *   3. Config-as-code (`railway.json`) — STRUCTURALLY unavailable for this
 *      service. Railway reads it "from your service repository during deploy"
 *      (https://docs.railway.com/infrastructure-as-code); this service declares
 *      `source: { image: ... }` below — an image, no repo — so there is no file
 *      for Railway to read. If `source` ever gains a `repo`, re-test this one.
 *   4. Railway's TypeScript IaC SDK (`.railway/railway.ts`) — not evaluated here;
 *      it overlaps mt#1440 and would be that task's mechanism, not a local fix.
 *   5. Dashboard — https://docs.railway.com/guides/start-command documents the
 *      dashboard as the ONLY way to set a start command. The CLI form this file
 *      used to prescribe was never vendor-sanctioned for this field.
 *
 * CLI reference for the dot-path form: https://docs.railway.com/cli/environment
 * (its examples are `variables.API_KEY.value`, `build.buildCommand`,
 * `source.rootDirectory` — it does not enumerate the valid path set).
 *
 * So the flag below cannot be removed from an agent context. mt#3848 carries the
 * finding; ask#7136 already approved the removal, so it needs an operator in the
 * dashboard, not another authorization.
 *
 * ALWAYS verify by read-back rather than exit code — a dot-path write reports
 * success either way. Turnkey, with this service's own id:
 *
 *   railway environment config --json \
 *     | jq '.services["f6e3f285-8075-4845-934b-8e9bed15ab12"].deploy'
 *
 * The structural fix — bringing `startCommand` under config-as-code so overrides
 * stop living out-of-band — is mt#1440.
 *
 * ## Environment variables
 *
 * Declared in `infra/index.ts`'s `minskyOpsService` block (Pulumi-managed).
 * Inherits all minsky-mcp variables (same domain-container bootstrap) except
 * `MINSKY_MCP_MAX_SESSIONS` (MCP-HTTP-transport-only, not applicable), plus:
 *   ADOPTION_SWEEPER_ENABLED       — "true" (set; sweeper active)
 *   ADOPTION_SWEEPER_EXECUTE       — NOT set (dry-run default, mt#3328)
 *   ADOPTION_SWEEPER_INTERVAL_MS   — interval in ms (default: 86400000 = 24h)
 *   ADOPTION_SWEEPER_LOOKBACK_DAYS — days to look back (default: 14)
 *
 * @see mt#2101 — implementation task (ops service code)
 * @see mt#2097 — operational topology epic
 * @see mt#2132 — this provisioning task
 * @see mt#3328 — adoption-sweeper container-blindness fix (gates enabling the sweeper)
 */

import { defineDeployment } from "@minsky/shared/deployment-config";

export default defineDeployment({
  platform: "railway",
  healthUrl: "https://minsky-ops-production.up.railway.app/health",
  railway: {
    projectId: "0e054318-7e19-4489-8e1e-de787965161d", // same project as minsky-mcp
    environmentId: "0289b171-1514-4540-ac93-19b30da3e2c0", // same environment (production)
    serviceId: "f6e3f285-8075-4845-934b-8e9bed15ab12",
    source: {
      image: "ghcr.io/edobry/minsky:latest",
    },
  },
});
