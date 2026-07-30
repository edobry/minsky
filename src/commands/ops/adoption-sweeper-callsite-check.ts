/**
 * Container-compatible callsite check via the GitHub REST API (mt#3351).
 *
 * ## Background
 *
 * mt#3328 fixed the adoption sweeper's callsite check so a `git grep`
 * failure (e.g. "not a git repository") is classified as `unavailable`
 * rather than a false `zero`. That fix made the failure SAFE, but it did
 * not make the check WORK on minsky-ops: the deployed container's image
 * excludes `.git` by design (see the root `Dockerfile` / `.dockerignore`),
 * so `git grep` can never succeed there — every tick's positive control
 * fails and the whole run hard-aborts (verified live 2026-07-30T00:04Z on
 * deployment `fe4836ee`). This module is the functional complement: a
 * callsite-check implementation that works from inside that same
 * container, using the GitHub App installation credentials the ops
 * service already carries (`MINSKY_APP_ID` / `MINSKY_APP_INSTALLATION_ID`
 * / `MINSKY_GITHUB_APP_PRIVATE_KEY`, mapped to `github.serviceAccount.*`
 * config — see `packages/domain/src/configuration/sources/environment.ts`).
 * The App's "Contents: Read & write" permission (`docs/github-app-bot-setup.md`)
 * already covers the read this module needs; no permission grant is required.
 *
 * ## Why tarball-fetch, not GitHub's code-search API
 *
 * `buildGrepPattern` (`packages/shared/src/adoption/signal-extraction.ts`)
 * returns a REGEX intended for `git grep -e` (e.g. the `lifecycleState`
 * kind embeds a literal `.` that is deliberately a grep wildcard —
 * `STATUS.DONE` matches `STATUSXDONE` too). GitHub's code-search API
 * (`GET /search/code`) is token/qualifier-based, not regex, and cannot
 * express that. It also carries its own tight rate limit (10 req/min for
 * an authenticated App) and indexing lag, neither of which fits a sweep
 * that checks one pattern per adoption signal per task.
 *
 * Instead: once per sweep tick, download the repo tarball at `main` HEAD
 * (`GET /repos/{owner}/{repo}/tarball/{ref}`, authenticated with the
 * installation token — the same credential path `createTokenProvider`
 * already provides to `pr-watch-scheduler.ts` / `deploy-smoke-sweep.ts`),
 * extract `src/**\/*.ts` entries into an in-memory snapshot, and run the
 * EXACT SAME pattern against that snapshot for every signal this tick —
 * translated to an equivalent JS `RegExp` via `bregToJsRegexSource`, which
 * escapes the seven characters (`+ ? | ( ) { }`) that are literal in git's
 * default BRE dialect but metacharacters in JS regex, so the two
 * mechanisms agree on every pattern `buildGrepPattern` can produce (see
 * that function's doc comment for the full dialect-parity argument). One
 * network fetch per run (24h cadence); every subsequent per-signal check
 * is a fast in-memory scan.
 *
 * ## Safety contract (mt#3328, preserved here)
 *
 * ANY failure fetching or extracting the tarball — auth failure, rate
 * limit, network error, malformed archive — resolves to `unavailable`,
 * never `zero`. This function never throws; every failure path returns
 * `{ status: "unavailable", reason }` so the caller (the same
 * `CallsiteCheckResult` three-outcome contract `checkCallsites` already
 * uses for the local git-grep path) can hard-skip exactly as it does for a
 * local `git grep` failure.
 *
 * @see mt#3328 — the container-blindness fix + positive-control canary this complements.
 * @see mt#3351 — this task.
 */

import { gunzipSync } from "node:zlib";
import type { CallsiteCheckResult } from "./start-command";

// ---------------------------------------------------------------------------
// Repo defaults
// ---------------------------------------------------------------------------

/** The repo this service is deployed from — see `infra/index.ts`'s hardcoded `sourceRepo: "edobry/minsky"`. */
const DEFAULT_OWNER = "edobry";
const DEFAULT_REPO = "minsky";
/** Per spec: "download the repo tarball at main HEAD." */
const DEFAULT_REF = "main";

/** Generous bound for a monorepo-sized tarball over a Railway network link. */
const TARBALL_FETCH_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// In-memory source snapshot
// ---------------------------------------------------------------------------

/** An in-memory snapshot of `src/**\/*.ts` file contents, keyed by repo-relative path. */
export interface RepoSourceSnapshot {
  files: Map<string, string>;
}

export type SnapshotFetchResult =
  | { status: "ok"; snapshot: RepoSourceSnapshot }
  | { status: "unavailable"; reason: string };

export interface FetchRepoSourceSnapshotDeps {
  /** Injectable fetch (test seam). Defaults to a bounded `createTimeoutFetch()`. */
  fetchImpl?: typeof fetch;
  owner?: string;
  repo?: string;
  ref?: string;
  /**
   * Test seam: override installation-token acquisition entirely, bypassing
   * `getConfiguration()`/`createTokenProvider()`. Lets tests simulate an
   * auth-acquisition failure without needing real Minsky configuration.
   */
  acquireTokenFn?: () => Promise<string>;
}

/**
 * Fetch the installation token, download the repo tarball at `ref`, and
 * extract `src/**\/*.ts` entries into an in-memory snapshot.
 *
 * Never throws: every failure (token acquisition, network, non-2xx
 * response, decompression/parse error) resolves to
 * `{ status: "unavailable", reason }` — the mt#3328 safety property this
 * task must preserve for the API path.
 */
export async function fetchRepoSourceSnapshot(
  deps: FetchRepoSourceSnapshotDeps = {}
): Promise<SnapshotFetchResult> {
  const owner = deps.owner ?? DEFAULT_OWNER;
  const repo = deps.repo ?? DEFAULT_REPO;
  const ref = deps.ref ?? DEFAULT_REF;

  try {
    const token = await (deps.acquireTokenFn ?? (() => acquireInstallationToken(owner, repo)))();
    const boundedFetch = deps.fetchImpl ?? (await buildBoundedFetch());

    const fetchResult = await fetchTarballWithRedirect(
      boundedFetch,
      `https://api.github.com/repos/${owner}/${repo}/tarball/${ref}`,
      token
    );

    if (!fetchResult.ok) {
      return {
        status: "unavailable",
        reason: `GitHub tarball fetch failed: ${fetchResult.status} ${fetchResult.statusText}`,
      };
    }

    const snapshot = extractTypeScriptSources(new Uint8Array(fetchResult.arrayBuffer));
    return { status: "ok", snapshot };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: "unavailable", reason: `GitHub tarball fetch/extract failed: ${reason}` };
  }
}

type TarballFetchOutcome =
  | { ok: true; arrayBuffer: ArrayBuffer }
  | { ok: false; status: number; statusText: string };

/**
 * Fetch the tarball, handling GitHub's cross-origin redirect EXPLICITLY
 * rather than relying on `fetch`'s automatic `redirect: "follow"`.
 *
 * `GET /repos/{owner}/{repo}/tarball/{ref}` responds with a 3xx redirect
 * to a signed download URL on a DIFFERENT origin (typically
 * `codeload.github.com`). Per the Fetch spec, an automatic cross-origin
 * redirect follow strips the `Authorization` header before re-issuing the
 * request — so trusting `fetch`'s default redirect handling risks an
 * UNAUTHENTICATED request to the redirect target, which 404s for a
 * private repo (mt#3351 review R1 BLOCKING). This function follows the
 * redirect manually and re-attaches the SAME Authorization header on the
 * follow-up request: the signed redirect URL typically embeds its own
 * short-lived token (making the header redundant there), but resending it
 * costs nothing and also covers the case where the redirect target still
 * checks it.
 */
async function fetchTarballWithRedirect(
  boundedFetch: typeof fetch,
  url: string,
  token: string
): Promise<TarballFetchOutcome> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const initial = await boundedFetch(url, { headers, redirect: "manual" });

  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get("location");
    if (!location) {
      return { ok: false, status: initial.status, statusText: "redirect with no Location header" };
    }
    const followUp = await boundedFetch(location, { headers });
    if (!followUp.ok) {
      return { ok: false, status: followUp.status, statusText: followUp.statusText };
    }
    return { ok: true, arrayBuffer: await followUp.arrayBuffer() };
  }

  if (!initial.ok) {
    return { ok: false, status: initial.status, statusText: initial.statusText };
  }
  return { ok: true, arrayBuffer: await initial.arrayBuffer() };
}

/** Real production token acquisition: the same `createTokenProvider` path used elsewhere (mt#3351). */
async function acquireInstallationToken(owner: string, repo: string): Promise<string> {
  const { getConfiguration } = await import("@minsky/domain/configuration/index");
  const { createTokenProvider } = await import("@minsky/domain/auth");
  const cfg = getConfiguration();
  const userToken = cfg.github?.token ?? "";
  const tokenProvider = createTokenProvider(cfg.github ?? {}, userToken);
  return tokenProvider.getServiceToken(`${owner}/${repo}`);
}

/** Real production bounded fetch — mirrors the mt#2677 pattern already used for Octokit clients. */
async function buildBoundedFetch(): Promise<typeof fetch> {
  const { createTimeoutFetch } = await import("@minsky/domain/github/octokit-timeout");
  return createTimeoutFetch(TARBALL_FETCH_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Minimal ustar/pax tar reader (no external dependency; see module doc)
// ---------------------------------------------------------------------------
//
// GitHub's tarball is generated server-side via `git archive`, which emits
// standard POSIX ustar with PAX extended headers only when the ustar
// name+prefix fields (100 + 155 bytes) can't hold a path. This reader
// handles both: plain ustar name/prefix concatenation, and PAX 'x'
// per-entry extended headers carrying a `path=` override. A 'g' global
// PAX header (git archive emits one for the commit comment) is skipped.
// Anything else (symlinks, directories, GNU longlink) is skipped by
// advancing past its data blocks without extracting content.
//
// Deliberately decodes every text field via `TextDecoder` rather than
// `Buffer#toString(encoding)`: this keeps every byte-slice typed as a
// plain `Uint8Array` (what `subarray` returns and what `TextDecoder#decode`
// accepts) without depending on Buffer's Node-specific `toString` overload
// resolving correctly under every TS toolchain this project runs
// (`tsgo`/`@typescript/native-preview`, per CLAUDE.md). The header fields
// this reader decodes are always ASCII (path text, octal digits, NUL/space
// padding), so UTF-8 decoding is exact for them.

const TAR_BLOCK_SIZE = 512;
const textDecoder = new TextDecoder("utf-8");

function isAllZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function readNullTerminatedString(field: Uint8Array): string {
  const nulIndex = field.indexOf(0);
  const trimmed = nulIndex === -1 ? field : field.subarray(0, nulIndex);
  return textDecoder.decode(trimmed);
}

/** Tar header size fields are 11 octal digits + a NUL/space terminator. */
function parseTarOctalField(field: Uint8Array): number {
  const str = textDecoder
    .decode(field)

    .replace(/[\0 ]+$/g, "")
    .trim();
  if (str.length === 0) return 0;
  const value = Number.parseInt(str, 8);
  return Number.isFinite(value) ? value : 0;
}

/** Extract the `path=<value>` record from a PAX extended-header body, if present. */
function extractPaxPath(paxBody: string): string | null {
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(paxBody);
  return match?.[1] ?? null;
}

/**
 * Walk every entry in a (decompressed) tar buffer, invoking `onEntry` for
 * each REGULAR FILE with its resolved path and content bytes. Directories,
 * symlinks, and other non-regular entries are skipped.
 */
function walkTarEntries(
  tarBuffer: Uint8Array,
  onEntry: (path: string, data: Uint8Array) => void
): void {
  let offset = 0;
  let pendingPaxPath: string | null = null;

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (isAllZeroBlock(header)) break; // EOF marker (two zero blocks; one is sufficient to stop).

    const nameField = header.subarray(0, 100);
    const sizeField = header.subarray(124, 136);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefixField = header.subarray(345, 500);

    const size = parseTarOctalField(sizeField);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (typeflag === "x" || typeflag === "g") {
      // PAX extended header: 'x' applies to the NEXT entry only, 'g' is a
      // global header (git archive's commit-comment record) — neither
      // carries file content to extract.
      if (typeflag === "x") {
        const paxBody = textDecoder.decode(tarBuffer.subarray(dataStart, dataEnd));
        pendingPaxPath = extractPaxPath(paxBody);
      }
      offset = dataStart + paddedSize;
      continue;
    }

    const isRegularFile = typeflag === "0" || typeflag === "\0" || typeflag === "";

    if (isRegularFile) {
      const path =
        pendingPaxPath ??
        (() => {
          const name = readNullTerminatedString(nameField);
          const prefix = readNullTerminatedString(prefixField);
          return prefix ? `${prefix}/${name}` : name;
        })();
      pendingPaxPath = null;

      // Extract unconditionally, including zero-length files (mt#3351
      // review non-blocking finding): an empty `.ts` file is a real,
      // legitimate entry — omitting it from the snapshot would silently
      // drop it, and `subarray` on a zero-length range is well-defined
      // (produces an empty view), so there's no reason to special-case it.
      onEntry(path, tarBuffer.subarray(dataStart, dataEnd));
    } else {
      pendingPaxPath = null;
    }

    offset = dataStart + paddedSize;
  }
}

/**
 * Decompress a `.tar.gz` buffer and extract every `src/**\/*.ts` entry into
 * an in-memory snapshot, stripping the leading `<owner>-<repo>-<sha>/`
 * directory GitHub's tarball always wraps entries in.
 */
export function extractTypeScriptSources(gzipped: Uint8Array): RepoSourceSnapshot {
  const tarBuffer: Uint8Array = gunzipSync(gzipped);
  const files = new Map<string, string>();

  walkTarEntries(tarBuffer, (entryPath, data) => {
    const slashIdx = entryPath.indexOf("/");
    const relativePath = slashIdx === -1 ? entryPath : entryPath.slice(slashIdx + 1);
    if (!relativePath.startsWith("src/") || !relativePath.endsWith(".ts")) return;
    files.set(relativePath, textDecoder.decode(data));
  });

  return { files };
}

// ---------------------------------------------------------------------------
// Pattern check against the in-memory snapshot
// ---------------------------------------------------------------------------

/**
 * Translate a pattern built for POSIX BRE `git grep -e <pattern>` (the
 * dialect `checkCallsites` uses — no `-E`/`-P`) into an equivalent JS
 * `RegExp` source.
 *
 * BRE and JS regex diverge on seven characters: `+ ? | ( ) { }` are LITERAL
 * in BRE unless backslash-escaped, but are METACHARACTERS in JS regex
 * unless backslash-escaped — the opposite default (mt#3351 review
 * non-blocking finding). `buildGrepPattern` never emits a BRE escape
 * sequence (e.g. `\+` for "one or more") for any of its signal kinds, so a
 * blanket escape of these seven characters is a safe, complete translation
 * for every pattern this sweeper builds. `.` `*` `^` `$` `[` `]` `\`
 * already mean the same thing in both dialects and pass through untouched
 * (this is what preserves the `lifecycleState` kind's literal-`.`-as-
 * wildcard behavior, e.g. `STATUS.DONE` also matching `STATUSXDONE`).
 */
function bregToJsRegexSource(pattern: string): string {
  return pattern.replace(/[+?|(){}]/g, "\\$&");
}

/**
 * Check `pattern` (from `buildGrepPattern`) against every file in
 * `snapshot`, mirroring `git grep -l`'s semantics: count = number of files
 * containing at least one match, `zero` when no file matches.
 *
 * Matches against each file's FULL content (not line-by-line): since none
 * of `buildGrepPattern`'s outputs use `^`/`$` anchors, and a JS `RegExp`
 * without the `s` (dotAll) flag already treats `.` as "not a newline" (the
 * same default `git grep` uses), whole-content and per-line matching are
 * equivalent for every pattern this sweeper builds.
 *
 * Returns `unavailable` (never throws) if `pattern` is not a valid JS
 * regex — a defensive branch matching `checkCallsites`'s "the check itself
 * could not run" semantics, distinct from a genuine zero-match result.
 */
export function checkCallsitesInSnapshot(
  snapshot: RepoSourceSnapshot,
  pattern: string
): CallsiteCheckResult {
  let regex: RegExp;
  try {
    regex = new RegExp(bregToJsRegexSource(pattern));
  } catch (err) {
    return {
      status: "unavailable",
      reason: `Invalid pattern for API-path scan: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let matchedFiles = 0;
  for (const content of snapshot.files.values()) {
    if (regex.test(content)) matchedFiles++;
  }

  return matchedFiles > 0 ? { status: "found", count: matchedFiles } : { status: "zero" };
}
