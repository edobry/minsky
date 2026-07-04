/**
 * Slow-clock topology derivation (mt#2602) — pure functions.
 *
 * v3 feature 3 of mt#2378 (parent umbrella mt#2375, "SLOW clock made real").
 * Two halves live here:
 *
 *   1. **Registry walk** — the guard-hook set the plant's S2 valve inventory
 *      derives from, instead of a hand-laid 4-item constant. Covers the
 *      mt#2304 migration window: hook sources are moving from `.claude/hooks/`
 *      to `.minsky/hooks/` (PR #1562, open as of this task); this module reads
 *      BOTH locations and dedupes so the derivation is correct whether the
 *      migration has landed, is mid-flight, or hasn't started.
 *   2. **Weld history** — install date (git-log) + originating-failure link
 *      (`retrospective.fired` events, mt#2537) per hook, so the plant's
 *      self-construction log is browsable.
 *
 * Deliberately import-free of `fs`/`child_process`/DB clients: every function
 * here takes plain data (directory listings, git-log text, event rows) and
 * returns plain data. The impure I/O (readdir, bounded git subprocess, DB
 * query) lives in `topology-cache.ts`, which calls into these functions.
 *
 * Honest-data discipline (mt#2602 success criterion 4): underivable
 * provenance (no git history, no correlated retrospective) renders as `null`
 * fields — never a guessed date or a fabricated failure story.
 *
 * @see mt#2602 — this task
 * @see mt#2375 §SLOW-TOPO, §Learning loop — parent umbrella
 * @see mt#2537 — `retrospective.fired` / `hook.fired` event types this module consumes
 * @see mt#2304 / PR #1562 — hooks compile-pipeline migration (.minsky/hooks/ source)
 */

// ---------------------------------------------------------------------------
// Hook registry — directory listing -> deduped inventory
// ---------------------------------------------------------------------------

/** Canonical source-directory labels for a hook, post-mt#2304 migration. */
export type HookSourceDir = ".minsky/hooks" | ".claude/hooks";

/**
 * Directory listings for both possible hook-source locations. `null` means
 * the directory does not exist (the common case for `.minsky/hooks` before
 * mt#2304 lands); an empty array means the directory exists but is empty.
 * Entries are bare filenames (e.g. `"check-branch-fresh.ts"`), not paths.
 */
export interface HookFileListing {
  claudeHooks: string[] | null;
  minskyHooks: string[] | null;
}

export interface HookRegistryEntry {
  /** Hook name without extension, e.g. "check-branch-fresh". */
  name: string;
  /** Canonical source directory for this hook at derivation time. */
  sourceDir: HookSourceDir;
}

const TS_EXTENSION = ".ts";
const TEST_FILE_SUFFIX = ".test.ts";
const DECLARATION_FILE_SUFFIX = ".d.ts";

/**
 * A hook source is a `.ts` file that is neither a test file (`*.test.ts`)
 * nor a TypeScript declaration file (`*.d.ts`). Declaration files end in
 * `.ts` too, so a bare `.endsWith(".ts")` check would wrongly count them as
 * hooks (R1 review finding, mt#2602 PR #1786) — they carry no runtime
 * behavior and are never invoked by the harness as a hook.
 *
 * Exported so the impure directory lister in `topology-cache.ts` can filter
 * with the exact same predicate at the I/O boundary (R2 review finding) —
 * a single source of truth rather than two independently-maintained filters
 * that could drift out of sync.
 */
export function isHookSourceFile(filename: string): boolean {
  return (
    filename.endsWith(TS_EXTENSION) &&
    !filename.endsWith(TEST_FILE_SUFFIX) &&
    !filename.endsWith(DECLARATION_FILE_SUFFIX)
  );
}

function stripTsExtension(filename: string): string {
  return filename.slice(0, -TS_EXTENSION.length);
}

/**
 * Derive the deduped hook registry from listings of both possible source
 * locations. During the mt#2304 migration a hook may exist in both places
 * (the `.minsky/hooks/` source and its compiled `.claude/hooks/` output);
 * `.minsky/hooks/` wins as the canonical source when both list a name, per
 * the "derive from whichever is canonical ... prefer BOTH with dedupe if
 * mid-flight" coordinator note. Result is sorted by name for deterministic
 * output (stable widget rendering / diffable tests).
 */
export function deriveHookRegistry(listing: HookFileListing): HookRegistryEntry[] {
  const byName = new Map<string, HookRegistryEntry>();

  for (const f of listing.claudeHooks ?? []) {
    if (!isHookSourceFile(f)) continue;
    const name = stripTsExtension(f);
    byName.set(name, { name, sourceDir: ".claude/hooks" });
  }
  // .minsky/hooks/ is the canonical source once mt#2304 lands — overwrite any
  // same-named .claude/hooks/ entry (its compiled-output counterpart).
  for (const f of listing.minskyHooks ?? []) {
    if (!isHookSourceFile(f)) continue;
    const name = stripTsExtension(f);
    byName.set(name, { name, sourceDir: ".minsky/hooks" });
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// git-log parse — install date + commit + derived task ref per hook
// ---------------------------------------------------------------------------

export interface HookInstallInfo {
  name: string;
  commitSha: string | null;
  /** ISO-8601 author date of the add-commit, or null if unparseable. */
  commitDate: string | null;
  commitSubject: string | null;
  /** Task ref (e.g. "mt#2537") parsed from the commit subject, or null. */
  derivedTaskId: string | null;
}

/**
 * `git log` format string for the bounded hook-install subprocess (see
 * `topology-cache.ts`'s `runHookInstallGitLog`). One `COMMIT` line per commit,
 * tab-separated hash/author-date/subject, followed by `--name-only` file
 * paths for that commit.
 */
export const HOOK_INSTALL_GIT_LOG_FORMAT = "COMMIT\t%H\t%aI\t%s";

/** Full argv (minus `-C <repoRoot>`) for the bounded hook-install git log. */
export const HOOK_INSTALL_GIT_LOG_ARGS = [
  "log",
  "--reverse",
  "--diff-filter=A",
  "--name-only",
  `--format=${HOOK_INSTALL_GIT_LOG_FORMAT}`,
  "--",
  ".claude/hooks",
  ".minsky/hooks",
];

const TASK_ID_RE = /\b(mt#\d+)\b/i;

/** Parse a task ref (e.g. "mt#2537") out of a commit subject, per Minsky's `type(mt#N): ...` convention. */
export function deriveTaskIdFromSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const m = subject.match(TASK_ID_RE);
  return m?.[1] ? m[1].toLowerCase() : null;
}

const HOOK_PATH_RE = /^\.(?:claude|minsky)\/hooks\/([^/]+)\.ts$/;

/**
 * Parse `git log --reverse --diff-filter=A --name-only
 * --format=HOOK_INSTALL_GIT_LOG_FORMAT -- .claude/hooks .minsky/hooks` output
 * into a per-hook-name install-info map.
 *
 * `--reverse` means the log is oldest-first, so the FIRST occurrence of a
 * given hook name is its original install commit — a later `git mv` (e.g.
 * the mt#2304 migration) shows up as a rename, not a second "A" entry, so the
 * original install date is preserved even across the source-directory move.
 */
export function parseHookInstallLog(stdout: string): Map<string, HookInstallInfo> {
  const result = new Map<string, HookInstallInfo>();
  let current: { sha: string; date: string | null; subject: string } | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    if (line.startsWith("COMMIT\t")) {
      const parts = line.split("\t");
      const sha = parts[1];
      const date = parts[2];
      const subject = parts.slice(3).join("\t");
      current =
        sha && /^[0-9a-f]{7,40}$/i.test(sha)
          ? {
              sha,
              date: date && !Number.isNaN(Date.parse(date)) ? date : null,
              subject: subject || "",
            }
          : null;
      continue;
    }

    if (!current) continue;
    const match = line.match(HOOK_PATH_RE);
    if (!match?.[1]) continue;
    const name = match[1];
    if (name.endsWith(".test")) continue; // test-file adds aren't hook installs
    if (name.endsWith(".d")) continue; // declaration-file adds (*.d.ts) aren't hook installs
    if (result.has(name)) continue; // keep the first (oldest, --reverse) occurrence

    result.set(name, {
      name,
      commitSha: current.sha,
      commitDate: current.date,
      commitSubject: current.subject || null,
      derivedTaskId: deriveTaskIdFromSubject(current.subject),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Retrospective correlation — forward link (mt#2537 retrospective.fired)
// ---------------------------------------------------------------------------

/** Minimal shape of a `retrospective.fired` system-event row this module needs. */
export interface RetrospectiveEventInput {
  id: string;
  /** ISO-8601 event timestamp. */
  createdAt: string;
  payload: { note?: unknown; taskId?: unknown };
}

export interface RetrospectiveLink {
  eventId: string;
  note: string | null;
  taskId: string | null;
  createdAt: string;
  /** "task-ref" = payload.taskId matched the hook's derived commit task ref (strong).
   *  "time-proximity" = nearest retrospective preceding the install commit within the window (weaker). */
  matchType: "task-ref" | "time-proximity";
}

/**
 * Backward-looking correlation window: a retrospective should precede (or
 * closely coincide with) the interlock commit it produced. 14 days covers
 * the plan -> implement -> merge lag typical of Minsky's task lifecycle
 * without over-matching unrelated retrospectives that happen to be nearby.
 */
export const RETROSPECTIVE_CORRELATION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function normalizeTaskId(v: unknown): string | null {
  return typeof v === "string" && v ? v.toLowerCase() : null;
}

function noteOf(payload: { note?: unknown }): string | null {
  return typeof payload.note === "string" ? payload.note : null;
}

/**
 * Correlate a single hook's install info against candidate `retrospective.fired`
 * events. Two-tier match, strong first:
 *
 *   1. `task-ref` — a retrospective whose `payload.taskId` equals the task ref
 *      parsed from the install commit's subject line (Minsky's `type(mt#N): ...`
 *      convention). Exact and unambiguous.
 *   2. `time-proximity` — absent a task-ref match, the nearest retrospective
 *      that precedes (or coincides with) the install commit within `windowMs`.
 *
 * Returns null (honest "unknown") when neither tier finds a candidate, or
 * when the hook has no install date to correlate against.
 */
export function correlateRetrospective(
  hook: HookInstallInfo,
  retrospectives: RetrospectiveEventInput[],
  windowMs: number = RETROSPECTIVE_CORRELATION_WINDOW_MS
): RetrospectiveLink | null {
  if (!hook.commitDate) return null;
  const commitMs = Date.parse(hook.commitDate);
  if (Number.isNaN(commitMs)) return null;

  if (hook.derivedTaskId) {
    const direct = retrospectives.find(
      (r) => normalizeTaskId(r.payload.taskId) === hook.derivedTaskId
    );
    if (direct) {
      return {
        eventId: direct.id,
        note: noteOf(direct.payload),
        taskId: normalizeTaskId(direct.payload.taskId),
        createdAt: direct.createdAt,
        matchType: "task-ref",
      };
    }
  }

  let best: { r: RetrospectiveEventInput; deltaMs: number } | null = null;
  for (const r of retrospectives) {
    const retroMs = Date.parse(r.createdAt);
    if (Number.isNaN(retroMs)) continue;
    const delta = commitMs - retroMs;
    if (delta < 0 || delta > windowMs) continue; // must precede the commit, within the window
    if (!best || delta < best.deltaMs) best = { r, deltaMs: delta };
  }
  if (!best) return null;

  return {
    eventId: best.r.id,
    note: noteOf(best.r.payload),
    taskId: normalizeTaskId(best.r.payload.taskId),
    createdAt: best.r.createdAt,
    matchType: "time-proximity",
  };
}

// ---------------------------------------------------------------------------
// Weld entries — the final per-hook browsable-history row
// ---------------------------------------------------------------------------

export interface WeldEntry {
  name: string;
  sourceDir: HookSourceDir;
  /** ISO-8601 install date, or null when git history is unavailable (honest "unknown"). */
  installDate: string | null;
  commitSha: string | null;
  /** GitHub commit URL, or null when unavailable/non-GitHub remote. */
  commitUrl: string | null;
  retrospective: RetrospectiveLink | null;
}

/**
 * Combine the registry, git-derived install info, and retrospective
 * correlation into the final weld-history rows, sorted most-recently-installed
 * first (entries with no derivable install date sort last, alphabetically —
 * never faked to look chronological).
 */
export function buildWeldEntries(
  registry: HookRegistryEntry[],
  installMap: Map<string, HookInstallInfo>,
  retrospectives: RetrospectiveEventInput[],
  repoWebBase: string | null,
  windowMs: number = RETROSPECTIVE_CORRELATION_WINDOW_MS
): WeldEntry[] {
  const entries: WeldEntry[] = registry.map((entry) => {
    const install = installMap.get(entry.name) ?? null;
    const retrospective = install
      ? correlateRetrospective(install, retrospectives, windowMs)
      : null;
    return {
      name: entry.name,
      sourceDir: entry.sourceDir,
      installDate: install?.commitDate ?? null,
      commitSha: install?.commitSha ?? null,
      commitUrl:
        install?.commitSha && repoWebBase ? `${repoWebBase}/commit/${install.commitSha}` : null,
      retrospective,
    };
  });

  return entries.sort((a, b) => {
    if (a.installDate && b.installDate) return b.installDate.localeCompare(a.installDate);
    if (a.installDate) return -1;
    if (b.installDate) return 1;
    return a.name.localeCompare(b.name);
  });
}
