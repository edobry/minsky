#!/usr/bin/env bun
/**
 * Verify a conversation share link end to end, from OUTSIDE the process
 * (mt#4024).
 *
 * The property this exists to check is not "the routes return the right status
 * codes" — the route tests already do that against injected fakes. It is that
 * a link minted by the real server, backed by the real store and the real
 * scrub-gated transcript read, is readable by a caller holding NO session, and
 * stops being readable the moment it is revoked. That is the whole feature, and
 * it is exactly the part a fake cannot stand in for.
 *
 * Self-cleaning: every share it mints, it revokes. It is safe to re-run.
 *
 * Usage:
 *   bun scripts/verify-conversation-share.ts                        # local daemon
 *   bun scripts/verify-conversation-share.ts --url https://host --cookie 'minsky_cockpit_session=…'
 *   bun scripts/verify-conversation-share.ts --conversation <agent-session-id>
 *
 * Two DIFFERENT credentials, for two different gates, and a local run needs
 * the first even though "local" sounds unauthenticated:
 *
 *   - The local daemon's `mutationAuthMiddleware` requires a bearer token on
 *     every non-GET. A browser gets it from the loopback cookie bootstrap; a
 *     script has to read it from `~/.local/state/minsky/cockpit-token`, which
 *     this does automatically (override with `--token`).
 *   - A gated deployment (mt#4023) additionally requires a passkey session
 *     cookie, which cannot be minted headlessly — pass `--cookie` from a
 *     signed-in browser.
 *
 * Exit codes: 0 all assertions held; 1 an assertion failed; 0 with a SKIP line
 * when the target is unreachable or nothing publishable was found — matching
 * the sibling verify-* scripts, which do not fail a run for an absent
 * prerequisite.
 */

import fs from "fs";
import path from "path";

const DEFAULT_URL = "http://127.0.0.1:3737";
const REQUEST_TIMEOUT_MS = 20_000;

interface Args {
  baseUrl: string;
  cookie: string | null;
  bearer: string | null;
  conversationId: string | null;
}

/**
 * The local daemon's bearer token, if this machine has one. Absent is fine —
 * a deployed target does not use it — so a missing file is not an error.
 */
function readLocalCockpitToken(): string | null {
  const stateHome =
    process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "", ".local", "state");
  try {
    const token = fs.readFileSync(path.join(stateHome, "minsky", "cockpit-token"), "utf8").trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

function parseArgs(argv: readonly string[]): Args {
  const read = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return null;
    const value = argv[idx + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };
  return {
    baseUrl: (read("--url") ?? DEFAULT_URL).replace(/\/$/, ""),
    cookie: read("--cookie"),
    bearer: read("--token") ?? readLocalCockpitToken(),
    conversationId: read("--conversation"),
  };
}

let failures = 0;
let checks = 0;

function check(name: string, verdict: string | null): boolean {
  checks += 1;
  if (verdict === null) {
    console.log(`  PASS  ${name}`);
    return true;
  }
  console.log(`  FAIL  ${name} — ${verdict}`);
  failures += 1;
  return false;
}

function get(url: string, cookie?: string | null): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "manual",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function post(args: Args, url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      ...(args.cookie ? { Cookie: args.cookie } : {}),
      ...(args.bearer ? { Authorization: `Bearer ${args.bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Pick a conversation to publish when the caller did not name one. */
async function discoverConversation(
  baseUrl: string,
  cookie: string | null
): Promise<string | null> {
  const res = await get(`${baseUrl}/api/cockpit/session-film/sessions`, cookie);
  if (!res.ok) return null;
  const json = (await res.json()) as { sessions?: Array<{ id?: string; sessionId?: string }> };
  for (const session of json.sessions ?? []) {
    const id = session.sessionId ?? session.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Verifying conversation share links at ${args.baseUrl}\n`);

  try {
    await get(`${args.baseUrl}/api/health`);
  } catch (err: unknown) {
    console.log(`SKIP: ${args.baseUrl} is not reachable (${String(err)})`);
    return 0;
  }

  // Whether this instance gates its data routes decides one assertion below:
  // on a gated deployment an anonymous /api/tasks must 401, which is the check
  // that proves publishing one conversation did not widen anything else. A
  // local daemon mounts no gate, so asserting it there would be asserting a
  // property the target does not claim to have.
  let gated = false;
  try {
    const status = await get(`${args.baseUrl}/api/auth/status`);
    const body = (await status.json()) as { gated?: boolean };
    gated = body.gated === true;
  } catch {
    // No auth route at all is a local daemon; treat as ungated.
  }
  console.log(`  (target reports itself as ${gated ? "gated" : "ungated"})\n`);

  const conversationId =
    args.conversationId ?? (await discoverConversation(args.baseUrl, args.cookie));
  if (!conversationId) {
    console.log("SKIP: no conversation available to publish (pass --conversation <id>)");
    return 0;
  }
  console.log(`  publishing conversation ${conversationId}\n`);

  // --- mint ----------------------------------------------------------------
  const mintRes = await post(args, `${args.baseUrl}/api/shares`, { conversationId });
  const mintBody = await mintRes.text();
  if (mintRes.status === 422) {
    console.log(`SKIP: that conversation predates the credential-scrub cutoff, so it cannot be`);
    console.log(`      published (this is the gate working). Pass a newer --conversation.`);
    return 0;
  }
  if (
    !check("mint returns 201", mintRes.status === 201 ? null : `got ${mintRes.status}: ${mintBody}`)
  ) {
    return 1;
  }
  const minted = JSON.parse(mintBody) as { id: string; url: string };
  check(
    "the minted URL is a /s/<256-bit token> path",
    /^\/s\/[0-9a-f]{64}$/.test(minted.url) ? null : `got ${minted.url}`
  );
  const token = minted.url.replace("/s/", "");

  // --- read it as a stranger ------------------------------------------------
  const publicRes = await get(`${args.baseUrl}/api/shares/public/${token}`);
  const publicBody = await publicRes.text();
  check(
    "the shared conversation is readable with NO session",
    publicRes.status === 200 ? null : `got ${publicRes.status}: ${publicBody}`
  );
  check(
    "it carries the conversation's blocks",
    (() => {
      try {
        const parsed = JSON.parse(publicBody) as { blocks?: unknown[] };
        return Array.isArray(parsed.blocks) && parsed.blocks.length > 0
          ? null
          : "no blocks in the payload";
      } catch {
        return "response was not JSON";
      }
    })()
  );
  check(
    "the share JSON is noindex",
    publicRes.headers.get("x-robots-tag")?.includes("noindex")
      ? null
      : `x-robots-tag: ${publicRes.headers.get("x-robots-tag") ?? "(absent)"}`
  );

  const pageRes = await get(`${args.baseUrl}${minted.url}`);
  check(
    "the share PAGE loads with no session",
    pageRes.status === 200 ? null : `got ${pageRes.status}`
  );
  check(
    "the share page is noindex",
    pageRes.headers.get("x-robots-tag")?.includes("noindex")
      ? null
      : `x-robots-tag: ${pageRes.headers.get("x-robots-tag") ?? "(absent)"}`
  );

  if (gated) {
    const tasksRes = await get(`${args.baseUrl}/api/tasks`);
    check(
      "publishing one conversation opened nothing else",
      tasksRes.status === 401 ? null : `anonymous /api/tasks returned ${tasksRes.status}`
    );
  }

  const unknownRes = await get(`${args.baseUrl}/api/shares/public/${"0".repeat(64)}`);
  check("an unknown token is 404", unknownRes.status === 404 ? null : `got ${unknownRes.status}`);

  // --- revoke ---------------------------------------------------------------
  const revokeRes = await post(args, `${args.baseUrl}/api/shares/${minted.id}/revoke`);
  check("revoke succeeds", revokeRes.status === 200 ? null : `got ${revokeRes.status}`);

  const afterRes = await get(`${args.baseUrl}/api/shares/public/${token}`);
  const afterBody = await afterRes.text();
  check("a revoked link is 410", afterRes.status === 410 ? null : `got ${afterRes.status}`);
  check(
    "a revoked link serves no content",
    afterBody.includes('"blocks"') ? "the 410 body still carried blocks" : null
  );

  console.log(`\n${checks - failures}/${checks} checks passed against ${args.baseUrl}`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
