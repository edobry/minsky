#!/usr/bin/env bun
/**
 * mt#3890 probe: why does `deployment_status` return a four-day-old record?
 *
 * Read-only. Queries Railway's GraphQL directly for the minsky-mcp service's
 * recent deployments, three ways, so the three live hypotheses can be told
 * apart rather than argued about:
 *
 *   A) the current production query (service-scoped, `first: N`, no sort) —
 *      what the adapter actually runs today
 *   B) the same query with a larger N — reveals whether the newest deploys are
 *      PRESENT but not FIRST (an ordering problem) vs absent entirely
 *   C) an environment-scoped variant — reveals whether records from other
 *      environments are being mixed in (the config declares an environmentId
 *      that never reaches a query)
 *
 * Prints id / status / createdAt / environmentId / commitHash per node so the
 * result can be diffed against `forge_ci_run_list` output by eye.
 *
 * Never prints the token.
 */
import { getValidRailwayToken } from "../packages/domain/src/deployment/railway/graphql-client";

const SERVICE_ID = "a7c5195f-55de-472a-87e4-34e921a15171";
const ENVIRONMENT_ID = "0289b171-1514-4540-ac93-19b30da3e2c0";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";

async function gql(query: string, variables: Record<string, unknown>, token: string) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
  if (body.errors?.length) {
    // Errors are surfaced, not swallowed — a schema rejection IS the finding
    // for variant C (it would mean the connection takes no environment arg).
    return { error: body.errors.map((e) => e.message).join("; "), data: null };
  }
  return { error: null, data: body.data };
}

interface Node {
  id: string;
  status: string;
  createdAt: string;
  environmentId?: string | null;
  meta?: { commitHash?: string } | null;
}

function render(label: string, nodes: Node[] | null, error: string | null) {
  console.log(`\n=== ${label} ===`);
  if (error) {
    console.log(`  ERROR: ${error}`);
    return;
  }
  if (!nodes || nodes.length === 0) {
    console.log("  (no nodes returned)");
    return;
  }
  for (const n of nodes) {
    const env = n.environmentId ? n.environmentId.slice(0, 8) : "—";
    const commit = n.meta?.commitHash ? n.meta.commitHash.slice(0, 9) : "—";
    console.log(
      `  ${n.createdAt}  ${n.status.padEnd(9)}  env=${env}  ${commit}  ${n.id.slice(0, 8)}`
    );
  }
}

const PROD_QUERY = `
  query ($serviceId: String!, $limit: Int!) {
    service(id: $serviceId) {
      deployments(first: $limit) {
        edges { node { id status createdAt environmentId meta } }
      }
    }
  }
`;

const ENV_SCOPED_QUERY = `
  query ($serviceId: String!, $environmentId: String!, $limit: Int!) {
    deployments(
      first: $limit
      input: { serviceId: $serviceId, environmentId: $environmentId }
    ) {
      edges { node { id status createdAt environmentId meta } }
    }
  }
`;

const token = await getValidRailwayToken();

// A + B: the production shape, at first:1 (what ships) and first:10 (diagnostic).
for (const limit of [1, 10]) {
  const { data, error } = await gql(PROD_QUERY, { serviceId: SERVICE_ID, limit }, token);
  const nodes =
    (
      data as { service?: { deployments?: { edges?: { node: Node }[] } } } | null
    )?.service?.deployments?.edges?.map((e) => e.node) ?? null;
  render(`A/B: service(id).deployments(first: ${limit})  [production query shape]`, nodes, error);
}

// C: environment-scoped. A schema error here is itself the answer.
{
  const { data, error } = await gql(
    ENV_SCOPED_QUERY,
    { serviceId: SERVICE_ID, environmentId: ENVIRONMENT_ID, limit: 10 },
    token
  );
  const nodes =
    (data as { deployments?: { edges?: { node: Node }[] } } | null)?.deployments?.edges?.map(
      (e) => e.node
    ) ?? null;
  render("C: deployments(input: {serviceId, environmentId}, first: 10)", nodes, error);
}
