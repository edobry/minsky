#!/usr/bin/env bun
/**
 * Verify that a specific merge actually deployed (mt#4425).
 *
 * ## Usage
 *
 * ```
 * bun scripts/verify-deploy.ts <service> --merged-at <iso> [--commit <sha>]
 * ```
 *
 * Example, verifying the merge that prompted this script:
 *
 * ```
 * bun scripts/verify-deploy.ts minsky-mcp \
 *   --merged-at 2026-08-22T03:35:21Z --commit b045a3405
 * ```
 *
 * ## Why this exists
 *
 * Verifying a deploy by hand means assembling four things — the Railway ids,
 * a time bound, a commit check, and a health probe — and every step has a way
 * of passing without meaning anything. This packages the chain so verification
 * is one command instead of a re-derivation per incident, per
 * `decision-defaults.mdc §Turnkey, not portal`.
 *
 * ## A healthy /health is NOT evidence that your change deployed
 *
 * This is the point the whole script is built around, so it is worth stating
 * plainly rather than leaving implicit in the code:
 *
 *  - `/health` returns 200 on the OLD image. It answers "is something running
 *    here", never "is YOUR change running here". A green health check is
 *    perfectly compatible with a deploy that never happened.
 *  - Worse, a 200 does not even establish that the RIGHT application is on the
 *    host. Every Minsky service is built from the same monorepo, so a
 *    misconfigured build can serve a different service that answers 200 exactly
 *    like the right one (mt#3142: the MCP server served the reviewer's host for
 *    ~1h while every reviewer route 404'd). That is why the health step here
 *    asserts the body's `service` identity via `assertServiceIdentity`, not the
 *    status code.
 *  - Time alone is not identity either. A neighbouring merge's deployment lands
 *    inside your window and satisfies a `notBefore` bound (mt#4583, observed
 *    2026-08-25). Pass `--commit` to get a `buildIdentity` verdict.
 *
 * The strongest available check is none of the above: assert something only the
 * NEW CODE can satisfy — the migrated column present, the new route answering,
 * the new field in a payload. This script cannot know what that is for your
 * change, so it prints a reminder rather than pretending the chain is complete.
 *
 * ## Exit codes
 *
 *   0  every requested check passed
 *   1  a check failed (no deployment since the merge, a failed deploy, a
 *      build-identity mismatch, a health/identity failure, or an indeterminate
 *      build identity when `--require-identity` was passed)
 *   2  the script could not run (bad arguments, unknown service, missing
 *      credentials)
 *
 * Missing Railway credentials are exit 2, deliberately NOT a graceful exit-0
 * skip. A verification tool that silently passes when it cannot verify is the
 * failure mode this script exists to remove (mem#704: a probe that returns the
 * same answer whether or not the system is broken carries no information).
 * Pass `--skip-if-unconfigured` to opt into exit-0-on-no-credentials for CI
 * contexts where absence is expected.
 */

// Must precede the domain imports: the deployment barrel reaches tsyringe,
// which throws at module-load without the polyfill. A typecheck cannot catch
// that — only running the script can (the mt#2760 lesson).
import "reflect-metadata";

import {
  resolveDeploymentConfig,
  resolveAdapter,
  assessBuildIdentity,
  NoDeploymentSinceError,
} from "@minsky/domain/deployment";
import {
  assertServiceIdentity,
  describeHealthIdentityResult,
  identityForServiceDir,
} from "@minsky/domain/deployment/health-identity";

const EXIT_OK = 0;
const EXIT_CHECK_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

interface Args {
  service: string;
  mergedAt: string;
  commit?: string;
  timeoutSeconds: number;
  skipIfUnconfigured: boolean;
  requireIdentity: boolean;
}

function usage(): string {
  return [
    "Usage: bun scripts/verify-deploy.ts <service> --merged-at <iso> [options]",
    "",
    "  <service>                 Service name, matching services/<name>/deploy.config.ts",
    "  --merged-at <iso>         ISO8601 merge timestamp. A deployment created before",
    "                            this instant will NOT satisfy the check.",
    "  --commit <sha>            Merge commit. Without it the script cannot tell WHICH",
    "                            change deployed, only that A deployment happened.",
    "  --timeout-seconds <n>     How long to wait for a terminal deployment (default 600).",
    "  --skip-if-unconfigured    Exit 0 instead of 2 when Railway credentials are absent.",
    "  --require-identity        Treat an INDETERMINATE build identity as a failure (exit 1).",
    "                            Use in CI: without it, a deploy whose commit could not be",
    "                            established still exits 0, which reads as verified.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args | { error: string } {
  const positional: string[] = [];
  let mergedAt: string | undefined;
  let commit: string | undefined;
  let timeoutSeconds = 600;
  let skipIfUnconfigured = false;
  let requireIdentity = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--merged-at":
        mergedAt = argv[++i];
        break;
      case "--commit":
        commit = argv[++i];
        break;
      case "--timeout-seconds": {
        const raw = argv[++i];
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { error: `--timeout-seconds expects a positive number, got ${String(raw)}` };
        }
        timeoutSeconds = parsed;
        break;
      }
      case "--skip-if-unconfigured":
        skipIfUnconfigured = true;
        break;
      case "--require-identity":
        requireIdentity = true;
        break;
      case "-h":
      case "--help":
        return { error: "help" };
      default:
        if (arg !== undefined && arg.startsWith("--")) return { error: `Unknown option: ${arg}` };
        if (arg !== undefined) positional.push(arg);
    }
  }

  const service = positional[0];
  if (!service) return { error: "A <service> argument is required." };
  if (!mergedAt) return { error: "--merged-at <iso> is required." };
  if (Number.isNaN(Date.parse(mergedAt))) {
    return { error: `--merged-at is not a parseable ISO8601 timestamp: ${mergedAt}` };
  }

  return { service, mergedAt, commit, timeoutSeconds, skipIfUnconfigured, requireIdentity };
}

/**
 * Railway credentials come from `~/.railway/config.json` (the Railway CLI's own
 * store), so "unconfigured" surfaces as a throw from deep inside the adapter
 * rather than a missing env var we can test up front. Recognise it by shape.
 */
function looksLikeMissingCredentials(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not authoriz|unauthorized|no railway token|config\.json|not logged in|401/i.test(message);
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(EXIT_CHECK_FAILED);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    if (parsed.error !== "help") console.error(`error: ${parsed.error}\n`);
    console.error(usage());
    process.exit(parsed.error === "help" ? EXIT_OK : EXIT_CANNOT_RUN);
  }

  const { service, mergedAt, commit, timeoutSeconds, skipIfUnconfigured, requireIdentity } = parsed;

  console.log(`Verifying deploy of ${service}`);
  console.log(`  merged at: ${mergedAt}`);
  console.log(`  commit:    ${commit ?? "(not supplied — identity will be indeterminate)"}`);
  console.log("");

  // ---------------------------------------------------------------------
  // Step 1 — resolve the service's declared deploy config.
  // The Railway ids live in services/<svc>/deploy.config.ts, which is the
  // declared source of truth; this script never takes them as arguments.
  // ---------------------------------------------------------------------
  let config;
  try {
    ({ config } = await resolveDeploymentConfig(service));
  } catch (err) {
    console.error(`FAIL: could not load services/${service}/deploy.config.ts`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CANNOT_RUN);
  }
  console.log(`[1/3] config       OK — platform ${config.platform}`);

  // ---------------------------------------------------------------------
  // Step 2 — a deployment created AFTER the merge reached a terminal state.
  // notBefore is what makes this able to fail: without it the wait returns
  // whatever is newest, which can be an arbitrarily old deployment (mt#3890).
  // ---------------------------------------------------------------------
  const adapter = resolveAdapter(config);
  let record;
  try {
    record = await adapter.waitForLatestDeployment({
      timeoutSeconds,
      notBefore: mergedAt,
      onProgress: (message: string) => console.log(`      ...${message}`),
    });
  } catch (err) {
    if (err instanceof NoDeploymentSinceError) {
      fail(
        `no deployment was created after ${mergedAt}. This means nothing was ever ` +
          `triggered — NOT that a deploy is still building. Go find out why it did not fire.`
      );
    }
    if (looksLikeMissingCredentials(err)) {
      const detail = err instanceof Error ? err.message : String(err);
      if (skipIfUnconfigured) {
        console.log(`SKIP: Railway credentials not configured (${detail})`);
        process.exit(EXIT_OK);
      }
      console.error(`FAIL: Railway credentials not configured — cannot verify (${detail})`);
      console.error(`      Run \`railway login\`, or pass --skip-if-unconfigured in CI.`);
      process.exit(EXIT_CANNOT_RUN);
    }
    fail(err instanceof Error ? err.message : String(err));
  }

  if (record.status !== "SUCCESS") {
    fail(
      `deployment ${record.id} finished ${record.status} (created ${record.createdAt}). ` +
        `Inspect with: minsky deployment logs ${record.id} --type build --service ${service}`
    );
  }
  console.log(`[2/3] deployment   OK — ${record.id} SUCCESS (created ${record.createdAt})`);

  // ---------------------------------------------------------------------
  // Step 2b — WHICH change deployed. Time does not answer this: a neighbouring
  // merge's deployment satisfies the notBefore bound just as well (mt#4583).
  // ---------------------------------------------------------------------
  const identity = assessBuildIdentity(record, commit);
  if (identity.identity === "mismatch") {
    fail(
      `a deploy happened, but it is not yours — ${identity.reason} ` +
        `Do not wait for this one to change; go find the deployment for ${commit}.`
    );
  }
  if (identity.identity === "indeterminate") {
    console.log(`      build identity INDETERMINATE — ${identity.reason}`);
    console.log(`      This is NOT a pass. Correlate the workflow run to your merge sha, or`);
    console.log(`      assert something only the new code produces.`);
  } else {
    console.log(`      build identity confirmed — ${identity.reason}`);
  }

  // ---------------------------------------------------------------------
  // Step 3 — health, asserted on the body's service identity, not the status
  // code. See the header: a 200 alone cannot discriminate the failure this
  // step exists to catch.
  // ---------------------------------------------------------------------
  const healthUrl = config.healthUrl;
  if (!healthUrl) {
    console.log(
      `[3/3] health       SKIPPED — services/${service}/deploy.config.ts declares no healthUrl`
    );
  } else {
    const expected = identityForServiceDir(service);
    let body: unknown;
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) fail(`GET ${healthUrl} returned HTTP ${res.status}`);
      body = await res.json().catch(() => null);
    } catch (err) {
      fail(`GET ${healthUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!expected) {
      console.log(`[3/3] health       200, identity NOT asserted — no canonical identity for`);
      console.log(`      services/${service}. A 200 alone is not evidence your change shipped.`);
    } else {
      const result = assertServiceIdentity(body, expected);
      if (!result.ok) fail(describeHealthIdentityResult(result));
      console.log(`[3/3] health       OK — ${describeHealthIdentityResult(result)}`);
    }
  }

  console.log("");
  if (identity.identity === "confirmed") {
    console.log(`VERIFIED: ${service} is running the build for ${commit}.`);
  } else {
    console.log(
      `PARTIAL: a deployment postdating the merge succeeded and ${service} is healthy, ` +
        `but WHICH change it carries was not established.`
    );
    console.log(`Pass --commit <merge-sha>, or assert something only the new code can satisfy.`);
    if (requireIdentity) {
      console.error("");
      console.error(
        "FAIL: --require-identity was set and build identity is not confirmed. " +
          "Reporting this run as a pass would claim a verification that did not happen."
      );
      process.exit(EXIT_CHECK_FAILED);
    }
  }
  process.exit(EXIT_OK);
}

await main();
