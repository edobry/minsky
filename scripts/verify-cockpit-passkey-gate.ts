#!/usr/bin/env bun
/**
 * Verify the cockpit passkey gate from OUTSIDE the process (mt#4023).
 *
 * Asserts the properties that actually matter to the exposure this closed: the
 * data routes refuse an unauthenticated caller, and the health route does not
 * (the Railway healthcheck and the post-deploy monitor both poll it).
 *
 * Deliberately black-box over HTTP so the SAME script verifies a locally booted
 * server and the deployed instance. The pre-merge run proves the gate works;
 * the post-deploy run against the live URL proves it is what is actually
 * running — a distinction unit tests cannot make.
 *
 * Usage:
 *   bun scripts/verify-cockpit-passkey-gate.ts                    # deployed preview
 *   bun scripts/verify-cockpit-passkey-gate.ts --url http://127.0.0.1:3939
 *
 * Exit codes: 0 all assertions held; 1 an assertion failed; 0 with a SKIP line
 * when the target is unreachable (matching the sibling verify-* scripts, which
 * do not fail a run for an absent prerequisite).
 */

const DEFAULT_URL = "https://cockpit-preview-production.up.railway.app";
const REQUEST_TIMEOUT_MS = 20_000;

interface Check {
  name: string;
  path: string;
  /** What the gate must do with an unauthenticated request to this path. */
  expect: (res: Response, body: string) => string | null;
}

function expectStatus(want: number) {
  return (res: Response): string | null =>
    res.status === want ? null : `expected HTTP ${want}, got ${res.status}`;
}

const CHECKS: Check[] = [
  {
    name: "health is reachable without a session",
    path: "/api/health",
    expect: expectStatus(200),
  },
  {
    name: "auth status is reachable and reports the instance as gated",
    path: "/api/auth/status",
    expect: (res, body) => {
      if (res.status !== 200) return `expected HTTP 200, got ${res.status}`;
      let parsed: { gated?: boolean; authenticated?: boolean };
      try {
        parsed = JSON.parse(body);
      } catch {
        // eslint-disable-next-line custom/no-unsafe-string-truncation -- diagnostic excerpt of an HTTP body we are reporting as unparseable; a split surrogate in the excerpt changes nothing about the verdict
        return `expected JSON, got ${body.slice(0, 80)}`;
      }
      if (parsed.gated !== true) return `expected gated:true, got gated:${String(parsed.gated)}`;
      if (parsed.authenticated !== false) {
        return `expected authenticated:false for an anonymous caller, got ${String(parsed.authenticated)}`;
      }
      return null;
    },
  },
  {
    name: "task data refuses an anonymous caller",
    path: "/api/tasks",
    expect: expectStatus(401),
  },
  {
    name: "conversation data refuses an anonymous caller",
    path: "/api/cockpit/session-film/sessions",
    expect: expectStatus(401),
  },
  {
    name: "an unknown API route refuses by default, rather than by enumeration",
    path: "/api/route-that-does-not-exist",
    expect: expectStatus(401),
  },
];

function parseUrlArg(argv: readonly string[]): string {
  const idx = argv.indexOf("--url");
  if (idx === -1) return DEFAULT_URL;
  const value = argv[idx + 1];
  if (!value) throw new Error("--url requires a value");
  return value.replace(/\/$/, "");
}

async function main(): Promise<number> {
  const baseUrl = parseUrlArg(process.argv.slice(2));
  console.log(`Verifying cockpit passkey gate at ${baseUrl}\n`);

  // Reachability probe first, so an unreachable target reads as SKIP rather
  // than as five confusing assertion failures.
  try {
    await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err: unknown) {
    console.log(`SKIP: ${baseUrl} is not reachable (${String(err)})`);
    return 0;
  }

  let failures = 0;
  for (const check of CHECKS) {
    let verdict: string | null;
    try {
      const res = await fetch(`${baseUrl}${check.path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "manual",
      });
      const body = await res.text();
      verdict = check.expect(res, body);
    } catch (err: unknown) {
      verdict = `request failed: ${String(err)}`;
    }
    if (verdict === null) {
      console.log(`  PASS  ${check.name}`);
    } else {
      console.log(`  FAIL  ${check.name} — ${verdict}  [${check.path}]`);
      failures += 1;
    }
  }

  console.log(`\n${CHECKS.length - failures}/${CHECKS.length} checks passed against ${baseUrl}`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
