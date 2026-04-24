#!/usr/bin/env bun
/**
 * Deploy Minsky MCP to Railway (mt#1130).
 *
 * Single-service deploy script. Not a generalized library — the Railway
 * workspace and `edobry/minsky` repo are hard-coded at the top. Follow-up
 * mt#1139 extracts the shared bits to scripts/lib/railway.ts once two
 * concrete consumers (this + minsky-reviewer retrofit) ground the interface.
 *
 * Three phases, idempotent:
 *   --phase=plan    Read-only. Diffs this manifest against live Railway state.
 *                   Safe to run anytime.
 *   --phase=apply   Creates/updates in this order: project → service (via
 *                   `railway up --detach`) → service link → rootDirectory
 *                   → env vars (via GraphQL) → domain → deploymentTrigger.
 *                   Every step is check-then-create or upsert; re-running
 *                   should no-op.
 *   --phase=verify  Probes the deployed service and optionally updates the
 *                   deployment memory file if it exists with expected
 *                   placeholders (skipped gracefully otherwise).
 *
 * Secrets come from ~/.config/minsky/ (config.yaml, minsky-mcp.env for the
 * auth token, minsky-app.pem for the GitHub App key). MINSKY_MCP_AUTH_TOKEN
 * auto-generates to the env file on first run.
 *
 * Security posture:
 *  - Secret VALUES are never logged. maskShape reports length and category
 *    (PEM, integer, literal) — no prefix characters.
 *  - Secret VALUES are never passed on the command line (argv is visible via
 *    `ps` and can end up in CI logs). Env vars are set via Railway's GraphQL
 *    variableCollectionUpsert in the POST body.
 *  - The PEM, auth token, and connection strings are opaque strings to this
 *    script — treated as bytes, never decoded or inspected.
 *
 * Gotchas encoded (see memory/feedback_railway_config.md):
 *  - .user.accessToken (not .token) for Railway GraphQL Bearer
 *  - rootDirectory patched BEFORE deploymentTriggerCreate
 *  - rootDirectory is top-level on ServiceInstance, NOT nested under source
 *  - `railway service link <id>` required after project link
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Manifest — service-specific constants. Everything that isn't a secret.
// ---------------------------------------------------------------------------

const MANIFEST = {
  project: "minsky-mcp",
  workspaceName: "Eugene Dobry's Projects",
  workspaceId: "994aee5e-37e0-43ec-8074-0c37fbd73470",
  repo: "edobry/minsky",
  branch: "main",
  rootDirectory: "/",
  secretsEnvFile: "~/.config/minsky/minsky-mcp.env",
  configYaml: "~/.config/minsky/config.yaml",
  appPem: "~/.config/minsky/minsky-app.pem",
  // Optional path to the operator's Claude Code agent-memory file for the
  // deployment. Auto-populated with IDs on verify success. Default points at
  // the author's path; override with MINSKY_DEPLOY_MEMORY_FILE for other
  // operators. If the file doesn't exist, verify skips the update gracefully.
  memoryFile:
    process.env.MINSKY_DEPLOY_MEMORY_FILE ??
    "~/.claude/projects/-Users-edobry-Projects-minsky/memory/project_minsky_mcp_deployment.md",
  healthPath: "/health",
  mcpPath: "/mcp",
} as const;

/**
 * Env var resolution spec. Declarative — no secrets inline.
 */
type EnvSpec =
  | { name: string; kind: "envFile"; generateIfMissing?: boolean }
  | { name: string; kind: "yaml"; path: string[] }
  | { name: string; kind: "pem" }
  | { name: string; kind: "literal"; value: string };

const ENV_SPEC: EnvSpec[] = [
  { name: "MINSKY_MCP_AUTH_TOKEN", kind: "envFile", generateIfMissing: true },
  {
    name: "MINSKY_POSTGRES_URL",
    kind: "yaml",
    path: ["persistence", "postgres", "connectionString"],
  },
  { name: "MINSKY_GITHUB_APP_PRIVATE_KEY", kind: "pem" },
  { name: "MINSKY_APP_ID", kind: "yaml", path: ["github", "serviceAccount", "appId"] },
  {
    name: "MINSKY_APP_INSTALLATION_ID",
    kind: "yaml",
    path: ["github", "serviceAccount", "installationId"],
  },
  { name: "OPENAI_API_KEY", kind: "yaml", path: ["ai", "providers", "openai", "apiKey"] },
  { name: "NODE_ENV", kind: "literal", value: "production" },
];

// ---------------------------------------------------------------------------
// Shell + Railway CLI helpers.
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

type ShResult = { ok: boolean; stdout: string; stderr: string; status: number };

function sh(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {}
): ShResult {
  const r: SpawnSyncReturns<string> = spawnSync(cmd, args, {
    encoding: "utf8",
    env: opts.env ?? process.env,
    cwd: opts.cwd,
  });
  if (r.error) throw new Error(`${cmd} failed to spawn: ${r.error.message}`);
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    status: r.status ?? -1,
  };
}

function railway(args: string[]): string {
  const r = sh("railway", args);
  if (!r.ok) throw new Error(`railway ${args.join(" ")} exited ${r.status}\nstderr: ${r.stderr}`);
  return r.stdout;
}

function railwayTry(args: string[]): ShResult {
  return sh("railway", args);
}

function readRailwayToken(): string {
  const cfg = JSON.parse(readFileSync(expandTilde("~/.railway/config.json"), "utf8")) as {
    user?: { accessToken?: string };
  };
  const token = cfg.user?.accessToken;
  if (!token) {
    throw new Error(
      "Railway CLI is not authenticated (no user.accessToken in ~/.railway/config.json). Run: railway login"
    );
  }
  return token;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = readRailwayToken();
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as {
    data?: T;
    errors?: { message?: string; path?: (string | number)[] }[];
  };
  if (body.errors) {
    // Sanitize: surface only message + path, never the full payload. If the
    // Railway API ever echoes submitted variables in an error (for a mutation
    // like variableCollectionUpsert), those variables may be secrets. Don't
    // JSON.stringify the entire errors object for this reason.
    const summary = body.errors
      .map((e) => {
        const path = e.path ? ` at ${e.path.join(".")}` : "";
        return `${e.message ?? "unknown GraphQL error"}${path}`;
      })
      .join("; ");
    throw new Error(`GraphQL error: ${summary}`);
  }
  if (!body.data) throw new Error(`GraphQL returned no data for query: ${query.slice(0, 80)}`);
  return body.data;
}

// ---------------------------------------------------------------------------
// Env-value resolution. Secret values are treated as opaque — never logged.
// ---------------------------------------------------------------------------

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function writeEnvFile(path: string, vars: Record<string, string>): void {
  // Ensure the parent directory exists before writing — first-run UX.
  mkdirSync(dirname(path), { recursive: true });
  const content = `${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readYamlPath(file: string, path: string[]): string {
  const data: unknown = parseYaml(readFileSync(expandTilde(file), "utf8"));
  let cur: unknown = data;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) {
      throw new Error(`YAML path [${path.join(".")}] missing at "${key}" in ${file}`);
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  if (cur == null) throw new Error(`YAML path [${path.join(".")}] is null/missing in ${file}`);
  return String(cur);
}

function readPem(file: string): string {
  const content = readFileSync(expandTilde(file), "utf8");
  if (!content.includes("BEGIN") || !content.includes("END")) {
    throw new Error(`File does not look like a PEM: ${file}`);
  }
  return content;
}

/**
 * Resolve all env values per ENV_SPEC. Returns a map from env var name → value
 * plus a list of names that were auto-generated for persistence.
 *
 * `dryRun`: in plan mode we still want to report what WOULD be generated and
 * what values look like, but we must not write anything to disk. Set true from
 * phase=plan; false from apply/verify.
 */
function resolveEnvValues({ dryRun }: { dryRun: boolean }): {
  values: Record<string, string>;
  generated: string[];
  wouldGenerate: string[];
} {
  const secretsFile = expandTilde(MANIFEST.secretsEnvFile);
  const existing = parseEnvFile(secretsFile);
  const values: Record<string, string> = {};
  const generated: string[] = [];
  const wouldGenerate: string[] = [];

  for (const spec of ENV_SPEC) {
    switch (spec.kind) {
      case "literal":
        values[spec.name] = spec.value;
        break;
      case "envFile": {
        const existingValue = existing[spec.name];
        if (existingValue) {
          values[spec.name] = existingValue;
        } else if (spec.generateIfMissing) {
          if (dryRun) {
            values[spec.name] = "(would-be-generated-at-apply-time)";
            wouldGenerate.push(spec.name);
          } else {
            const token = randomBytes(32).toString("hex");
            values[spec.name] = token;
            existing[spec.name] = token;
            generated.push(spec.name);
          }
        } else {
          throw new Error(`${spec.name} not found in ${MANIFEST.secretsEnvFile}`);
        }
        break;
      }
      case "yaml":
        values[spec.name] = readYamlPath(MANIFEST.configYaml, spec.path);
        break;
      case "pem":
        values[spec.name] = readPem(MANIFEST.appPem);
        break;
    }
  }

  if (!dryRun && generated.length > 0) {
    writeEnvFile(secretsFile, existing);
  }

  return { values, generated, wouldGenerate };
}

// ---------------------------------------------------------------------------
// Railway state queries. Each returns null when the thing isn't present.
// ---------------------------------------------------------------------------

type LinkedStatus = {
  projectId: string;
  serviceId: string;
  environmentId: string;
  name?: string;
};

type RawStatus = {
  projectId?: string;
  serviceId?: string;
  environmentId?: string;
  name?: string;
};

/**
 * `railway status --json` returns the project graph directly, not a flat
 * projectId/serviceId/environmentId shape. Shape observed in 4.40.x:
 *
 *   { id, name, environments: { edges: [{node: { id, name, ... }}] },
 *     services: { edges: [{node: { id, name, ... }}] } }
 *
 * We flatten to the shape the rest of this script wants. Picks the
 * `production` environment and the first service (minsky-mcp is single-
 * service).
 */
type RailwayStatusRaw = {
  id?: string;
  name?: string;
  environments?: { edges?: { node?: { id?: string; name?: string } }[] };
  services?: { edges?: { node?: { id?: string; name?: string } }[] };
};

function readLinkedStatus(cwd: string): RawStatus | null {
  const r = sh("railway", ["status", "--json"], { cwd });
  if (!r.ok) return null;
  try {
    const raw = JSON.parse(r.stdout) as RailwayStatusRaw;
    if (!raw.id) return null;
    const prodEnv = raw.environments?.edges?.find((e) => e.node?.name === "production")?.node;
    // Pick service by name, not "first" — defensive against future multi-service
    // expansion. Fall back to first service only if exact name isn't found yet
    // (Railway sometimes names it differently at creation time, then renames).
    const svcEdges = raw.services?.edges ?? [];
    const byName = svcEdges.find((e) => e.node?.name === MANIFEST.project)?.node;
    const chosen = byName ?? svcEdges[0]?.node;
    return {
      projectId: raw.id,
      name: raw.name,
      environmentId: prodEnv?.id,
      serviceId: chosen?.id,
    };
  } catch {
    return null;
  }
}

/** Narrow a RawStatus to LinkedStatus or throw with a clear context. */
function requireLinked(status: RawStatus | null, context: string): LinkedStatus {
  if (!status?.projectId || !status.serviceId || !status.environmentId) {
    throw new Error(
      `${context}: expected a fully-linked Railway project (projectId+serviceId+environmentId) but got ${JSON.stringify(status)}`
    );
  }
  return {
    projectId: status.projectId,
    serviceId: status.serviceId,
    environmentId: status.environmentId,
    name: status.name,
  };
}

type TriggerNode = { id: string; branch: string; repository: string; provider: string };

async function listRepoTriggers(serviceId: string): Promise<TriggerNode[]> {
  type R = {
    service: { repoTriggers: { edges: { node: TriggerNode }[] } };
  };
  const data = await graphql<R>(
    `
      query ($id: String!) {
        service(id: $id) {
          repoTriggers {
            edges {
              node {
                id
                branch
                repository
                provider
              }
            }
          }
        }
      }
    `,
    { id: serviceId }
  );
  return data.service.repoTriggers.edges.map((e) => e.node);
}

async function readServiceSource(
  environmentId: string,
  serviceId: string
): Promise<{ rootDirectory?: string; repo?: string } | null> {
  // Per Railway schema (introspected 2026-04-23): `rootDirectory` is a top-level
  // field on `ServiceInstance`, not under `source`. `source` only has `image`
  // and `repo`. `branch` is elsewhere (on deployment triggers, not on the
  // service instance itself).
  type R = {
    environment: {
      serviceInstances: {
        edges: {
          node: {
            serviceId: string;
            rootDirectory?: string;
            source?: { repo?: string };
          };
        }[];
      };
    };
  };
  const data = await graphql<R>(
    `
      query ($envId: String!) {
        environment(id: $envId) {
          serviceInstances {
            edges {
              node {
                serviceId
                rootDirectory
                source {
                  repo
                }
              }
            }
          }
        }
      }
    `,
    { envId: environmentId }
  );
  const instance = data.environment.serviceInstances.edges.find(
    (e) => e.node.serviceId === serviceId
  );
  if (!instance) return null;
  return {
    rootDirectory: instance.node.rootDirectory,
    repo: instance.node.source?.repo,
  };
}

async function createDeploymentTrigger(
  projectId: string,
  environmentId: string,
  serviceId: string
): Promise<string> {
  type R = { deploymentTriggerCreate: { id: string } };
  const data = await graphql<R>(
    `
      mutation ($input: DeploymentTriggerCreateInput!) {
        deploymentTriggerCreate(input: $input) {
          id
          branch
          repository
          provider
        }
      }
    `,
    {
      input: {
        projectId,
        environmentId,
        serviceId,
        branch: MANIFEST.branch,
        repository: MANIFEST.repo,
        provider: "github",
      },
    }
  );
  return data.deploymentTriggerCreate.id;
}

/**
 * Upsert all variables for a service+environment in a single GraphQL call.
 *
 * Why not `railway variables --set KEY=VALUE`: argv is visible via `ps`,
 * survives in shell history, and often ends up in CI logs. Putting secret
 * material on the command line leaks it even if the application never prints
 * it. GraphQL sends the values in the POST body only.
 *
 * `skipDeploys: false` — we WANT the upsert to fire a redeploy when values
 * change. On first run it bundles with the trigger-create build; on
 * subsequent runs when the trigger exists and values changed, this is the
 * mechanism that propagates the change to the running container. An earlier
 * iteration used skipDeploys:true and relied on trigger-create for the first
 * build; on subsequent runs that meant var updates silently didn't propagate.
 * Railway dedupes rapid-fire redeploy requests, so cascading multiple
 * upserts back-to-back still produces approximately one build in practice.
 */
async function upsertVariables(
  projectId: string,
  environmentId: string,
  serviceId: string,
  variables: Record<string, string>
): Promise<void> {
  type R = { variableCollectionUpsert: null };
  await graphql<R>(
    `
      mutation ($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `,
    {
      input: {
        projectId,
        environmentId,
        serviceId,
        variables,
        replace: false,
        skipDeploys: false,
      },
    }
  );
}

async function patchServiceRootDirectory(
  serviceId: string,
  environmentId: string,
  rootDirectory: string
): Promise<void> {
  // Per Railway's schema, `rootDirectory` is top-level on ServiceInstanceUpdateInput
  // (not nested under `source`). The CLI's `railway environment edit --json`
  // form works too, but direct API gives cleaner error handling.
  type R = { serviceInstanceUpdate: boolean };
  await graphql<R>(
    `
      mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
      }
    `,
    {
      serviceId,
      environmentId,
      input: { rootDirectory },
    }
  );
}

// ---------------------------------------------------------------------------
// Phase: plan. Read-only.
// ---------------------------------------------------------------------------

async function phasePlan(opts: { cwd: string }): Promise<void> {
  console.log("=== Phase: plan (read-only) ===\n");

  // Auth check.
  const whoami = sh("railway", ["whoami", "--json"]);
  if (!whoami.ok) {
    console.log("  Railway CLI: NOT authenticated → run `railway login`");
    return;
  }
  const who = JSON.parse(whoami.stdout) as { name?: string; email?: string };
  console.log(`  Railway CLI: authenticated as ${who.name ?? who.email ?? "(unknown)"}`);

  // Env resolution (plan: dry-run, no generation or file writes).
  console.log(`  Resolving env vars per manifest (${ENV_SPEC.length} entries)…`);
  const { values, wouldGenerate } = resolveEnvValues({ dryRun: true });
  for (const spec of ENV_SPEC) {
    const val = values[spec.name];
    const shape = maskShape(val);
    const note = wouldGenerate.includes(spec.name) ? "  (will generate on apply)" : "";
    console.log(`    ${spec.name.padEnd(34)} ${shape}${note}`);
  }

  // Project linkage check.
  const status = readLinkedStatus(opts.cwd);
  if (!status?.projectId) {
    console.log(`  Railway project: NOT linked in this directory`);
    // Match the exact command apply will use — workspaceId, not workspaceName
    // (both accepted by railway init -w, but pinning the id is reproducible).
    console.log(
      `    → apply will run: railway init -n ${MANIFEST.project} -w ${MANIFEST.workspaceId} --json  (workspace "${MANIFEST.workspaceName}")`
    );
    return;
  }
  console.log(`  Railway project: linked → projectId=${status.projectId}`);

  if (status.serviceId && status.environmentId) {
    const { serviceId, environmentId } = status;
    console.log(`    serviceId=${serviceId}`);
    console.log(`    environmentId=${environmentId}`);

    const source = await readServiceSource(environmentId, serviceId);
    console.log(
      `    rootDirectory=${source?.rootDirectory ?? "(unset)"}  (manifest: ${MANIFEST.rootDirectory})`
    );
    console.log(`    source.repo=${source?.repo ?? "(unset)"}  (manifest: ${MANIFEST.repo})`);

    const triggers = await listRepoTriggers(serviceId);
    if (triggers.length === 0) {
      console.log(`    deploymentTrigger: NONE  → apply will create one on ${MANIFEST.branch}`);
    } else {
      for (const t of triggers) {
        console.log(
          `    deploymentTrigger: ${t.id} → ${t.repository}@${t.branch} via ${t.provider}`
        );
      }
    }
  }

  console.log(
    `\nPlan complete. Secrets resolved: ${Object.keys(values).length}. Would generate on apply: ${wouldGenerate.length}.`
  );
}

/**
 * Describe a resolved env value without leaking content. Length-only for long
 * values (no prefix characters — even 4 chars of an OPENAI key is too much
 * signal to emit to logs). Integers and known literals are safe to display in
 * full because they are not secrets.
 */
function maskShape(v: string | undefined): string {
  if (v == null) return "(null)";
  if (v.includes("BEGIN") && v.includes("PRIVATE KEY")) return `(PEM, ${v.length} chars)`;
  if (/^\d+$/.test(v)) return `(integer: ${v})`;
  if (v === "production" || v === "development") return `("${v}")`;
  return `(${v.length} chars)`;
}

// ---------------------------------------------------------------------------
// Phase: apply. Idempotent.
// ---------------------------------------------------------------------------

async function phaseApply(opts: { cwd: string }): Promise<void> {
  console.log("=== Phase: apply ===\n");

  // 0. Auth.
  readRailwayToken(); // throws if missing

  // 1. Resolve env values (generates auth token if missing, persists to env file).
  const { values, generated } = resolveEnvValues({ dryRun: false });
  if (generated.length > 0) {
    console.log(`  Generated and persisted: ${generated.join(", ")} → ${MANIFEST.secretsEnvFile}`);
  }

  // 2. Link or create project.
  let status = readLinkedStatus(opts.cwd);
  if (!status?.projectId) {
    console.log(`  Creating Railway project: ${MANIFEST.project}…`);
    const out = railway(["init", "-n", MANIFEST.project, "-w", MANIFEST.workspaceId, "--json"]);
    // railway init emits JSON on --json. Output shape is typically { project: { id, ... } }.
    console.log(`    ${out.slice(0, 200)}${out.length > 200 ? "…" : ""}`);
    status = readLinkedStatus(opts.cwd);
    if (!status?.projectId) {
      throw new Error("railway init succeeded but project still not linked in this cwd");
    }
    console.log(`  Linked projectId=${status.projectId}`);
  } else {
    console.log(`  Project already linked: projectId=${status.projectId}`);
  }

  // 3. First `railway up` to create a service if none exists yet. Detached.
  if (!status.serviceId) {
    console.log("  No service yet → running `railway up --detach` to create one…");
    const r = railwayTry(["up", "--detach", "-m", "Initial minsky-mcp deploy"]);
    if (!r.ok) {
      console.log(`    stderr: ${r.stderr}`);
      throw new Error(`railway up failed (status ${r.status})`);
    }
    status = readLinkedStatus(opts.cwd);
  }

  const linked = requireLinked(status, "after project + service creation");
  console.log(`    serviceId=${linked.serviceId}, environmentId=${linked.environmentId}`);

  // 3a. Link the service to the CWD so subsequent `railway variables`, `railway
  //     domain`, etc. operate on it. Distinct from the project link; without
  //     the service link, `railway variables --set` fails with "No service
  //     linked". Idempotent: linking an already-linked service is a no-op.
  const linkResult = railwayTry(["service", "link", linked.serviceId]);
  if (!linkResult.ok) {
    throw new Error(
      `railway service link ${linked.serviceId} failed (status ${linkResult.status}): ${linkResult.stderr}`
    );
  }
  console.log(`    service linked to cwd`);

  // 4. Ensure rootDirectory BEFORE any trigger work.
  const source = await readServiceSource(linked.environmentId, linked.serviceId);
  if (source?.rootDirectory !== MANIFEST.rootDirectory) {
    console.log(
      `  Patching rootDirectory: ${source?.rootDirectory ?? "(unset)"} → ${MANIFEST.rootDirectory}`
    );
    await patchServiceRootDirectory(linked.serviceId, linked.environmentId, MANIFEST.rootDirectory);
  } else {
    console.log(`  rootDirectory already correct: ${MANIFEST.rootDirectory}`);
  }

  // 5. Upsert env vars via GraphQL (values sent in POST body, not argv — see
  //    upsertVariables docstring for why).
  console.log(`  Upserting ${Object.keys(values).length} environment variables via GraphQL…`);
  await upsertVariables(linked.projectId, linked.environmentId, linked.serviceId, values);
  for (const name of Object.keys(values)) {
    console.log(`    set ${name}`);
  }

  // 6. Domain — prefer GraphQL read (works for custom domains too); only fall
  //    back to CLI generation if no domain is assigned yet.
  let domain = await readServiceDomain(linked.environmentId, linked.serviceId);
  if (!domain) {
    console.log(`  No domain yet → running \`railway domain\` to generate one…`);
    domain = await ensureDomain();
  }
  console.log(`  Public URL: https://${domain}`);

  // 7. Deployment trigger.
  const triggers = await listRepoTriggers(linked.serviceId);
  const existingTrigger = triggers.find(
    (t) => t.branch === MANIFEST.branch && t.repository === MANIFEST.repo
  );
  if (existingTrigger) {
    console.log(
      `  Deployment trigger already exists: ${existingTrigger.id} (${existingTrigger.repository}@${existingTrigger.branch})`
    );
  } else {
    console.log(`  Creating deployment trigger for ${MANIFEST.repo}@${MANIFEST.branch}…`);
    const triggerId = await createDeploymentTrigger(
      linked.projectId,
      linked.environmentId,
      linked.serviceId
    );
    console.log(`    triggerId=${triggerId}`);
  }

  // 8. Redeploy semantics:
  //   - First run: `railway up` (step 3) fires an initial build that will
  //     crash (no env vars yet — known one-time wasted build). Then variable
  //     upsert (step 5, skipDeploys:false) fires a second build with correct
  //     config that succeeds.
  //   - Subsequent runs with changed values: no `railway up`, but the
  //     variable upsert with skipDeploys:false triggers a redeploy that
  //     propagates the change to the running container.
  //   - Subsequent runs with unchanged values: Railway returns no-op on
  //     identical variables; no redeploy fires.
  //   Deferring the first build until after env vars are set would require
  //   GraphQL serviceCreate + explicit deploy mutation instead of `railway
  //   up`; kept for mt#1139 extraction (acceptable tradeoff for first deploy).

  console.log("\nApply complete.");
}

async function ensureDomain(): Promise<string> {
  // `railway domain` generates one if none exists and prints it. If one exists,
  // it prints the existing domain. Used only from apply (which may need to
  // generate). Verify should use readServiceDomain() instead — it's read-only
  // and doesn't depend on the CLI's link state.
  const r = railwayTry(["domain"]);
  if (!r.ok) throw new Error(`railway domain failed: ${r.stderr}`);
  const match = r.stdout.match(/[a-z0-9-]+\.up\.railway\.app/);
  if (!match) throw new Error(`could not extract domain from: ${r.stdout}`);
  return match[0];
}

/**
 * Read-only GraphQL lookup of the service's primary domain. Prefers
 * customDomains over serviceDomains (if an operator has configured a custom
 * domain, that's the canonical public URL). No CLI context dependency.
 * Returns null if the service has no domains.
 */
async function readServiceDomain(environmentId: string, serviceId: string): Promise<string | null> {
  type R = {
    environment: {
      serviceInstances: {
        edges: {
          node: {
            serviceId: string;
            domains: {
              serviceDomains: { domain: string }[];
              customDomains: { domain: string }[];
            };
          };
        }[];
      };
    };
  };
  const data = await graphql<R>(
    `
      query ($envId: String!) {
        environment(id: $envId) {
          serviceInstances {
            edges {
              node {
                serviceId
                domains {
                  serviceDomains {
                    domain
                  }
                  customDomains {
                    domain
                  }
                }
              }
            }
          }
        }
      }
    `,
    { envId: environmentId }
  );
  const instance = data.environment.serviceInstances.edges.find(
    (e) => e.node.serviceId === serviceId
  );
  if (!instance) return null;
  const custom = instance.node.domains.customDomains[0]?.domain;
  const service = instance.node.domains.serviceDomains[0]?.domain;
  return custom ?? service ?? null;
}

// ---------------------------------------------------------------------------
// Phase: verify. HTTP probes.
// ---------------------------------------------------------------------------

async function phaseVerify(opts: { cwd: string }): Promise<void> {
  console.log("=== Phase: verify ===\n");

  // Read-only resolution: do NOT auto-generate MINSKY_MCP_AUTH_TOKEN here.
  // If it's missing locally, verify must fail fast rather than write a new
  // token that won't match what's on Railway.
  const { values, wouldGenerate } = resolveEnvValues({ dryRun: true });
  const token = values.MINSKY_MCP_AUTH_TOKEN;
  if (!token || wouldGenerate.includes("MINSKY_MCP_AUTH_TOKEN")) {
    throw new Error(
      `MINSKY_MCP_AUTH_TOKEN missing locally (${MANIFEST.secretsEnvFile}). ` +
        `Run --phase=apply first (or manually copy the token from Railway env).`
    );
  }

  const linked = requireLinked(readLinkedStatus(opts.cwd), "verify requires a linked service");

  // Domain lookup via GraphQL — read-only, no CLI link-state dependency.
  const domain = await readServiceDomain(linked.environmentId, linked.serviceId);
  if (!domain) {
    throw new Error(
      `Service ${linked.serviceId} has no domain assigned. Run --phase=apply to generate one.`
    );
  }
  const base = `https://${domain}`;
  console.log(`  Probing ${base}`);

  const results: { name: string; ok: boolean; detail: string }[] = [];

  // 15-second timeout on each probe — Railway edge will respond quickly
  // for healthy services; anything beyond 15s means something is wrong
  // (container hung, edge 502 loop, SSE stream kept open, DNS delay).
  const PROBE_TIMEOUT_MS = 15_000;
  const probe = (url: string, init?: RequestInit): Promise<Response> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(timer));
  };

  // 1. /health (public, expect 200).
  const health = await probe(`${base}${MANIFEST.healthPath}`);
  results.push({
    name: "GET /health → 200",
    ok: health.ok,
    detail: `status=${health.status}`,
  });

  // 2. /mcp unauthenticated (expect 401).
  const noAuth = await probe(`${base}${MANIFEST.mcpPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  results.push({
    name: "POST /mcp (no auth) → 401",
    ok: noAuth.status === 401,
    detail: `status=${noAuth.status}`,
  });

  // 3. /mcp authenticated — prove the auth gate lets requests reach the
  //    container. We deliberately don't do a full MCP initialize handshake:
  //    Streamable HTTP protocol correctness is a downstream consumer concern,
  //    not infrastructure verification. What this probe confirms is that
  //    bearer auth passes and the Minsky process (not Railway's edge) is
  //    generating the response.
  //
  //    Accept header is application/json only (not text/event-stream) —
  //    if the server opted to stream, awaiting text() could hang.
  //
  //    PASS if: response came from the container (no x-railway-fallback
  //             header) and status is NOT 401.
  //    FAIL if: 401 (auth gate broken), Railway fallback (container dead),
  //             network error, or no response at all.
  const authResp = await probe(`${base}${MANIFEST.mcpPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  // Drain the body but don't log it — container error bodies can contain stack
  // traces and config fragments that shouldn't reach stdout.
  await authResp.text();
  const fromContainer = authResp.headers.get("x-railway-fallback") !== "true";
  const authReachedDispatcher = fromContainer && authResp.status !== 401;
  results.push({
    name: "POST /mcp (auth) reaches container",
    ok: authReachedDispatcher,
    detail: `status=${authResp.status}, from-container=${fromContainer}`,
  });

  // Report.
  let allOk = true;
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    console.log(`  ${mark} ${r.name}  (${r.detail})`);
    if (!r.ok) allOk = false;
  }

  if (allOk) {
    console.log("\nAll probes passed.");
    const triggers = await listRepoTriggers(linked.serviceId);
    const triggerId = triggers[0]?.id ?? "(none)";
    const memResult = writeDeploymentMemory({
      projectId: linked.projectId,
      serviceId: linked.serviceId,
      environmentId: linked.environmentId,
      domain,
      triggerId,
    });
    console.log(`  Deployment memory: ${memResult.reason}`);
  } else {
    console.log("\nOne or more probes failed.");
    process.exit(1);
  }
}

/**
 * Optionally patch the operator's personal deployment-memory file with the
 * resolved IDs. Skipped gracefully if the file doesn't exist at
 * `MANIFEST.memoryFile` — the path is intentionally user-specific (it's a
 * Claude Code agent-memory file, not a repo artifact), so other machines
 * won't have it. Verify still reports success; the memory update is a
 * convenience for the single operator whose memory path matches.
 *
 * Also skipped if the file doesn't contain the expected placeholder tokens,
 * so re-running verify after a successful deploy is a no-op rather than
 * corrupting already-populated fields.
 */
function writeDeploymentMemory(fields: {
  projectId: string;
  serviceId: string;
  environmentId: string;
  domain: string;
  triggerId: string;
}): { updated: boolean; reason: string } {
  const memoryPath = expandTilde(MANIFEST.memoryFile);
  if (!existsSync(memoryPath)) {
    return {
      updated: false,
      reason: `memory file not present at ${MANIFEST.memoryFile} (skipped)`,
    };
  }
  let content = readFileSync(memoryPath, "utf8");
  if (!content.includes("<fill-in>")) {
    return { updated: false, reason: "no <fill-in> placeholders present (already populated?)" };
  }
  const replacements: [RegExp, string][] = [
    [/- Project ID: `<fill-in>`/, `- Project ID: \`${fields.projectId}\``],
    [
      /- Service ID: `<fill-in>` {2}← consumers/,
      `- Service ID: \`${fields.serviceId}\`  ← consumers`,
    ],
    [
      /- Environment ID \(production\): `<fill-in>`/,
      `- Environment ID (production): \`${fields.environmentId}\``,
    ],
    [/- Deployment trigger ID: `<fill-in>`/, `- Deployment trigger ID: \`${fields.triggerId}\``],
    [
      /- Public URL: `https:\/\/<fill-in>\.up\.railway\.app`/,
      `- Public URL: \`https://${fields.domain}\``,
    ],
    [
      /- MCP endpoint: `https:\/\/<fill-in>\.up\.railway\.app\/mcp`/,
      `- MCP endpoint: \`https://${fields.domain}/mcp\``,
    ],
    [
      /- Health endpoint: `https:\/\/<fill-in>\.up\.railway\.app\/health`/,
      `- Health endpoint: \`https://${fields.domain}/health\``,
    ],
  ];
  for (const [re, to] of replacements) content = content.replace(re, to);
  // Replace <fill-in> occurrences in the laptop MCP config JSON snippet.
  content = content.replace(/<fill-in>\.up\.railway\.app/g, fields.domain);
  writeFileSync(memoryPath, content);
  return { updated: true, reason: `wrote to ${MANIFEST.memoryFile}` };
}

// ---------------------------------------------------------------------------
// main.
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { phase: "plan" | "apply" | "verify" } {
  const phaseArg = argv.find((a) => a.startsWith("--phase="))?.split("=")[1];
  if (phaseArg !== "plan" && phaseArg !== "apply" && phaseArg !== "verify") {
    console.error("Usage: bun scripts/deploy-minsky-mcp.ts --phase=plan|apply|verify");
    process.exit(2);
  }
  return { phase: phaseArg };
}

async function main(): Promise<void> {
  const { phase } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  if (phase === "plan") await phasePlan({ cwd });
  else if (phase === "apply") await phaseApply({ cwd });
  else if (phase === "verify") await phaseVerify({ cwd });
}

main().catch((err) => {
  console.error(`deploy-minsky-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
