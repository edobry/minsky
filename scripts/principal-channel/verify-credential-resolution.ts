#!/usr/bin/env bun
/**
 * Verify the channel's credential resolution against the REAL Pulumi backend
 * (mt#3608).
 *
 * This exists because mt#3608 changed how both credential readers report their
 * outcome — from "a value or `null`" to "a value, a definite absence, or a
 * failure" — and the discriminator for the chat-id reader is a **stderr
 * heuristic** over Pulumi's own message. Pulumi exits non-zero both for "this
 * key is not set" and for "I could not reach the backend," and only the live
 * CLI can tell us the real strings are classified the way the code assumes.
 *
 * A unit test cannot: every test injects `readPulumiToken` / `readPulumiPlain`,
 * so the spawn, the exit code, and the stderr text — the three things the new
 * classification actually reads — are all stubbed away.
 *
 * The failure this guards against is silent in the worst direction. If a
 * SUCCESSFUL read were misclassified as a failure, the channel would retry six
 * times and then refuse to start on a machine that is correctly configured —
 * turning a fix for "never starts" into a different "never starts."
 *
 * ## mt#3683 finding: `exit null` is a timeout, not a PATH failure
 *
 * The 2026-08-04 outage's reason string was `chat-id read failed: exit null` —
 * `readPulumiChatId`'s `stderr || \`exit ${proc.exitCode}\`` fallback with
 * `proc.exitCode === null`. Two hypotheses were live: a PATH-resolution
 * failure (the tray-launched daemon not inheriting `pulumi`'s location), or a
 * genuinely transient network read. Determined by live reproduction against
 * this exact Bun runtime (`Bun v1.2.21 (macOS arm64)`), not assumption:
 *
 *   - `Bun.spawnSync(["<binary not on PATH>"], ...)` THROWS synchronously with
 *     a distinct `ENOENT` / `Executable not found in $PATH` error — caught by
 *     `readPulumiChatId`'s outer `catch`, which would produce a DIFFERENT
 *     reason string, never `exit null`.
 *   - `Bun.spawnSync(["sleep", "3"], { timeout: 300 })` — a process that DID
 *     spawn but was killed before completing — returns `exitCode: null`,
 *     `signalCode: "SIGTERM"`, empty stderr. This reproduces `exit null`
 *     exactly (empty stderr falls through to the `exit ${proc.exitCode}`
 *     branch).
 *
 * So `exit null` can only mean the `pulumi` binary WAS found and spawned via
 * the inherited PATH, and was killed by `readPulumiChatId`'s own 5000ms
 * subprocess `timeout` — a real, transient network condition (the Pulumi
 * backend was slow to answer), not an unresolvable binary. No binary-path
 * resolution fix was warranted; `principal-channel-launch.ts`'s retry-ceiling
 * removal is the correct and sufficient fix for this signature. See
 * `CREDENTIAL_RETRY_DELAYS_MS`'s docblock in `principal-channel-launch.ts` for
 * the same finding recorded at the call site.
 *
 * Usage:
 *
 *   bun scripts/principal-channel/verify-credential-resolution.ts
 *
 * Reads only. Sends nothing, and never prints the token — presence is reported
 * as a boolean and a length, per the secret-handling rule.
 *
 * Exit codes: 0 = resolution behaved sensibly (configured, or a coherent
 * unconfigured verdict), 1 = the live read was classified as a transient
 * failure, which on a correctly-configured machine means the classification is
 * wrong.
 */

import {
  clearPrincipalChannelCache,
  resolvePrincipalChannel,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";

async function main(): Promise<void> {
  // The resolver memoizes successes for five minutes; a stale hit would make
  // this probe report on a read it did not perform.
  clearPrincipalChannelCache();

  const startedAt = Date.now();
  const resolution = await resolvePrincipalChannel(createRealPrincipalChannelDeps());
  const elapsedMs = Date.now() - startedAt;

  if (resolution.configured) {
    const { token, chatId, source } = resolution.config;
    console.log(
      JSON.stringify(
        {
          status: "PASS",
          configured: true,
          source,
          elapsedMs,
          // Never the value. Presence + length is enough to confirm a real
          // read happened without putting a bot token in a persisted transcript.
          tokenPresent: token.length > 0,
          tokenLength: token.length,
          chatId,
        },
        null,
        2
      )
    );
    return;
  }

  const verdict = {
    status: resolution.transient ? "FAIL" : "UNCONFIGURED",
    configured: false,
    transient: resolution.transient,
    elapsedMs,
    reason: resolution.reason,
  };
  console.log(JSON.stringify(verdict, null, 2));

  if (resolution.transient) {
    console.error(
      "FAIL: the live credential read was classified as a TRANSIENT FAILURE. On a machine " +
        "where `pulumi config get` works, that means the new classification is misreading a " +
        "successful or legitimately-empty read as a fault — which would make the channel " +
        "retry and then refuse to start."
    );
    process.exit(1);
  }

  // A genuine "not configured" is a valid outcome for this probe: it is what an
  // unconfigured machine SHOULD report, and it is explicitly not a failure.
  console.log(
    "NOTE: this machine reports the channel as unconfigured (not a failure). Re-run where the " +
      "Pulumi stack is selected to exercise the success path."
  );
}

await main();
