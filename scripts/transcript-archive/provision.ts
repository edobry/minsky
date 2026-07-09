#!/usr/bin/env bun
/**
 * Provision the transcript raw-archive bucket (mt#2680 / ADR-025).
 *
 * Idempotent: creates the PRIVATE Supabase Storage bucket if it does not
 * exist, and verifies the security posture (public === false) either way.
 * A PUBLIC bucket is a security violation (transcripts can contain secrets
 * and PII) — this script fails loudly on one and, with --execute, flips it
 * back to private.
 *
 * DRY-RUN BY DEFAULT. Pass --execute to create/update the bucket.
 *
 * Exit codes: 0 = pass or SKIP (credentials not configured), 1 = failure
 * or posture violation (dry-run mode reports the violation without fixing).
 *
 * Usage:
 *   bun scripts/transcript-archive/provision.ts             # preview/verify
 *   bun scripts/transcript-archive/provision.ts --execute   # create/fix
 */

import { StorageClient } from "@supabase/storage-js";

import { resolveArchiveScriptConfig } from "./lib";

const args = process.argv.slice(2);
const execute = args.includes("--execute");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: bun scripts/transcript-archive/provision.ts [--execute]

Creates (or posture-verifies) the PRIVATE Supabase Storage bucket for the
transcript raw archive. Dry-run by default; --execute applies changes.

Credential resolution: MINSKY_SUPABASE_URL / MINSKY_SUPABASE_SERVICE_ROLE_KEY
(or SUPABASE_* variants), else supabase.url / supabase.serviceRoleKey in
~/.config/minsky/config.yaml. Bucket: MINSKY_TRANSCRIPT_ARCHIVE_BUCKET, else
transcriptArchive.bucket, else "agent-transcript-archive".
`);
  process.exit(0);
}

interface ProvisionResult {
  bucket: string;
  mode: "dry-run" | "execute";
  action: "created" | "already-private" | "would-create" | "made-private" | "public-violation";
  publicFlag: boolean | null;
  ok: boolean;
}

async function main(): Promise<void> {
  const config = await resolveArchiveScriptConfig();
  if (!config) process.exit(0); // SKIP (message already printed)

  const storage = new StorageClient(`${config.url}/storage/v1`, {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
  });

  const existing = await storage.getBucket(config.bucket);
  const mode = execute ? "execute" : "dry-run";
  let result: ProvisionResult;

  if (existing.error && !/not.*found/i.test(existing.error.message)) {
    console.error(`FAIL: could not read bucket ${config.bucket}: ${existing.error.message}`);
    process.exit(1);
  }

  if (existing.data) {
    if (existing.data.public) {
      if (execute) {
        const updated = await storage.updateBucket(config.bucket, { public: false });
        if (updated.error) {
          console.error(
            `FAIL: bucket ${config.bucket} is PUBLIC and update-to-private failed: ${updated.error.message}`
          );
          process.exit(1);
        }
        const readBack = await storage.getBucket(config.bucket);
        const stillPublic = readBack.data?.public ?? true;
        result = {
          bucket: config.bucket,
          mode,
          action: "made-private",
          publicFlag: stillPublic,
          ok: !stillPublic,
        };
      } else {
        result = {
          bucket: config.bucket,
          mode,
          action: "public-violation",
          publicFlag: true,
          ok: false,
        };
      }
    } else {
      result = {
        bucket: config.bucket,
        mode,
        action: "already-private",
        publicFlag: false,
        ok: true,
      };
    }
  } else if (execute) {
    const created = await storage.createBucket(config.bucket, { public: false });
    if (created.error) {
      console.error(`FAIL: createBucket ${config.bucket}: ${created.error.message}`);
      process.exit(1);
    }
    // Read-back verification — never trust the create call alone.
    const readBack = await storage.getBucket(config.bucket);
    if (readBack.error || !readBack.data) {
      console.error(
        `FAIL: bucket ${config.bucket} not readable after create: ${readBack.error?.message ?? "no data"}`
      );
      process.exit(1);
    }
    result = {
      bucket: config.bucket,
      mode,
      action: "created",
      publicFlag: readBack.data.public,
      ok: readBack.data.public === false,
    };
  } else {
    result = { bucket: config.bucket, mode, action: "would-create", publicFlag: null, ok: true };
    console.log(
      `DRY-RUN: bucket ${config.bucket} does not exist; would create it PRIVATE. Re-run with --execute.`
    );
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

await main();
