#!/usr/bin/env bun
/**
 * Live verification for mt#3121 — the REAL binding of resolveTaskClaimLiveness
 * against the shared Postgres presence_claims table.
 *
 * The pure classifier (classifyFreshPeerClaim) is unit-tested; the command's
 * contested branch is tested through an injected seam. This script closes the
 * binding-direction gap (mt#2508 R3): it exercises the actual DB read the real
 * DispatchRecoveryActivityOps.taskClaimLiveness delegates to, so a dead binding
 * (wrong subject-id normalization, wrong repo import) is caught here rather than
 * silently degrading to "no-fresh-claim" (abstain) in production.
 *
 * Verifies against real rows:
 *   1. a fresh PEER claim + the caller's own claim -> contested, peer surfaced,
 *      caller excluded (SC1/SC4).
 *   2. self-exclusion is symmetric: calling as the peer surfaces the other actor.
 *   3. only the caller's own claim present -> no-fresh-claim (abstain).
 * Cleans up every probe row it writes.
 *
 * Usage: bun scripts/verify-task-claim-liveness.ts
 * Gated on ~/.config/minsky/config.yaml's postgres connectionString; exits 0
 * with a SKIP message when it is absent.
 */

import "reflect-metadata";
import { readFile } from "fs/promises";
import { homedir } from "os";
import yaml from "js-yaml";
import { PostgresPersistenceProvider } from "../packages/domain/src/persistence/providers/postgres-provider";
import { buildPresenceClaimRepository } from "../packages/domain/src/presence/index";
import { normalizeTaskSubjectId } from "../packages/domain/src/presence/normalize";
import { resolveTaskClaimLiveness } from "../packages/domain/src/session/task-claim-liveness";

const PROBE_TASK = "mt#999121";
const SUBJECT_ID = normalizeTaskSubjectId(PROBE_TASK); // "mt999121"
const PEER_ACTOR = "__mt3121_smoke_peer__";
const CALLER_ACTOR = "__mt3121_smoke_caller__";
const LOG = "task-claim-liveness-smoke";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[verify] FAIL — ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`[verify] PASS — ${msg}`);
}

const configPath = `${homedir()}/.config/minsky/config.yaml`;
let connectionString: string | undefined;
try {
  const raw = await readFile(configPath, "utf-8");
  const cfg = yaml.load(raw) as { persistence?: { postgres?: { connectionString?: string } } };
  connectionString = cfg?.persistence?.postgres?.connectionString;
} catch {
  connectionString = undefined;
}
if (!connectionString) {
  console.log("[verify] SKIP: no postgres connectionString in ~/.config/minsky/config.yaml");
  process.exit(0);
}

const provider = new PostgresPersistenceProvider({
  backend: "postgres",
  postgres: { connectionString },
});
await provider.initialize();

const db = await provider.getDatabaseConnection();
const repo = buildPresenceClaimRepository(db);
if (!repo) throw new Error("could not build presence claim repository");

async function cleanup(r: NonNullable<typeof repo>): Promise<void> {
  const n = await r.deleteBySubject("task", SUBJECT_ID);
  console.log(`[verify] cleanup: deleted ${n} probe claim(s) for ${SUBJECT_ID}`);
}

try {
  // Start clean in case a prior aborted run left probe rows.
  await cleanup(repo);

  await repo.upsertClaim({ subjectKind: "task", subjectId: SUBJECT_ID, actorId: PEER_ACTOR });
  await repo.upsertClaim({ subjectKind: "task", subjectId: SUBJECT_ID, actorId: CALLER_ACTOR });

  // 1. As the caller: the peer is surfaced, the caller's own claim is excluded.
  const asCaller = await resolveTaskClaimLiveness(PROBE_TASK, CALLER_ACTOR, provider, {
    source: LOG,
  });
  console.log(`[verify] asCaller ->`, JSON.stringify(asCaller));
  assert(asCaller.cause === "contested", "a fresh peer claim yields contested (SC1)");
  assert(
    asCaller.peerActorId === PEER_ACTOR,
    "the surfaced peer is the OTHER actor, not the caller (SC4)"
  );

  // 2. Symmetric self-exclusion: as the peer, the other actor is surfaced.
  const asPeer = await resolveTaskClaimLiveness(PROBE_TASK, PEER_ACTOR, provider, { source: LOG });
  console.log(`[verify] asPeer ->`, JSON.stringify(asPeer));
  assert(asPeer.cause === "contested", "still contested when the roles are swapped");
  assert(asPeer.peerActorId === CALLER_ACTOR, "self-exclusion is symmetric");

  // 3. Only the caller's own claim present -> abstain.
  await cleanup(repo);
  await repo.upsertClaim({ subjectKind: "task", subjectId: SUBJECT_ID, actorId: CALLER_ACTOR });
  const onlySelf = await resolveTaskClaimLiveness(PROBE_TASK, CALLER_ACTOR, provider, {
    source: LOG,
  });
  console.log(`[verify] onlySelf ->`, JSON.stringify(onlySelf));
  assert(
    onlySelf.cause === "no-fresh-claim",
    "only-caller claim abstains, not contested (SC4/AT2)"
  );
} finally {
  await cleanup(repo);
  await provider.close?.();
}

console.log("[verify] Live verification COMPLETE — mt#3121 task-claim binding is operational.");
