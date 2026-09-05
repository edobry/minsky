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
    return result.spawned ? { kind: "started" } : { kind: "already-running" };
  } catch (error) {
    // Every failure lands here as a REASON, never as a thrown refusal — see the
    // module docblock. `ensureDaemonRunning` distinguishes `foreign` (something
    // else holds the port) from `not-ready` (a daemon that cannot serve), and
    // both messages already name the condition and the health URL, so the
    // message is forwarded rather than re-derived. A spawn that never becomes
    // healthy within the retry budget arrives here too.
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
