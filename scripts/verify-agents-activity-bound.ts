#!/usr/bin/env bun
/**
 * Live verification for mt#3118 — the Agents-list activity bound.
 *
 * Exercises the REAL production widget export (`agentsWidget`, the same
 * `WidgetModule` the cockpit daemon serves at `GET /api/widget/agents/data`)
 * against the live database, in both the default and `?includeInactive=true`
 * modes. Unit tests cover `isWithinActiveWindow` with injected records; they
 * do NOT prove the real-wired binding actually filters what the operator sees.
 * That gap is exactly the §7 "binding direction" check this script closes.
 *
 * Env-gated: needs whatever the persistence layer needs to reach the DB. On a
 * machine with no DB configured, the widget returns `state: "degraded"` and
 * this script SKIPs (exit 0) rather than failing — matching the skip-gracefully
 * convention for verification artifacts.
 *
 * Usage: bun scripts/verify-agents-activity-bound.ts
 * Exit codes: 0 = pass or skip, 1 = fail.
 */
// Must precede any tsyringe-decorated import — the widget resolves its session
// provider through the DI container.
import "reflect-metadata";

import { agentsWidget } from "../src/cockpit/widgets/agents";

// The widget resolves persistence lazily on first fetch, which requires
// configuration to have been initialized by an entrypoint. The daemon does
// this at boot; a standalone script must do it explicitly. Same bootstrap
// shape as scripts/verify-driven-link-writer.ts:34-43.
const { initializeConfiguration, CustomConfigFactory } = await import(
  "@minsky/domain/configuration"
);
await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

type AgentsResult = {
  state: string;
  reason?: string;
  payload?: {
    agents: Array<{ sessionId: string; kind: string; lastActivityAt: string }>;
    totalCount: number;
    hiddenInactiveCount: number;
  };
};

async function fetchMode(includeInactive: boolean): Promise<AgentsResult> {
  const query = includeInactive ? { includeInactive: "true" } : {};
  return (await agentsWidget.fetch({ query } as never)) as AgentsResult;
}

function workspaceRows(r: AgentsResult) {
  return (r.payload?.agents ?? []).filter((a) => a.kind === "dispatched-agent");
}

const bounded = await fetchMode(false);

if (bounded.state === "degraded") {
  // Narrow skip, deliberately. An earlier version skipped on ANY degraded
  // state and swallowed a real defect in this script (a missing
  // reflect-metadata import surfaced as "degraded" and read as "no DB here").
  // Only a genuine connectivity/config failure is a legitimate skip; anything
  // else is a failure that must be seen.
  const reason = bounded.reason ?? "no reason given";
  const isConnectivity = /ECONNREFUSED|ENOTFOUND|connect|timeout|no database|not configured/i.test(
    reason
  );
  if (isConnectivity) {
    console.log(`SKIP: no database reachable — ${reason}`);
    process.exit(0);
  }
  console.error(`FAIL: widget degraded for a non-connectivity reason — ${reason}`);
  process.exit(1);
}

const unbounded = await fetchMode(true);

const boundedWs = workspaceRows(bounded);
const unboundedWs = workspaceRows(unbounded);
const hidden = bounded.payload?.hiddenInactiveCount ?? 0;

console.log(
  JSON.stringify(
    {
      default: {
        totalRows: bounded.payload?.totalCount,
        workspaceRows: boundedWs.length,
        hiddenInactiveCount: hidden,
      },
      includeInactive: {
        totalRows: unbounded.payload?.totalCount,
        workspaceRows: unboundedWs.length,
        hiddenInactiveCount: unbounded.payload?.hiddenInactiveCount,
      },
      oldestWorkspaceActivity: {
        default: boundedWs.map((a) => a.lastActivityAt).sort()[0] ?? null,
        includeInactive: unboundedWs.map((a) => a.lastActivityAt).sort()[0] ?? null,
      },
    },
    null,
    2
  )
);

const failures: string[] = [];

// The bound must actually remove workspace rows on this dataset (measured
// 2026-07-23: 225 workspaces, ~6 active). If it removes none, the filter is
// not wired into the served payload.
if (boundedWs.length >= unboundedWs.length) {
  failures.push(
    `bound removed nothing: default=${boundedWs.length} workspace rows, includeInactive=${unboundedWs.length}`
  );
}

// The reported hidden count must reconcile with the observed difference.
if (hidden !== unboundedWs.length - boundedWs.length) {
  failures.push(
    `hiddenInactiveCount (${hidden}) != observed difference (${unboundedWs.length - boundedWs.length})`
  );
}

// The escape hatch must report zero hidden when it is engaged.
if ((unbounded.payload?.hiddenInactiveCount ?? -1) !== 0) {
  failures.push(
    `includeInactive should report hiddenInactiveCount 0, got ${unbounded.payload?.hiddenInactiveCount}`
  );
}

if (failures.length > 0) {
  console.error(`FAIL:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}

console.log(`PASS: bound hid ${hidden} inactive workspace row(s); escape hatch restores them.`);
process.exit(0);
