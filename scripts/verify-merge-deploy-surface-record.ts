#!/usr/bin/env bun
// Live-exercise the mt#4089 domain-side merge-deploy-surface recorder against the
// REAL forge, without merging anything.
//
// Why this exists. The unit tests feed `classifyAndRecordMergeDeploySurface` a
// hand-built file list, so they prove the CLASSIFICATION and the WRITE. They cannot
// prove the thing most likely to be wrong in the wiring: that octokit's
// `pulls.listFiles` actually returns objects shaped the way the classifier reads
// them (`filename` / `previous_filename`). A field-name mismatch there produces an
// empty surface list on every merge — indistinguishable, at the consumer, from a
// PR that genuinely touched no deploy surface, because the consumer fails open.
// That is the mt#3574 substitute-runtime lesson applied to a data shape: a probe
// that cannot fail is not verification.
//
// Writes to a SCRATCH path, never the real store, so running it cannot pollute the
// record the detector reads.
//
// Usage:
//   bun scripts/verify-merge-deploy-surface-record.ts <pr-number> [<pr-number> ...]
//
// Exits 0 with a `SKIP:` line when no token is resolvable, so an unattended run is
// safe (same posture as the other local verify scripts — scripts/README.md).
//
// @see mt#4089 — the task this verifies
// @see packages/domain/src/deployment/merge-deploy-surface-record.ts — the module

// Must precede any import that reaches tsyringe (the configuration/auth graph does).
import "reflect-metadata";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfiguration } from "../packages/domain/src/configuration/index";
import { createTokenProvider } from "../packages/domain/src/auth";
import {
  classifyAndRecordMergeDeploySurface,
  parseStore,
  REAL_FS,
} from "../packages/domain/src/deployment/merge-deploy-surface-record";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

async function main(): Promise<number> {
  const prNumbers = process.argv.slice(2).map((a) => Number.parseInt(a, 10));
  if (prNumbers.length === 0 || prNumbers.some((n) => Number.isNaN(n))) {
    console.log("SKIP: no PR number supplied (usage: <pr-number> [...])");
    return 0;
  }

  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const cfg = getConfiguration();
  // Config-sourced owner/repo are routinely undefined in a session workspace — the
  // very reason the production path reads them off the merge result instead. Allow
  // an env override so this script can still exercise the fetch+classify shape there.
  const owner = process.env["VERIFY_GH_OWNER"] || cfg.github?.organization;
  const repo = process.env["VERIFY_GH_REPO"] || cfg.github?.repository;
  if (!owner || !repo) {
    console.log("SKIP: github owner/repo not configured");
    return 0;
  }

  let token = "";
  try {
    token =
      (await createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? "").getUserToken()) ?? "";
  } catch {
    token = "";
  }
  if (!token) token = cfg.github?.token ?? "";
  if (!token) {
    console.log("SKIP: no GitHub token resolvable");
    return 0;
  }

  const { createOctokit } = await import("../packages/domain/src/repository/github-pr-operations");
  const octokit = createOctokit(token);
  const scratch = join(tmpdir(), `merge-deploy-surface-verify-${process.pid}.json`);

  let failures = 0;
  for (const pr of prNumbers) {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pr,
      per_page: 100,
    });

    // The shape assertion this script exists for: if `filename` is absent, the
    // classifier silently sees nothing and every verdict is a false negative.
    const named = files.filter((f) => typeof f.filename === "string" && f.filename.length > 0);
    if (files.length > 0 && named.length !== files.length) {
      console.error(
        `FAIL: PR #${pr} — ${files.length - named.length}/${files.length} entries have no usable \`filename\`; ` +
          "the classifier would under-record this merge."
      );
      failures++;
      continue;
    }

    const key = `verify-pr-${pr}`;
    const record = classifyAndRecordMergeDeploySurface(files, [key], scratch, REAL_FS);
    if (!record) {
      console.error(`FAIL: PR #${pr} — classify+record returned null`);
      failures++;
      continue;
    }

    const readBack = parseStore(REAL_FS.readFile(scratch))[key];
    if (!readBack || readBack.hadDeploySurface !== record.hadDeploySurface) {
      console.error(`FAIL: PR #${pr} — round-trip mismatch (wrote then read back differently)`);
      failures++;
      continue;
    }

    console.log(
      `PASS: PR #${pr} — ${files.length} changed file(s), hadDeploySurface=${record.hadDeploySurface}${
        record.deploySurfaceFiles.length > 0
          ? `, surface: ${record.deploySurfaceFiles.slice(0, 4).join(", ")}${record.deploySurfaceFiles.length > 4 ? ` (+${record.deploySurfaceFiles.length - 4} more)` : ""}`
          : ""
      }`
    );
  }

  console.log(failures === 0 ? "OK: all PRs classified and round-tripped" : `FAILED: ${failures}`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`ERROR: ${getLoggableErrorSummary(err)}`);
    process.exit(1);
  });
