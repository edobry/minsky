#!/usr/bin/env bun
/**
 * Cold-start cockpit-web SPA smoke test (mt#3611)
 *
 * Verifies that a PACKAGED install layout — the `dist/` tree alone, with no
 * source checkout anywhere near it — can serve the cockpit web SPA via
 * `minsky cockpit start`.
 *
 * This is the cockpit-web sibling of `scripts/smoke-cold-start-hooks.ts`
 * (mt#3578) and `scripts/smoke-cold-start-migrate.ts` (mt#2369), completing
 * the mt#1767 Phase 0 triad (bundler-emits-assets + ordered-candidate
 * resolver + cold-start CI test) for the third runtime-asset class the
 * ADR-033 asset inventory tracked as OPEN: `build:copy-cockpit-web` emits
 * the built SPA to `dist/cockpit-web`, `cockpitWebDistDir()` gained a
 * bundled-layout candidate (`<moduleDir>/cockpit-web`) that resolves it with
 * no ancestor walk, and this script proves the chain end-to-end from a
 * layout that has no `src/cockpit/web` anywhere on disk.
 *
 * Method:
 *   1. Copy `dist/` to a temp "install" directory — crucially SEPARATED
 *      from the repo, so the resolver's dev-layout candidates cannot
 *      accidentally resolve and only the bundled candidate can win.
 *   2. Start `bun <install>/minsky.js cockpit start` from that installed
 *      layout, with `cwd` set to the temp install dir (not the repo) so
 *      the cwd-based dev candidate is also ruled out, and
 *      `MINSKY_STATE_DIR` pointed at a temp state dir so the daemon's local
 *      token file doesn't touch the real machine state.
 *   3. Poll `GET /` until the server answers or the boot timeout elapses.
 *   4. Assert: HTTP 200, `text/html` content type, and the body contains
 *      the built `index.html`'s own marker string (proving the SPA's own
 *      built asset was served, not a fallback/error page).
 *   5. Kill the server and clean up.
 *
 * No database required: `createCockpitServer()` binds and serves the static
 * SPA fallback route without touching persistence — DB-backed API routes
 * degrade gracefully at request time (see `classifyUnhandledRejection` in
 * `src/commands/cockpit/start-command.ts`), which is orthogonal to what this
 * script verifies.
 *
 * Usage: bun scripts/smoke-cold-start-cockpit-web.ts   (requires `bun run build` first)
 * Exit codes: 0 — pass; 1 — fail.
 *
 * @see mt#3611 — this task (bundled SPA emission + resolver + this smoke)
 * @see mt#3578 / docs/architecture/adr-033-cli-install-channel.md — the
 *   asset-inventory table this closes the cockpit-web row on
 * @see scripts/smoke-cold-start-hooks.ts — the sibling this mirrors
 */

import { spawn } from "child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// Separator-agnostic repo-root derivation (mirrors the hooks sibling).
const repoRoot = resolve(import.meta.dir, "..");
const distDir = join(repoRoot, "dist");
const bundlePath = join(distDir, "minsky.js");
const cockpitWebSrc = join(distDir, "cockpit-web");

if (!existsSync(bundlePath)) {
  console.error(`ERROR: dist/minsky.js not found at ${bundlePath}`);
  console.error("Run 'bun run build' first to produce the bundle.");
  process.exit(1);
}
if (!existsSync(join(cockpitWebSrc, "index.html"))) {
  console.error("ERROR: dist/cockpit-web/index.html is missing.");
  console.error("Run 'bun run build' (which includes build:copy-cockpit-web) first.");
  process.exit(1);
}

// A marker string that only the REAL built index.html contains — proves the
// response body is the actual SPA asset, not some other HTML page the
// resolver's fallback error path could theoretically produce.
const expectedIndexHtml = readFileSync(join(cockpitWebSrc, "index.html"), "utf8");

let failures = 0;
const fail = (msg: string): void => {
  failures++;
  console.error(`FAIL: ${msg}`);
};
const pass = (msg: string): void => {
  console.log(`ok: ${msg}`);
};

const tempRoot = mkdtempSync(join(tmpdir(), "minsky-cold-start-cockpit-web-"));
const installDir = join(tempRoot, "install");
const stateDir = join(tempRoot, "state");
const PORT = 34173; // Fixed high port unlikely to collide; CI runs in an isolated container.

let child: ReturnType<typeof spawn> | undefined;

/**
 * Poll `url` until it answers HTTP 200, or `timeoutMs` elapses.
 *
 * Returns the LAST response observed (200 on success, whatever non-200 the
 * server last returned on timeout) rather than the first response of any
 * status — a connection succeeding doesn't mean the app is ready yet (e.g. a
 * transient 503/404 mid-boot), and stopping on that first response was
 * exactly the flakiness bug this function existed to avoid (mt#3611 PR
 * #2581 R1): the poll loop would return early on a warmup response and the
 * caller's assertions would then fail permanently instead of the loop
 * retrying until either success or the real timeout.
 */
async function waitForServer(url: string, timeoutMs: number): Promise<Response | undefined> {
  const deadline = Date.now() + timeoutMs;
  let lastResponse: Response | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        return res;
      }
      lastResponse = res;
    } catch {
      // Not up yet — retry.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return lastResponse;
}

try {
  // 1. The "installed" layout: dist/ contents, nowhere near a source checkout.
  cpSync(distDir, installDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // 2. Start the daemon from the installed bundle. `cpSync(distDir, installDir)`
  //    copies the CONTENTS of `dist/` into `installDir`, so the bundle lands
  //    at `installDir/minsky.js` and the SPA at `installDir/cockpit-web` —
  //    `installDir` plays the role `dist/` plays in the repo. `cwd` is set
  //    to `tempRoot`, the install dir's PARENT (deliberately neither
  //    `installDir` nor `repoRoot`), so the cwd-based dev candidate in
  //    `cockpitWebDistDir()` cannot accidentally resolve: only the bundled
  //    `<moduleDir>/cockpit-web` candidate (moduleDir = `installDir`, from
  //    `import.meta.url` of the running `installDir/minsky.js`) can win.
  child = spawn(
    "bun",
    [
      join(installDir, "minsky.js"),
      "cockpit",
      "start",
      "--port",
      String(PORT),
      "--no-dev-chromium",
    ],
    {
      cwd: tempRoot, // deliberately NOT installDir and NOT repoRoot — see above
      env: { ...process.env, MINSKY_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += d.toString()));
  child.stderr?.on("data", (d) => (stderr += d.toString()));

  const res = await waitForServer(`http://127.0.0.1:${PORT}/`, 20_000);

  if (!res) {
    fail(`server did not respond on port ${PORT} within timeout`);
    console.error(`stdout:\n${stdout}`);
    console.error(`stderr:\n${stderr}`);
  } else {
    if (res.status === 200) {
      pass(`GET / returned HTTP 200 from the installed (no-source) layout`);
    } else {
      fail(`GET / returned HTTP ${res.status}, expected 200`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      pass(`GET / content-type is text/html (${contentType})`);
    } else {
      fail(`GET / content-type is "${contentType}", expected text/html`);
    }

    const body = await res.text();
    if (body === expectedIndexHtml) {
      pass("GET / body matches the built dist/cockpit-web/index.html exactly");
    } else {
      fail("GET / body does not match the built index.html — resolver may have served a fallback");
    }
  }
} finally {
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\ncold-start cockpit-web smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncold-start cockpit-web smoke: PASS");
