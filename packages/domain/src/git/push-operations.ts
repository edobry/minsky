import { validateGitError } from "../schemas/error";
import { validateProcess } from "../schemas/runtime";
import { raceAgainstTimeout } from "@minsky/shared/timeout";

/**
 * Options for push operations.
 * Session resolution must be done before calling pushImpl — pass resolved repoPath.
 */
export interface PushOptions {
  repoPath?: string;
  remote?: string;
  force?: boolean;
  debug?: boolean;
  /** GitHub App installation token for push authentication (mt#1477).
   * When set, overrides the system credential helper with an HTTP
   * Authorization header — same approach as actions/checkout. */
  authToken?: string;
}

/** What a redacted credential is replaced WITH — kept recognizable so a reader can tell redaction happened. */
export const REDACTED_CREDENTIAL = "***REDACTED***";

/**
 * Strips credential material from text that may echo the push command (mt#3219).
 *
 * `deps.execAsync` takes a shell STRING, so a failed push throws an error whose
 * message begins `Command failed: <the entire command>` — and when `authToken`
 * is set that command carries
 * `-c http.https://github.com/.extraheader='AUTHORIZATION: basic <base64>'`,
 * where the base64 decodes straight to `x-access-token:<installation token>`.
 * Tool output is persisted AND ingested into the transcripts DB, so every push
 * failure was writing a live credential into durable, searchable storage. This
 * fired on every failure, and for a period push failures were the steady state
 * (mt#3210 measured 8-of-8 first attempts), so the volume was not incidental.
 *
 * Redaction happens HERE, where the error is constructed, rather than at any
 * display layer — every consumer (MCP result, log line, task record, transcript
 * ingest) is downstream of this point, and filtering at one of them would leave
 * the others leaking.
 *
 * Deliberately narrow: it removes the credential and NOTHING else, so the
 * remote's own message ("Permission ... denied to ...", "403") survives intact.
 * That text is what made mt#3210 diagnosable, and redaction must not cost that.
 *
 * Exported for tests.
 */
export function redactPushCredentials(text: string): string {
  return (
    text
      // PRIMARY, and the only path that actually leaked: the injected header.
      // The base64 payload is the secret. The character class deliberately
      // excludes the quote the value is wrapped in, so the match ends at the
      // closing quote instead of running on into following text — the
      // over-match risk PR #2319 R1 flagged.
      .replace(
        /AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=]+/gi,
        `AUTHORIZATION: basic ${REDACTED_CREDENTIAL}`
      )
      // SECONDARY net for a raw token appearing outside the header. Anchored on
      // word boundaries so a pattern cannot chew a matching prefix out of a
      // longer identifier and corrupt diagnostic text. That risk is why these
      // stay conservative rather than broadening to every GitHub token shape
      // (R1 non-blocking): the header above is the guaranteed path, and a
      // wider net here trades a real diagnosability cost for a hypothetical
      // leak the injection site cannot currently produce.
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED_CREDENTIAL)
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED_CREDENTIAL)
  );
}

/**
 * Rebuilds a subprocess error with its credential-bearing text redacted,
 * preserving the fields callers branch on.
 *
 * `mt#3210`'s keychain-fallback detector inspects the error's message/stderr for
 * a permission-denial signature, so those fields must survive redaction — hence
 * copying them through rather than replacing the error with a generic one.
 */
export function redactPushError(err: unknown): unknown {
  if (!(err instanceof Error)) {
    return typeof err === "string" ? redactPushCredentials(err) : err;
  }

  // Mutated IN PLACE rather than rewrapped (PR #2319 R1). A `new Error(...)`
  // copy silently drops the original's prototype (a `GitExecError` subclass
  // stops satisfying `instanceof`), its `name`, and any non-enumerable
  // properties — a behavior change well beyond redaction, and one a caller
  // branching on error type would hit without warning.
  //
  // Editing in place also means no unredacted copy of the error survives
  // anywhere, which a wrap-and-return cannot guarantee: the caller may still
  // hold a reference to the original.
  err.message = redactPushCredentials(err.message);
  if (typeof err.stack === "string") {
    err.stack = redactPushCredentials(err.stack);
  }

  // The string-valued extras Node's exec attaches (stderr/stdout/cmd).
  // mt#3210's keychain fallback reads stderr, so these must survive redaction
  // rather than be dropped.
  for (const [key, value] of Object.entries(err)) {
    if (typeof value === "string") {
      Object.assign(err, { [key]: redactPushCredentials(value) });
    }
  }

  return err;
}

/**
 * Result of push operations
 */
export interface PushResult {
  workdir: string;
  pushed: boolean;
}

/**
 * Dependencies for push operations
 */
export interface PushDependencies {
  execAsync: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

// POSIX shell single-quote escape: wrap in '...', and replace each ' with '\''.
// Required because deps.execAsync takes a single shell-string (not argv); paths
// or remote/branch names with spaces or shell metacharacters must be quoted to
// reach git correctly.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Push the current branch to a remote, supporting --repo, --remote, and --force.
 * Session resolution must happen at the adapter boundary before calling this.
 *
 * Error policy: errors from execAsync propagate raw across all phases
 * (rev-parse, remote-list, push), preserving original type, stack, and
 * structured fields. Two intentional UX overrides apply in the push catch:
 * stderr containing "[rejected]" or "no upstream" is rewritten into an
 * actionable user-facing message. All other push failures re-throw the
 * original error unchanged.
 */
export async function pushImpl(options: PushOptions, deps: PushDependencies): Promise<PushResult> {
  const remote = options.remote || "origin";
  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);
  const qRemote = shellQuote(remote);

  // Resolve current branch via rev-parse --abbrev-ref HEAD. The literal
  // string "HEAD" is git's machine-readable signal for detached HEAD —
  // locale-independent across git versions. Surface an actionable error
  // for that case (with current commit SHA when available, for context).
  // Unrelated rev-parse failures (not a git repo, missing git binary,
  // permission errors) propagate as the original error from execAsync —
  // preserving type, stack, and structured fields. See mt#994; mt#1217
  // fixed the upstream session_update path that was leaving sessions
  // detached.
  const { stdout } = await deps.execAsync(`git -C ${qWorkdir} rev-parse --abbrev-ref HEAD`);
  const branch = stdout.trim();
  if (branch === "HEAD") {
    let sha = "";
    try {
      const { stdout: shaOut } = await deps.execAsync(`git -C ${qWorkdir} rev-parse --short HEAD`);
      sha = shaOut.trim();
    } catch {
      // Best-effort; if SHA lookup fails, fall back to the message without it.
    }
    const shaSuffix = sha ? ` (currently at ${sha})` : "";
    throw new Error(
      `Cannot push: HEAD is detached in ${workdir}${shaSuffix}. ` +
        `Check out a branch first (e.g. 'git switch <branch>' or 'git checkout -b <new-branch>').`
    );
  }
  if (!branch) {
    throw new Error(`Cannot push: rev-parse returned an empty branch name for ${workdir}.`);
  }
  const qBranch = shellQuote(branch);

  // 2. Validate remote exists
  const { stdout: remotesOut } = await deps.execAsync(`git -C ${qWorkdir} remote`);
  const remotes = remotesOut
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new Error(`Remote '${remote}' does not exist in repository at ${workdir}`);
  }

  // 3. Build push command
  let pushCmd = `git -C ${qWorkdir}`;

  // mt#1477: when an auth token is provided, disable the system credential
  // helper and inject the token as an HTTP Authorization header. This causes
  // the push to authenticate as the GitHub App, which triggers pull_request
  // workflows (unlike GITHUB_TOKEN or system-keychain credentials).
  // Same approach as actions/checkout: -c credential.helper= clears the
  // helper, -c http.extraheader sets the auth for github.com requests.
  if (options.authToken) {
    const encoded = Buffer.from(`x-access-token:${options.authToken}`).toString("base64");
    pushCmd += ` -c credential.helper= -c http.https://github.com/.extraheader=${shellQuote(`AUTHORIZATION: basic ${encoded}`)}`;
  }

  pushCmd += ` push ${qRemote} ${qBranch}`;
  if (options.force) {
    pushCmd += " --force";
  }

  // 4. Execute push
  try {
    await deps.execAsync(pushCmd);
    return { workdir, pushed: true };
  } catch (err: unknown) {
    // Two intentional UX rewrites — see policy in JSDoc above.
    const gitError = validateGitError(err);
    if (gitError.stderr && gitError.stderr.includes("[rejected]")) {
      throw new Error(
        "Push was rejected by the remote. You may need to pull or use --force if you intend to overwrite remote history."
      );
    }
    if (gitError.stderr && gitError.stderr.includes("no upstream")) {
      throw new Error(
        "No upstream branch is set for this branch. Set the upstream with 'git push --set-upstream' or push manually first."
      );
    }
    // mt#3219: the raw error's message is `Command failed: <full command>`,
    // which carries the injected Authorization header when authToken is set.
    // The two rewrites above build fresh strings and are already safe; this is
    // the path that echoed a live credential into persisted output.
    throw redactPushError(err);
  }
}

/**
 * Default bound for the remote-ref verification check (mt#3177) — a single
 * `git ls-remote` round-trip. Kept short by design: this check exists
 * specifically to resolve an AMBIGUOUS outcome (the push call itself timed
 * out) quickly, not to itself become a second multi-minute wait.
 */
export const DEFAULT_REMOTE_VERIFY_TIMEOUT_MS = 15 * 1000;

/**
 * Result of a `verifyRemoteRefAdvanced` check.
 */
export interface RemoteRefVerification {
  /** true when the remote branch head equals `expectedSha`. */
  confirmed: boolean;
  /** the SHA `ls-remote` reported for the branch, when the call succeeded. */
  remoteSha?: string;
  /**
   * Set when the verification check itself could not produce an answer
   * (network failure, no matching ref, or the check's own timeout). This is
   * NOT evidence the push failed — only that verification was inconclusive.
   */
  checkError?: string;
}

/**
 * Bounded, direct check of whether `<remote>`'s `<branch>` head already
 * matches `expectedSha` (mt#3177). Uses `git ls-remote`, which queries the
 * remote directly over the network WITHOUT touching any local ref or
 * requiring a prior `git fetch` — unlike the fetch + `git rev-parse
 * origin/<branch>` pattern `tryResumePendingPush` already uses in
 * `session-commands.ts`, this makes no local state change, so it is safe to
 * call speculatively after ANY uncertain push outcome.
 *
 * Bounded via `raceAgainstTimeout`, mirroring the mt#3049 push-phase bound:
 * the underlying `ls-remote` subprocess is not killed on timeout (same
 * documented limitation as the push call itself), but the CALLER's wait is
 * bounded so this check can never itself become a second unbounded hang.
 */
export async function verifyRemoteRefAdvanced(
  workdir: string,
  branch: string,
  expectedSha: string,
  deps: PushDependencies,
  options: { remote?: string; timeoutMs?: number } = {}
): Promise<RemoteRefVerification> {
  const remote = options.remote ?? "origin";
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_VERIFY_TIMEOUT_MS;
  const qWorkdir = shellQuote(workdir);
  const qRemote = shellQuote(remote);
  const qRef = shellQuote(`refs/heads/${branch}`);

  try {
    const raced = await raceAgainstTimeout(
      deps.execAsync(`git -C ${qWorkdir} ls-remote ${qRemote} ${qRef}`),
      timeoutMs
    );
    if (raced.timedOut) {
      return { confirmed: false, checkError: `ls-remote check exceeded ${timeoutMs}ms` };
    }
    const firstLine = raced.value.stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    const remoteSha = firstLine ? firstLine.split(/\s+/)[0] : undefined;
    if (!remoteSha) {
      return {
        confirmed: false,
        checkError: `ls-remote returned no matching ref for ${branch} on ${remote}`,
      };
    }
    return { confirmed: remoteSha === expectedSha, remoteSha };
  } catch (err) {
    return { confirmed: false, checkError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Default bound for the push call itself inside `pushWithConfirmation`
 * (mt#3177). Matches `DEFAULT_PUSH_PHASE_TIMEOUT_MS` in
 * `session-commands.ts` (mt#3049) — the two constants are independently
 * configurable (different callers, different override params) but share the
 * same rationale: a push that genuinely needs longer than 2 minutes on a
 * healthy network is itself diagnostic-worthy.
 */
export const DEFAULT_PUSH_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Result of `pushWithConfirmation` — a superset of `PushResult` (all
 * existing consumers of the plain `pushed`/`workdir` fields remain
 * unaffected) that adds the mt#3177 confirmation/timeout fields.
 */
export interface PushWithConfirmationResult extends PushResult {
  /**
   * The underlying push call exceeded its bound without resolving — the
   * subprocess may still be running in the background (see
   * `raceAgainstTimeout`'s doc comment). `pushed` reflects the OUTCOME this
   * function established below (a direct success, a remote-check
   * confirmation, or `false` when neither confirms) — `pushTimedOut: true`
   * can appear alongside `pushed: true` (slow but confirmed via remote
   * check) or `pushed: false` (still unconfirmed).
   */
  pushTimedOut?: boolean;
  /**
   * The underlying push call threw (network error, auth failure, rejected,
   * etc.) — a DEFINITE failure, distinct from the ambiguous timeout case.
   * `pushUnconfirmed`/remote verification are NOT attempted on this path:
   * an explicit thrown error is already an unambiguous "not pushed" signal.
   */
  pushError?: string;
  /**
   * Set (with `pushed: true`) when the push call itself timed out but a
   * follow-up `verifyRemoteRefAdvanced` check confirmed the remote branch
   * head already matches the local commit — the push landed server-side
   * even though this call's own confirmation did not (mt#3177 recurrence:
   * the observed 2nd occurrence's push had already landed while the tool's
   * response was still hanging).
   */
  pushConfirmedVia?: "remote-check";
  /**
   * Set (with `pushed: false`) when the push call timed out AND a follow-up
   * remote-ref check did NOT confirm the push landed (either the remote
   * genuinely has not advanced, or the verification check itself was
   * inconclusive). This is the explicit "we do not know" state mt#3177
   * exists to add: no consumer should read `pushUnconfirmed: true` as
   * anything resembling success, and no caller should report a
   * clean/synced-implying-pushed result while this is set.
   */
  pushUnconfirmed?: boolean;
}

/** Config for `pushWithConfirmation` — all fields optional/overridable. */
export interface PushWithConfirmationConfig {
  /** Bound for the underlying push call itself. Default `DEFAULT_PUSH_CONFIRM_TIMEOUT_MS`. */
  pushTimeoutMs?: number;
  /** Bound for the remote-ref verification fallback. Default `DEFAULT_REMOTE_VERIFY_TIMEOUT_MS`. */
  verifyTimeoutMs?: number;
  /**
   * Branch to verify against, when already known to the caller (skips a
   * `rev-parse --abbrev-ref HEAD` call). Falls back to resolving it locally
   * when omitted.
   */
  branch?: string;
}

/**
 * Resolve the (branch, expectedSha) pair `verifyRemoteRefAdvanced` needs,
 * bounded (mt#3177 R1 review). Both `rev-parse` calls are LOCAL — no
 * network — but local git commands can still hang (an `.git/index.lock`
 * left by another process, a stalled filesystem/NFS mount, a concurrent
 * `git gc`). Leaving these unbounded while only the push call and the
 * remote `ls-remote` check were bounded would silently reintroduce the
 * exact "never hang" guarantee this task exists to establish — a reviewer
 * finding on PR #2297 caught this gap in the first version of this
 * function. Reuses `verifyTimeoutMs` (the SAME bound `verifyRemoteRefAdvanced`
 * applies to the remote check) rather than introducing a separate knob:
 * both calls are part of the same post-push-timeout verification phase's
 * wall-clock budget. Fails open (returns `undefined`) on EITHER a timeout
 * or a thrown error — identical to the pre-existing catch-based fail-open
 * behavior, just now also covering the timeout case. A caller that gets
 * `undefined` back treats it as "could not resolve" either way (see
 * `pushWithConfirmation`, which degrades straight to `pushUnconfirmed:
 * true` — never guesses, never hangs waiting for a resolution that isn't
 * bounded).
 */
async function resolveVerificationTarget(
  workdir: string,
  deps: PushDependencies,
  config: PushWithConfirmationConfig
): Promise<{ branch: string; expectedSha: string } | undefined> {
  const timeoutMs = config.verifyTimeoutMs ?? DEFAULT_REMOTE_VERIFY_TIMEOUT_MS;

  let branch = config.branch;
  if (!branch) {
    try {
      const raced = await raceAgainstTimeout(
        deps.execAsync(`git -C ${shellQuote(workdir)} rev-parse --abbrev-ref HEAD`),
        timeoutMs
      );
      if (raced.timedOut) return undefined;
      branch = raced.value.stdout.trim();
    } catch {
      return undefined;
    }
  }
  if (!branch || branch === "HEAD") {
    // Detached HEAD or unresolvable branch — nothing sensible to verify against.
    return undefined;
  }

  try {
    const raced = await raceAgainstTimeout(
      deps.execAsync(`git -C ${shellQuote(workdir)} rev-parse HEAD`),
      timeoutMs
    );
    if (raced.timedOut) return undefined;
    const expectedSha = raced.value.stdout.trim();
    if (!expectedSha) return undefined;
    return { branch, expectedSha };
  } catch {
    return undefined;
  }
}

/**
 * Push with a bounded wait AND, on timeout, a follow-up remote-ref
 * verification instead of reporting an ambiguous result (mt#3177).
 *
 * Root-cause context (mt#3177 spec, 2nd occurrence 2026-07-25): a
 * `session_commit` push and a standalone `git_push` call both hung — the
 * former bounded at 2 minutes (mt#3049), the latter completely UNBOUNDED,
 * hanging the full ~1800s MCP-transport idle-timeout (the `git.push`
 * adapter command previously awaited `pushFromParams` with no bound at
 * all). In the observed recurrence, the underlying push had ALREADY LANDED
 * server-side (confirmed via the PR's reviewed HEAD sha, timestamped after
 * the hanging `git_push` call had already been issued) well before the hang
 * cleared — the gap is in confirming/reporting completion, not in push
 * reliability itself. This function is the shared fix for both call sites:
 * bound the wait, and on an inconclusive outcome, ask the remote directly
 * rather than reporting a state a caller could mistake for success OR
 * silently drop (leaving local git looking clean/synced while the caller
 * has no idea whether the push actually landed).
 *
 * Deliberately conservative in scope: the remote-check fallback fires ONLY
 * on `pushTimedOut` — a definite `pushError` (rejected, no upstream, auth
 * failure, etc.) is already an unambiguous "not pushed" signal and is left
 * unchanged (no extra network call on that path).
 */
export async function pushWithConfirmation(
  options: PushOptions,
  deps: PushDependencies,
  config: PushWithConfirmationConfig = {}
): Promise<PushWithConfirmationResult> {
  const pushTimeoutMs = config.pushTimeoutMs ?? DEFAULT_PUSH_CONFIRM_TIMEOUT_MS;
  const workdir = options.repoPath ?? validateProcess(process).cwd();

  let pushed = false;
  let pushTimedOut = false;
  let pushError: string | undefined;
  let resolvedWorkdir = workdir;

  try {
    const raced = await raceAgainstTimeout(pushImpl(options, deps), pushTimeoutMs);
    if (raced.timedOut) {
      pushTimedOut = true;
    } else {
      pushed = raced.value.pushed;
      resolvedWorkdir = raced.value.workdir;
    }
  } catch (err: unknown) {
    pushError = err instanceof Error ? err.message : String(err);
  }

  if (!pushTimedOut) {
    // Either a genuine success, or a definite thrown error (pushError set) —
    // both are unambiguous outcomes; no remote-check needed.
    return {
      workdir: resolvedWorkdir,
      pushed,
      ...(pushError !== undefined ? { pushError } : {}),
    };
  }

  // pushTimedOut is true here — the ambiguous case this task exists to
  // resolve. Attempt remote verification before reporting anything.
  const target = await resolveVerificationTarget(workdir, deps, config);
  const verification = target
    ? await verifyRemoteRefAdvanced(workdir, target.branch, target.expectedSha, deps, {
        remote: options.remote,
        timeoutMs: config.verifyTimeoutMs,
      })
    : undefined;

  if (verification?.confirmed) {
    return {
      workdir,
      pushed: true,
      pushTimedOut: true,
      pushConfirmedVia: "remote-check",
    };
  }

  return {
    workdir,
    pushed: false,
    pushTimedOut: true,
    pushUnconfirmed: true,
  };
}
