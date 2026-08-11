/**
 * Shared credential/config resolution for the transcript-archive scripts
 * (mt#2680). Mirrors the scripts/supabase/restart-project.ts convention:
 * env vars first, then ~/.config/minsky/config.yaml.
 *
 * Resolution order:
 *   url:            MINSKY_SUPABASE_URL → SUPABASE_URL → config supabase.url
 *   serviceRoleKey: MINSKY_SUPABASE_SERVICE_ROLE_KEY → SUPABASE_SERVICE_ROLE_KEY
 *                   → config supabase.serviceRoleKey
 *   bucket:         MINSKY_TRANSCRIPT_ARCHIVE_BUCKET → config transcriptArchive.bucket
 *                   → "agent-transcript-archive"
 *
 * NEVER print the serviceRoleKey — it bypasses RLS on the whole project.
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";

import { DEFAULT_TRANSCRIPT_ARCHIVE_BUCKET } from "@minsky/domain/storage/archive/transcript-archive-store";

export interface ArchiveScriptConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
  /** Where each value came from (for diagnostics; never contains secrets). */
  sources: { url: string; serviceRoleKey: string; bucket: string };
}

interface MinskyConfigYamlShape {
  supabase?: { url?: string; serviceRoleKey?: string };
  transcriptArchive?: { bucket?: string };
}

async function readMinskyConfigYaml(): Promise<MinskyConfigYamlShape> {
  try {
    const raw = await readFile(join(homedir(), ".config", "minsky", "config.yaml"), "utf8");
    const parsed: unknown = parseYaml(raw);
    return (parsed ?? {}) as MinskyConfigYamlShape;
  } catch {
    return {};
  }
}

/**
 * Resolve archive credentials, or null when they are not configured
 * (callers SKIP gracefully — exit 0 — per the verification-artifact
 * convention).
 */
export async function resolveArchiveScriptConfig(): Promise<ArchiveScriptConfig | null> {
  const yaml = await readMinskyConfigYaml();

  const url =
    process.env["MINSKY_SUPABASE_URL"] ?? process.env["SUPABASE_URL"] ?? yaml.supabase?.url;
  const urlSource = process.env["MINSKY_SUPABASE_URL"]
    ? "env:MINSKY_SUPABASE_URL"
    : process.env["SUPABASE_URL"]
      ? "env:SUPABASE_URL"
      : yaml.supabase?.url
        ? "config:supabase.url"
        : "missing";

  const serviceRoleKey =
    process.env["MINSKY_SUPABASE_SERVICE_ROLE_KEY"] ??
    process.env["SUPABASE_SERVICE_ROLE_KEY"] ??
    yaml.supabase?.serviceRoleKey;
  const keySource = process.env["MINSKY_SUPABASE_SERVICE_ROLE_KEY"]
    ? "env:MINSKY_SUPABASE_SERVICE_ROLE_KEY"
    : process.env["SUPABASE_SERVICE_ROLE_KEY"]
      ? "env:SUPABASE_SERVICE_ROLE_KEY"
      : yaml.supabase?.serviceRoleKey
        ? "config:supabase.serviceRoleKey"
        : "missing";

  const bucket =
    process.env["MINSKY_TRANSCRIPT_ARCHIVE_BUCKET"] ??
    yaml.transcriptArchive?.bucket ??
    DEFAULT_TRANSCRIPT_ARCHIVE_BUCKET;
  const bucketSource = process.env["MINSKY_TRANSCRIPT_ARCHIVE_BUCKET"]
    ? "env:MINSKY_TRANSCRIPT_ARCHIVE_BUCKET"
    : yaml.transcriptArchive?.bucket
      ? "config:transcriptArchive.bucket"
      : "default";

  if (!url || !serviceRoleKey) {
    console.log(
      `SKIP: transcript-archive credentials not configured ` +
        `(url: ${urlSource}, serviceRoleKey: ${keySource}). ` +
        `Set MINSKY_SUPABASE_URL + MINSKY_SUPABASE_SERVICE_ROLE_KEY or the ` +
        `supabase.url / supabase.serviceRoleKey keys in ~/.config/minsky/config.yaml.`
    );
    return null;
  }

  return {
    url: url.replace(/\/+$/, ""),
    serviceRoleKey,
    bucket,
    sources: { url: urlSource, serviceRoleKey: keySource, bucket: bucketSource },
  };
}
