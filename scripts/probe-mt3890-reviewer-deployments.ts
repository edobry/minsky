#!/usr/bin/env bun
/**
 * mt#3890 sibling check: is `minsky-reviewer-webhook` in the same silent
 * no-op state minsky-mcp turned out to be in?
 *
 * mt#3180 made the reviewer's redeploy step FATAL and mt#3251 specified a
 * dedicated `RAILWAY_REVIEWER_TOKEN`. The secret exists (created 2026-07-28).
 * What nobody verified is whether it actually WORKS — i.e. whether real
 * deployment records have been produced since. Read-only; prints nothing
 * sensitive.
 */
import { getValidRailwayToken } from "../packages/domain/src/deployment/railway/graphql-client";

const SERVICE_ID = "3913e8a4-81ab-465a-aad8-b76b5e3f66ed";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";

const QUERY = `
  query ($serviceId: String!, $limit: Int!) {
    service(id: $serviceId) {
      deployments(first: $limit) {
        edges { node { id status createdAt environmentId meta } }
      }
    }
  }
`;

interface Node {
  id: string;
  status: string;
  createdAt: string;
  meta?: { commitHash?: string } | null;
}

const token = await getValidRailwayToken();
const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ query: QUERY, variables: { serviceId: SERVICE_ID, limit: 8 } }),
  signal: AbortSignal.timeout(30_000),
});
const body = (await res.json()) as {
  data?: { service?: { deployments?: { edges?: { node: Node }[] } } };
  errors?: { message: string }[];
};

if (body.errors?.length) {
  console.log(`ERROR: ${body.errors.map((e) => e.message).join("; ")}`);
} else {
  const nodes = body.data?.service?.deployments?.edges?.map((e) => e.node) ?? [];
  console.log("=== minsky-reviewer-webhook: most recent deployments ===");
  for (const n of nodes) {
    console.log(
      `  ${n.createdAt}  ${n.status.padEnd(9)}  ${(n.meta?.commitHash ?? "—").slice(0, 9)}`
    );
  }
  if (nodes.length === 0) console.log("  (none)");
}
