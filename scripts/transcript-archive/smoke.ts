#!/usr/bin/env bun
/**
 * Transcript raw-archive smoke test (mt#2680 / ADR-025) — the live
 * verification artifact for the archive foundation.
 *
 * Exercises the REAL Supabase Storage bucket through the production store
 * (SupabaseTranscriptArchiveStore): put → idempotent re-put → head →
 * get-with-integrity-check → listVersions, plus the security posture
 * probes (public-URL and unauthenticated reads MUST be rejected).
 *
 * Read-mostly and self-cleaning: uploads one small smoke object under the
 * "smoke" harness prefix and removes it afterwards (best-effort).
 *
 * Env-gated: SKIPs (exit 0) when credentials are not configured.
 * Exit codes: 0 = all checks pass (or SKIP), 1 = any check failed.
 * Output: one JSON results object on stdout.
 *
 * Usage: bun scripts/transcript-archive/smoke.ts
 */

import { StorageClient } from "@supabase/storage-js";

import { SupabaseTranscriptArchiveStore } from "@minsky/domain/storage/archive/supabase-transcript-archive-store";
import { encodeContent } from "@minsky/domain/storage/archive/transcript-archive-store";

import { resolveArchiveScriptConfig } from "./lib";

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const config = await resolveArchiveScriptConfig();
  if (!config) process.exit(0); // SKIP (message already printed)

  const store = SupabaseTranscriptArchiveStore.fromCredentials({
    url: config.url,
    serviceRoleKey: config.serviceRoleKey,
    bucket: config.bucket,
  });

  const checks: CheckResult[] = [];
  const record = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
  };

  const sessionId = `smoke-${Date.now().toString(36)}`;
  const content = `{"type":"smoke","note":"mt#2680 archive smoke","ts":"${new Date().toISOString()}"}\n`;
  let key = "";

  try {
    // 1. put
    const ref = await store.putRaw({
      agentSessionId: sessionId,
      harness: "smoke",
      content,
      source: "smoke-script",
    });
    key = ref.key;
    record(
      "put-verified",
      !ref.alreadyExisted && ref.bytes === encodeContent(content).length,
      `key=${ref.key} bytes=${ref.bytes}`
    );

    // 2. idempotent re-put
    const rePut = await store.putRaw({
      agentSessionId: sessionId,
      harness: "smoke",
      content,
      source: "smoke-script",
    });
    record("re-put-idempotent", rePut.alreadyExisted && rePut.key === ref.key, `key=${rePut.key}`);

    // 3. head
    const stat = await store.head(ref.key);
    record(
      "head",
      stat.exists && (stat.bytes === null || stat.bytes === ref.bytes),
      `exists=${stat.exists} bytes=${stat.bytes}`
    );

    // 4. download round-trip (integrity check runs inside getRaw)
    const bytes = await store.getRaw(ref.key);
    record("get-round-trip", new TextDecoder().decode(bytes) === content, `bytes=${bytes.length}`);

    // 5. listVersions includes the object
    const versions = await store.listVersions("smoke", sessionId);
    record(
      "list-versions",
      versions.some((v) => v.key === ref.key),
      `count=${versions.length}`
    );

    // 6. public-URL probe: private buckets must not serve public objects.
    const publicProbe = await fetch(
      `${config.url}/storage/v1/object/public/${config.bucket}/${ref.key}`
    );
    record(
      "public-url-rejected",
      !publicProbe.ok,
      `status=${publicProbe.status} (must not be 200)`
    );

    // 7. unauthenticated direct read must be rejected.
    const anonProbe = await fetch(`${config.url}/storage/v1/object/${config.bucket}/${ref.key}`);
    record(
      "unauthenticated-read-rejected",
      !anonProbe.ok,
      `status=${anonProbe.status} (must not be 200)`
    );
  } catch (error) {
    record("unexpected-error", false, error instanceof Error ? error.message : String(error));
  } finally {
    // Cleanup (best-effort; outside the immutable store abstraction on purpose —
    // the production interface deliberately has no delete).
    if (key) {
      const storage = new StorageClient(`${config.url}/storage/v1`, {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      });
      const removed = await storage.from(config.bucket).remove([key]);
      record("cleanup", !removed.error, removed.error?.message ?? "smoke object removed");
    }
  }

  const failed = checks.filter((check) => !check.pass && check.name !== "cleanup");
  const summary = {
    bucket: config.bucket,
    sources: config.sources,
    checks,
    pass: failed.length === 0,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
