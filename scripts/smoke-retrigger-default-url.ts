#!/usr/bin/env bun
/**
 * Drift guard for `reviewer.retrigger`'s default reviewer-webhook URL (mt#2359).
 *
 * The default host is a cached constant (`DEFAULT_REVIEWER_URL`) — the public
 * Railway domain can't be cheaply derived at runtime (deploy.config.ts holds
 * Railway IDs, not the hostname; live derivation needs Railway API creds the
 * operator lacks). A cached constant is therefore correct — but it can silently
 * drift from the deployed reality, which is exactly what happened: the value
 * shipped (mt#2269, mt#2346) without `-production` and 404'd, undetected, because
 * nothing ever exercised the default path.
 *
 * This probes `GET <DEFAULT_REVIEWER_URL>/health` and asserts 200, so a future
 * drift to a dead host is caught mechanically. `/health` is public — no auth.
 *
 * Exit codes: 0 = pass OR skipped (offline); 1 = the default host did not return
 * a healthy 200 (drift / dead host).
 *
 * Usage:
 *   bun scripts/smoke-retrigger-default-url.ts
 *   SKIP_REVIEWER_URL_SMOKE=1 bun scripts/smoke-retrigger-default-url.ts   # force-skip
 */

import { DEFAULT_REVIEWER_URL } from "../src/adapters/shared/commands/reviewer-retrigger";
// Relative import (not the `@minsky/shared/*` workspace alias): this script runs
// ad hoc from the non-package `scripts/` context via `bun scripts/...`, where the
// workspace alias is not guaranteed to resolve. `src/utils/safe-truncate` re-exports it.
import { safeTruncate } from "../src/utils/safe-truncate";
// Same relative-import rationale as above — this script runs from the
// non-package `scripts/` context where `@minsky/domain/*` is not guaranteed.
import {
  assertServiceIdentity,
  describeHealthIdentityResult,
  SERVICE_IDENTITIES,
} from "../packages/domain/src/deployment/health-identity";

const SKIP_ENV = "SKIP_REVIEWER_URL_SMOKE";

async function main(): Promise<number> {
  if (["1", "true", "yes"].includes((process.env[SKIP_ENV] ?? "").toLowerCase())) {
    console.log(`SKIP: ${SKIP_ENV} set; skipping reviewer default-URL drift guard.`);
    return 0;
  }

  const url = `${DEFAULT_REVIEWER_URL.replace(/\/$/, "")}/health`;
  console.log(`Probing reviewer default-URL health: ${url}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Network failure (offline, DNS, timeout) is NOT a drift signal — skip.
    const message = err instanceof Error ? err.message : String(err);
    console.log(`SKIP: could not reach the default reviewer host (offline?): ${message}`);
    return 0;
  }

  const body = await res.text().catch(() => "");

  if (res.status === 200) {
    // mt#3148: a 200 alone is NOT a pass. mt#3142 is the proof — the Minsky MCP
    // server was deployed onto this exact host and answered /health 200 for ~1h
    // while every reviewer route 404'd, so this probe stayed green through the
    // entire outage. Assert the service IDENTITY, which only the reviewer emits.
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
    const identity = assertServiceIdentity(parsed, SERVICE_IDENTITIES.reviewer);
    if (!identity.ok) {
      // Report the two failure modes DISTINCTLY. `wrong-service` is the mt#3142
      // signature — a different application is genuinely deployed here.
      // `missing-identity` is weaker and must not be described as the same
      // thing: the correct service may well be running and simply predate the
      // mt#3148 field (expected between this task's merge and that service's
      // next deploy). Collapsing them would be the same overclaiming this guard
      // exists to prevent.
      const diagnosis =
        identity.reason === "wrong-service"
          ? `This is the mt#3142 signature: a healthy-looking host serving a DIFFERENT application.`
          : `Cannot confirm which application is deployed here. If this service has not ` +
            `redeployed since mt#3148 merged, that is the expected transient; otherwise treat ` +
            `it as unidentified and investigate.`;
      console.error(
        `FAIL: ${DEFAULT_REVIEWER_URL} answered HTTP 200 but its identity could not be ` +
          `confirmed — ${describeHealthIdentityResult(identity)}. ${diagnosis}`
      );
      console.error(
        JSON.stringify({
          ok: false,
          url,
          status: res.status,
          identity,
          body: safeTruncate(body, 200, "head"),
        })
      );
      return 1;
    }

    console.log(
      `PASS: ${DEFAULT_REVIEWER_URL} is live (HTTP 200) and ${describeHealthIdentityResult(identity)}.`
    );
    console.log(
      JSON.stringify({ ok: true, url, status: res.status, body: safeTruncate(body, 200, "head") })
    );
    return 0;
  }

  console.error(
    `FAIL: default reviewer host returned HTTP ${res.status} — DEFAULT_REVIEWER_URL has drifted ` +
      `from the deployed reality (a 404 here is the mt#2359 regression class).`
  );
  console.error(
    JSON.stringify({ ok: false, url, status: res.status, body: safeTruncate(body, 200, "head") })
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: unexpected error", err);
    process.exit(1);
  });
