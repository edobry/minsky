#!/usr/bin/env bun
/**
 * Deploy Minsky MCP to Railway (mt#1130).
 *
 * Three phases, idempotent:
 *   --phase=plan    Read-only. Diffs this manifest against live Railway state.
 *                   Safe to run anytime.
 *   --phase=apply   Creates/updates in the correct order (project → env vars →
 *                   source.rootDirectory → domain → deploymentTrigger). Every
 *                   step is check-then-create or upsert; re-running should no-op.
 *   --phase=verify  Probes the deployed service: /health, /mcp unauthenticated,
 *                   /mcp authenticated tools/list, /mcp authenticated
 *                   persistence_check. Writes resolved IDs to the deployment
 *                   memory file.
 *
 * Secrets come from ~/.config/minsky/minsky-mcp.env (create ahead of time with
 * MINSKY_POSTGRES_URL, OPENAI_API_KEY, etc.). MINSKY_MCP_AUTH_TOKEN auto-
 * generates to that file on first run. GitHub App PEM read from
 * ~/.config/minsky/minsky-app.pem. Nothing in this script writes secrets to
 * stdout, stderr, or any log.
 *
 * Gotchas encoded (see memory/feedback_railway_config.md):
 *  - .user.accessToken (not .token) for Railway GraphQL Bearer
 *  - source.rootDirectory patched BEFORE deploymentTriggerCreate
 *  - JSON-patch form for service config (never dot-path)
 *  - `railway variables --set` (4.40.x), not `railway variable set`
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
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
  memoryFile:
    "/Users/edobry/.claude/projects/-Users-edobry-Projects-minsky/memory/project_minsky_mcp_deployment.md",
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
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
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

function readLinkedStatus(cwd: string): RawStatus | null {
  const r = sh("railway", ["status", "--json"], { cwd });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout) as RawStatus;
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
): Promise<{ rootDirectory?: string; repo?: string; branch?: string } | null> {
  type R = {
    environment: {
      serviceInstances: {
        edges: {
          node: {
            serviceId: string;
            source?: { repo?: string; rootDirectory?: string };
            branch?: string;
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
                source {
                  repo
                  rootDirectory
                }
                branch
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
    rootDirectory: instance.node.source?.rootDirectory,
    repo: instance.node.source?.repo,
    branch: instance.node.branch,
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

async function patchServiceRootDirectory(
  serviceId: string,
  environmentId: string,
  rootDirectory: string
): Promise<void> {
  // Use Railway's GraphQL serviceInstanceUpdate to patch source.rootDirectory.
  // The CLI's `railway environment edit --json` form works too, but this is cleaner
  // from a Node context: direct API, structured error handling.
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
      input: { source: { rootDirectory } },
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
    console.log(
      `    → apply will run: railway init -n ${MANIFEST.project} -w "${MANIFEST.workspaceName}"`
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
      `    source.rootDirectory=${source?.rootDirectory ?? "(unset)"}  (manifest: ${MANIFEST.rootDirectory})`
    );
    console.log(`    source.repo=${source?.repo ?? "(unset)"}  (manifest: ${MANIFEST.repo})`);
    console.log(`    branch=${source?.branch ?? "(unset)"}  (manifest: ${MANIFEST.branch})`);

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

function maskShape(v: string | undefined): string {
  if (v == null) return "(null)";
  if (v.includes("BEGIN") && v.includes("PRIVATE KEY")) return `(PEM, ${v.length} chars)`;
  if (v.length > 20) return `(${v.length} chars, starts ${v.slice(0, 4)}…)`;
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

  // 4. Ensure source.rootDirectory BEFORE any trigger work.
  const source = await readServiceSource(linked.environmentId, linked.serviceId);
  if (source?.rootDirectory !== MANIFEST.rootDirectory) {
    console.log(
      `  Patching source.rootDirectory: ${source?.rootDirectory ?? "(unset)"} → ${MANIFEST.rootDirectory}`
    );
    await patchServiceRootDirectory(linked.serviceId, linked.environmentId, MANIFEST.rootDirectory);
  } else {
    console.log(`  source.rootDirectory already correct: ${MANIFEST.rootDirectory}`);
  }

  // 5. Upsert env vars. Railway CLI `variables --set` is idempotent.
  console.log(`  Setting ${Object.keys(values).length} environment variables…`);
  for (const [name, value] of Object.entries(values)) {
    const r = sh("railway", ["variables", "--set", `${name}=${value}`], { cwd: opts.cwd });
    if (!r.ok) {
      // Don't include the value in the error — it might be a secret.
      throw new Error(
        `railway variables --set ${name}=<redacted> failed (status ${r.status}): ${r.stderr}`
      );
    }
    console.log(`    set ${name}`);
  }

  // 6. Domain (generate if missing).
  const domain = await ensureDomain();
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

  // 8. Redeploy notes.
  //   `railway up` from step 3 already triggers a deploy on first run; trigger
  //   creation in step 7 also fires a build when new; `railway variables --set`
  //   in step 5 auto-triggers redeploys in modern CLI. No redundant redeploy
  //   call needed here.

  console.log("\nApply complete.");
}

async function ensureDomain(): Promise<string> {
  // `railway domain` generates one if none exists and prints it. If one exists,
  // it prints the existing domain. Output format varies by CLI version; we
  // extract *.up.railway.app.
  const r = railwayTry(["domain"]);
  if (!r.ok) throw new Error(`railway domain failed: ${r.stderr}`);
  const match = r.stdout.match(/[a-z0-9-]+\.up\.railway\.app/);
  if (!match) throw new Error(`could not extract domain from: ${r.stdout}`);
  return match[0];
}

// ---------------------------------------------------------------------------
// Phase: verify. HTTP probes.
// ---------------------------------------------------------------------------

async function phaseVerify(opts: { cwd: string }): Promise<void> {
  console.log("=== Phase: verify ===\n");

  const linked = requireLinked(readLinkedStatus(opts.cwd), "verify requires a linked service");
  const domain = await ensureDomain();
  const base = `https://${domain}`;
  console.log(`  Probing ${base}`);

  const { values } = resolveEnvValues({ dryRun: false });
  const token = values.MINSKY_MCP_AUTH_TOKEN;
  if (!token || token.startsWith("(would-be-")) {
    throw new Error("MINSKY_MCP_AUTH_TOKEN not resolved — run --phase=apply first");
  }

  const results: { name: string; ok: boolean; detail: string }[] = [];

  // 1. /health (public, expect 200).
  const health = await fetch(`${base}${MANIFEST.healthPath}`);
  results.push({
    name: "GET /health → 200",
    ok: health.ok,
    detail: `status=${health.status}`,
  });

  // 2. /mcp unauthenticated (expect 401).
  const noAuth = await fetch(`${base}${MANIFEST.mcpPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  results.push({
    name: "POST /mcp (no auth) → 401",
    ok: noAuth.status === 401,
    detail: `status=${noAuth.status}`,
  });

  // 3. /mcp authenticated tools/list (expect 2xx + tool registry).
  const withAuth = await fetch(`${base}${MANIFEST.mcpPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const authBody = await withAuth.text();
  results.push({
    name: "POST /mcp (auth) tools/list → 2xx",
    ok: withAuth.ok,
    detail: `status=${withAuth.status}, body=${authBody.slice(0, 80)}…`,
  });

  // 4. /mcp authenticated persistence_check (expect healthy response).
  const check = await fetch(`${base}${MANIFEST.mcpPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "persistence_check", arguments: {} },
    }),
  });
  const checkBody = await check.text();
  results.push({
    name: "POST /mcp (auth) persistence_check → 2xx",
    ok: check.ok,
    detail: `status=${check.status}, body=${checkBody.slice(0, 80)}…`,
  });

  // Report.
  let allOk = true;
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    console.log(`  ${mark} ${r.name}  (${r.detail})`);
    if (!r.ok) allOk = false;
  }

  if (allOk) {
    console.log("\nAll probes passed. Updating deployment memory…");
    const triggers = await listRepoTriggers(linked.serviceId);
    const triggerId = triggers[0]?.id ?? "(none)";
    writeDeploymentMemory({
      projectId: linked.projectId,
      serviceId: linked.serviceId,
      environmentId: linked.environmentId,
      domain,
      triggerId,
    });
  } else {
    console.log("\nOne or more probes failed. Memory NOT updated.");
    process.exit(1);
  }
}

function writeDeploymentMemory(fields: {
  projectId: string;
  serviceId: string;
  environmentId: string;
  domain: string;
  triggerId: string;
}): void {
  // Patch the placeholder lines in the memory file. Don't rewrite the file
  // wholesale — that would clobber any manual edits since the skeleton landed.
  let content = readFileSync(MANIFEST.memoryFile, "utf8");
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
  writeFileSync(MANIFEST.memoryFile, content);
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
