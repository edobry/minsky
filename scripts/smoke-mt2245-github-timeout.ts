#!/usr/bin/env bun
/**
 * Smoke test for mt#2245 — bounded Octokit network timeout.
 *
 * Verifies the happy path is unaffected: an Octokit client built with the same
 * `createTimeoutFetch()` wrapper the github-issues backend now uses completes a
 * real `issues.listForRepo` call against edobry/minsky in well under the 30s
 * deadline. (The timeout/abort path is covered deterministically by the unit
 * test packages/domain/src/github/octokit-timeout.test.ts.)
 *
 * Gates on a GitHub token; exits 0 with SKIP when absent.
 *
 *   GITHUB_TOKEN=... bun run smoke:gh-timeout
 *   # or: GITHUB_TOKEN=... bun scripts/smoke-mt2245-github-timeout.ts
 *
 * Discoverable via the `smoke:gh-timeout` package.json script. Not wired into
 * CI by default (needs a live token); run manually when touching the
 * github-issues Octokit path or the createTimeoutFetch wrapper.
 */
import { Octokit } from "@octokit/rest";
import { createTimeoutFetch } from "../packages/domain/src/github/octokit-timeout";

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!token) {
  console.log("SKIP: GITHUB_TOKEN / GH_TOKEN not set — cannot run live GitHub smoke.");
  process.exit(0);
}

const octokit = new Octokit({
  auth: token,
  userAgent: "minsky-cli",
  request: { retries: 3, retryAfter: 30, fetch: createTimeoutFetch() },
});

const start = performance.now();
try {
  const res = await octokit.rest.issues.listForRepo({
    owner: "edobry",
    repo: "minsky",
    per_page: 1,
  });
  const elapsedMs = Math.round(performance.now() - start);
  const ok = res.status === 200 && elapsedMs < 10_000;
  console.log(
    JSON.stringify(
      { ok, status: res.status, elapsedMs, returned: res.data.length, deadlineMs: 30_000 },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 1);
} catch (err) {
  const elapsedMs = Math.round(performance.now() - start);
  console.log(JSON.stringify({ ok: false, elapsedMs, error: (err as Error).message }, null, 2));
  process.exit(1);
}
