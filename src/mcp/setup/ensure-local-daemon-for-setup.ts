/**
 * The daemon-ensuring step `setup`/`init` inject into `performSetup` (mt#4707).
 *
 * ## Why this file exists rather than a call in the domain
 *
 * `ClaudeCodeRegistrar` writes the SHIM form — `minsky mcp shim --url
 * http://127.0.0.1:48765/mcp` — which is correct and inert until something is
 * serving that URL. `minsky setup local-http` already solved this for the
 * MIGRATION case; the fresh-registration path had no equivalent, so a first-run
 * user got a config whose every tool call retries for `RETRY_WINDOW_MS` (15s)
 * and then fails.
 *
 * The obvious fix — call `ensureDaemonRunning` from `packages/domain/src/setup.ts`
 * — is not available: that module may not import from `src/`. Duplicating the
 * spawn instead would be worse than verbose. ADR-014 makes the tray the
 * canonical supervisor and requires one owner per port, and
 * `ensureDaemonRunning` is where the bind-race refusals live; a second
 * implementation is precisely what mem#957 recorded going wrong, when an agent
 * "self-remediated" a connection failure by starting a competing daemon. So the
 * domain declares a seam and this adapter fills it.
 *
 * ## Why it returns instead of throwing
 *
 * `ensureDaemonRunning` throws on `foreign` and `not-ready`, and every one of
 * its messages ends "Nothing has been written." That is true for its original
 * caller, which runs it before its only write. It is FALSE for `setup`/`init`,
 * which write the client config afterwards regardless — so propagating the
 * throw verbatim would hand the operator a factually wrong sentence, the same
 * class of defect mt#4337 fixed. This translates the refusal into a reason
 * string the domain reports without claiming anything about what was written.
 */

import {
  daemonSpawnCommand,
  ensureDaemonRunning,
  localDaemonHealthUrl,
  localDaemonMcpUrl,
  resolveSelfInvocation,
} from "./local-http-apply";
import type { LocalDaemonEnsureOutcome } from "@minsky/domain/setup";

/** Injectable seams, so the decision is testable without spawning anything. */
export interface EnsureLocalDaemonDeps {
  /** Defaults to the real `ensureDaemonRunning`. */
  ensure?: typeof ensureDaemonRunning;
  /** Defaults to `process.argv`, used to re-derive how to invoke ourselves. */
  argv?: string[];
}

/**
 * Ensure the shared local daemon is serving, and describe what happened.
 *
 * Idempotent by construction (SC2): `ensureDaemonRunning` probes health first
 * and returns `spawned: false` when something healthy already answers, so a
 * second `setup` on a machine that already has a daemon spawns nothing.
 */
export async function ensureLocalDaemonForSetup(
  repoPath: string,
  deps: EnsureLocalDaemonDeps = {}
): Promise<LocalDaemonEnsureOutcome> {
  const ensure = deps.ensure ?? ensureDaemonRunning;
  const argv = deps.argv ?? process.argv;

  try {
    const result = await ensure(daemonSpawnCommand(resolveSelfInvocation(argv), repoPath), {
      healthUrl: localDaemonHealthUrl(),
    });
    // The MCP endpoint, not the health URL: it is what the written shim entry
    // actually targets, so it is the address an operator would check or paste.
    // Derived from the canonical host/port constants rather than restated.
    const url = localDaemonMcpUrl();
    return result.spawned ? { kind: "started", url } : { kind: "already-running", url };
  } catch (error) {
    // Every failure lands here as a REASON, never as a thrown refusal — see the
    // module docblock. `ensureDaemonRunning` distinguishes `foreign` (something
    // else holds the port) from `not-ready` (a daemon that cannot serve), and
    // both messages already name the condition and the health URL, which is
    // worth keeping. What must NOT survive is the write claim they end with.
    return {
      kind: "unavailable",
      reason: stripWriteClaim(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * The sentence `ensureDaemonRunning` appends to every refusal, verbatim.
 *
 * Its three throw sites all end with this, and it is TRUE for its original
 * caller — `runSetupLocalHttp` calls it before its only write. It is false here:
 * `setup`/`init` go on to write the client config regardless, so forwarding it
 * hands the operator two contradictory sentences in one message ("Nothing has
 * been written." immediately followed by "your config was written").
 *
 * Caught by review on PR #3658 — the module docblock argued for exactly this
 * boundary and the first implementation then forwarded the message verbatim,
 * which put the claim across it anyway.
 */
const WRITE_CLAIM = "Nothing has been written.";

/**
 * Drop the daemon layer's write claim, keeping its diagnosis.
 *
 * Deliberately NOT a regex over the message shape: a hand-written pattern that
 * matches nothing passes its input through UNCHANGED and is indistinguishable
 * from one that fired (mem#808, mem#972). This is an exact-substring removal of
 * a constant that lives beside the site that emits it, and
 * `ensure-local-daemon-for-setup.test.ts` asserts the phrase never survives into
 * an `unavailable` reason — so a reworded upstream message fails a test rather
 * than silently reintroducing the contradiction.
 */
function stripWriteClaim(message: string): string {
  return message.split(WRITE_CLAIM).join("").replace(/\s+$/, "").trim();
}
