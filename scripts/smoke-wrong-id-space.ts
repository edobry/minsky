#!/usr/bin/env bun
/**
 * Smoke test for the cockpit wrong-id-space fail-loud surface (mt#2525 / mt#2420).
 *
 * The snapshot endpoint's wrong-id-space classification is a STRUCTURAL change
 * (implement-task §7a): its correctness depends on the live WORKSPACE substrate
 * lookup (`getServerSessionProvider().getSession`) actually distinguishing a
 * real workspace id from an unknown id — no unit test (which injects the probe)
 * verifies the wired endpoint against the real DB. This script boots the real
 * cockpit server factory and probes the endpoint:
 *   - a real WORKSPACE session id  → 422 `wrong_id_space` (the fix)
 *   - a random UUID                → 404 `session_not_found` (preserved)
 *
 * Env-gated: needs a reachable Postgres (DATABASE_URL / config). Skips
 * gracefully (exit 0, "SKIP") when absent — safe to run anywhere. Run live from
 * a context with the shared connection, then paste the redacted output under
 * "## Live verification" in the PR body.
 *
 * Usage: bun scripts/smoke-wrong-id-space.ts
 */
import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

async function main(): Promise<void> {
  // 1. Bootstrap config + the cockpit shared persistence singleton (the same
  //    one the server's getServerSessionProvider / getContextInspectorDb use).
  let provider: import("@minsky/domain/session/types").SessionProviderInterface;
  try {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "@minsky/domain/configuration"
    );
    await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

    const { getSharedPersistenceService } = await import("../src/cockpit/shared-persistence");
    const svc = await getSharedPersistenceService();

    const { createSessionProvider } = await import(
      "@minsky/domain/session/drizzle-session-repository"
    );
    provider = await createSessionProvider(undefined, {
      persistenceService: {
        isInitialized: () => true,
        getProvider: () => svc.getProvider(),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`SKIP: no reachable DB configured (config/persistence init failed): ${msg}`);
    process.exit(0);
  }

  // 2. Pick a real workspace session id.
  const sessions = await provider.listSessions();
  const workspaceId = sessions[0]?.sessionId;
  if (!workspaceId) {
    console.log("SKIP: no workspace sessions in the DB to probe with.");
    process.exit(0);
  }

  // 3. Boot the real cockpit server on a random port.
  const { createCockpitServer } = await import("../src/cockpit/server");
  const app = createCockpitServer();
  const httpServer = app.listen(0);
  await new Promise<void>((resolve) => httpServer.once("listening", () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const probe = async (id: string): Promise<{ status: number; code: unknown }> => {
    const res = await fetch(
      `${base}/api/cockpit/context-inspector/snapshot?sessionId=${encodeURIComponent(id)}`
    );
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: unknown } };
    return { status: res.status, code: body.error?.code };
  };

  try {
    const ws = await probe(workspaceId);
    const rnd = await probe(randomUUID());

    const wsOk = ws.status === 422 && ws.code === "wrong_id_space";
    const rndOk = rnd.status === 404 && rnd.code === "session_not_found";

    const report = {
      result: wsOk && rndOk ? "PASS" : "FAIL",
      workspaceIdProbe: { expected: "422 wrong_id_space", got: `${ws.status} ${String(ws.code)}` },
      randomIdProbe: {
        expected: "404 session_not_found",
        got: `${rnd.status} ${String(rnd.code)}`,
      },
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(wsOk && rndOk ? 0 : 1);
  } finally {
    httpServer.close();
  }
}

void main();
