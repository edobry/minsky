#!/usr/bin/env bun
/**
 * Smoke test / live verification for session runtime-attachment (mt#2284).
 *
 * Exercises the session grain (subject_kind = "session") of the mt#2562
 * presence-claim substrate against the real Postgres DB, plus the local
 * `lsof -d cwd` cross-check that `session ps` joins against.
 *
 * Resolves the DB connection via Minsky's own configuration system (same
 * path drizzle-kit's config loader uses) rather than requiring DATABASE_URL
 * to be set directly — mirrors scripts/smoke-presence-claims.ts's pattern,
 * generalized to not skip when only the raw env var is absent.
 *
 * Usage:
 *   bun scripts/smoke-session-attachment.ts [sessionId]
 *
 * With no argument, uses a synthetic session id (safe — presence_claims has
 * no FK to the sessions table, subject_id is a plain text column).
 */

import "reflect-metadata";
import { hostname } from "node:os";

async function main() {
  const sessionIdArg = process.argv[2];
  const sessionId = sessionIdArg || `smoke-session-${Date.now()}`;

  console.log(`[smoke-session-attachment] Target session: ${sessionId}`);

  const { loadConfiguration } = await import("@minsky/domain/configuration/loader");
  const configResult = await loadConfiguration();
  const connectionString = configResult.config.persistence?.postgres?.connectionString;
  if (!connectionString) {
    console.log(
      "[smoke-session-attachment] No Postgres connection configured — skipping smoke test"
    );
    process.exit(0);
  }

  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { DrizzlePresenceClaimRepository } = await import(
    "../packages/domain/src/presence/repository"
  );
  const { buildSessionPsReport, isPidAlive } = await import("../packages/domain/src/session/index");
  const { getSessionsDir } = await import("@minsky/shared/paths");

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);
  const repo = new DrizzlePresenceClaimRepository(db);

  const idsToCleanUp: string[] = [];
  let sleepPid: number | undefined;

  try {
    // ── 1. Spawn a real, long-lived process whose cwd is the session workspace ──
    console.log("[smoke-session-attachment] 1. Spawning a live process with session-dir cwd...");
    const sessionsDir = getSessionsDir();
    const sessionWorkdir = `${sessionsDir}/${sessionId}`;
    const { mkdirSync, existsSync } = await import("node:fs");
    if (!existsSync(sessionWorkdir)) {
      mkdirSync(sessionWorkdir, { recursive: true });
    }
    const proc = Bun.spawn(["sleep", "30"], { cwd: sessionWorkdir });
    sleepPid = proc.pid;
    console.log(`  Spawned pid ${sleepPid} with cwd ${sessionWorkdir}`);
    // Give lsof a moment to observe the new process.
    await new Promise((r) => setTimeout(r, 300));

    // ── 2. Self-register an attachment for the live process ──────────────────
    console.log("[smoke-session-attachment] 2. Registering live attachment claim...");
    const liveClaim = await repo.upsertClaim({
      subjectKind: "session",
      subjectId: sessionId,
      actorId: "smoke-actor-live",
      pid: sleepPid,
      host: hostname(),
      entrypoint: "smoke-test",
      terminalContext: { TERM: process.env.TERM ?? "" },
    });
    idsToCleanUp.push(liveClaim.id);
    console.log(`  Registered claim ${liveClaim.id} (pid=${sleepPid})`);

    // ── 3. Register a second, stored-but-dead attachment ──────────────────────
    console.log("[smoke-session-attachment] 3. Registering stored-but-dead attachment claim...");
    const DEAD_PID = 999999999;
    if (isPidAlive(DEAD_PID)) {
      throw new Error("Smoke-test invariant violated: DEAD_PID is unexpectedly alive");
    }
    const deadClaim = await repo.upsertClaim({
      subjectKind: "session",
      subjectId: sessionId,
      actorId: "smoke-actor-dead",
      pid: DEAD_PID,
      host: hostname(),
    });
    idsToCleanUp.push(deadClaim.id);
    console.log(`  Registered claim ${deadClaim.id} (pid=${DEAD_PID}, confirmed dead)`);

    // ── 4. Run the session-ps report (stored + lsof cross-check) ─────────────
    console.log("[smoke-session-attachment] 4. Building session-ps report...");
    const fullReport = await buildSessionPsReport(repo, sessionsDir);
    const entry = fullReport.find((e) => e.sessionId === sessionId);
    if (!entry) {
      throw new Error(`Expected a session-ps entry for ${sessionId}, found none`);
    }

    console.log(`  attachments (stored):    ${entry.attachments.length}`);
    console.log(`  liveProcesses (lsof):    ${entry.liveProcesses.length}`);
    console.log(`  storedNotLive:           ${entry.storedNotLive.map((a) => a.actorId)}`);
    console.log(`  liveNotStored (pids):    ${entry.liveProcesses.map((p) => p.pid)}`);

    if (entry.attachments.length !== 2) {
      throw new Error(`Expected 2 stored attachments, got ${entry.attachments.length}`);
    }
    if (!entry.liveProcesses.some((p) => p.pid === sleepPid)) {
      throw new Error(`Expected lsof cross-check to find the live sleep pid ${sleepPid}`);
    }
    if (!entry.storedNotLive.some((a) => a.actorId === "smoke-actor-dead")) {
      throw new Error(`Expected smoke-actor-dead to be flagged stored-but-not-live`);
    }
    if (entry.storedNotLive.some((a) => a.actorId === "smoke-actor-live")) {
      throw new Error(`smoke-actor-live should NOT be flagged stored-but-not-live`);
    }
    console.log(
      "  OK: live pid cross-checked clean; dead pid correctly flagged stored-but-not-live"
    );

    console.log(JSON.stringify(entry, null, 2));
  } finally {
    // ── Cleanup ────────────────────────────────────────────────────────────
    console.log("[smoke-session-attachment] Cleaning up smoke rows...");
    if (sleepPid) {
      Bun.spawnSync(["kill", String(sleepPid)]);
    }
    if (idsToCleanUp.length > 0) {
      await repo.deleteByIds(idsToCleanUp);
    }
    await client.end();
  }

  console.log("[smoke-session-attachment] All smoke checks passed.");
}

main().catch((err) => {
  console.error("[smoke-session-attachment] FAILED:", err);
  process.exit(1);
});
