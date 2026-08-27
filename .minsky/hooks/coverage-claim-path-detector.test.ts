/**
 * Tests for the coverage-claim detector's PLUMBING — specifically which tree it
 * resolves a cited path against (mt#4674).
 *
 * The matcher core is tested in `./coverage-claim-path.test.ts`. Nothing here
 * re-tests matching; every case below varies the WORKSPACE and holds the text
 * fixed, because the defect these cover produced correct matching against the
 * wrong tree.
 *
 * The fixtures are the detector's two real live fires, both false: a session
 * wrote `packages/domain/src/agent-identity/live-conversation.ts` at 01:37:12Z
 * on 2026-08-27, then two files citing it 43s and 83s later. The module was in
 * the session workspace throughout; it reached main only at the merge, 02:17:53Z.
 *
 * Filesystems are modelled as a set of ABSOLUTE paths and probed exactly the way
 * `run()` probes them (`exists(resolve(root, candidate))`), so a test can hold
 * one tree state and vary only the root — which is the entire question.
 *
 * @see .minsky/hooks/coverage-claim-path-detector.ts
 */
import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { resolveTargetWorkspaceRoot, extractWriteTarget } from "./coverage-claim-path-detector";
import { findUnresolvedCoverageClaims } from "./coverage-claim-path";

const SESSIONS_ROOT = "/state/minsky/sessions";
const SESSION_ID = "2fd62984-218f-4f37-81d6-0a71994c8530";
const SESSION_ROOT = `${SESSIONS_ROOT}/${SESSION_ID}`;
const MAIN_ROOT = "/repo/minsky";

/** The module both fires cited, added by the same changeset that cited it. */
const CITED = "packages/domain/src/agent-identity/live-conversation.ts";
/** The first of the two citing files. */
const CITING = "src/mcp/stdio-proxy/conversation-identity.ts";

/** The real comment, trimmed to the citing line. `@see` is the claim phrase. */
const CITING_COMMENT = `/**\n * Conversation identity for the stdio proxy.\n *\n * @see ${CITED} — the resolution\n */`;

/** A session write, as `mcp__minsky__session_write_file` presents it. */
const SESSION_WRITE = { sessionId: SESSION_ID, path: CITING, content: CITING_COMMENT };

/** A filesystem as a set of ABSOLUTE paths. */
function fsWith(absolutePaths: string[]): (p: string) => boolean {
  const set = new Set(absolutePaths);
  return (p) => set.has(p);
}

/** The tree state at the moment of the two real fires. */
const AT_FIRE_TIME = fsWith([`${SESSION_ROOT}/${CITED}`]);

/**
 * The detector's pipeline below the root decision, probed as `run()` probes it.
 * Taking `root` as an argument is what lets a case hold the filesystem fixed and
 * vary only the tree being interrogated.
 */
function findingsUnderRoot(root: string, treeHas: (p: string) => boolean, toolInput: unknown) {
  const target = extractWriteTarget(toolInput, MAIN_ROOT, root);
  if (!target) return null;
  return findUnresolvedCoverageClaims(target.text, target.repoRelativePath, (candidate) =>
    treeHas(resolve(root, candidate))
  );
}

describe("resolveTargetWorkspaceRoot", () => {
  test("a session write resolves to its SESSION workspace, not the process cwd", () => {
    const root = resolveTargetWorkspaceRoot(
      SESSION_WRITE,
      MAIN_ROOT,
      SESSIONS_ROOT,
      fsWith([SESSION_ROOT])
    );

    expect(root).toBe(SESSION_ROOT);
  });

  test("AT4: a sessionId naming no existing workspace resolves to null, not a guess", () => {
    // Recording nothing is the right failure for a log-only detector: a finding
    // manufactured from an unlocatable tree is worse than a missed one.
    const root = resolveTargetWorkspaceRoot(
      { sessionId: "does-not-exist", path: CITING, content: CITING_COMMENT },
      MAIN_ROOT,
      SESSIONS_ROOT,
      fsWith([SESSION_ROOT])
    );

    expect(root).toBeNull();
  });

  test("an Edit/Write with no sessionId still resolves from the process cwd", () => {
    // The cwd branch is the one `types.ts` calls "right for a target path the
    // caller supplied" — this fix narrows it to non-session tools, not away.
    const root = resolveTargetWorkspaceRoot(
      { file_path: "/repo/minsky/src/thing.ts", content: CITING_COMMENT },
      import.meta.dir,
      SESSIONS_ROOT,
      fsWith([SESSION_ROOT])
    );

    expect(root).not.toBeNull();
    expect(root?.startsWith(SESSIONS_ROOT)).toBe(false);
  });

  test("an empty-string sessionId falls through to cwd rather than joining to the sessions dir", () => {
    const root = resolveTargetWorkspaceRoot(
      { sessionId: "", file_path: "/repo/minsky/src/thing.ts", content: CITING_COMMENT },
      import.meta.dir,
      SESSIONS_ROOT,
      fsWith([SESSION_ROOT])
    );

    expect(root).not.toBe(SESSIONS_ROOT);
    expect(root).not.toBeNull();
  });
});

describe("extractWriteTarget — a session path is relative to the session workspace", () => {
  test("a session-relative path stays repo-relative when resolved against the session root", () => {
    const target = extractWriteTarget(SESSION_WRITE, MAIN_ROOT, SESSION_ROOT);

    expect(target?.repoRelativePath).toBe(CITING);
  });

  test("an absolute path inside the session workspace is relativised against it", () => {
    const target = extractWriteTarget(
      { sessionId: SESSION_ID, path: `${SESSION_ROOT}/${CITING}`, content: CITING_COMMENT },
      MAIN_ROOT,
      SESSION_ROOT
    );

    expect(target?.repoRelativePath).toBe(CITING);
  });

  test("a path outside the target workspace is refused", () => {
    const target = extractWriteTarget(
      { sessionId: SESSION_ID, path: "/somewhere/else/thing.ts", content: CITING_COMMENT },
      MAIN_ROOT,
      SESSION_ROOT
    );

    expect(target).toBeNull();
  });
});

describe("AT1 — the two recorded live fires do not fire under the fix", () => {
  test("AT1: the cited module is present in the session workspace, so there is no finding", () => {
    const root = resolveTargetWorkspaceRoot(
      SESSION_WRITE,
      MAIN_ROOT,
      SESSIONS_ROOT,
      fsWith([SESSION_ROOT])
    );

    expect(findingsUnderRoot(root as string, AT_FIRE_TIME, SESSION_WRITE)).toEqual([]);
  });

  test("AT1 negative control: the SAME input against the MAIN root reproduces the false fire", () => {
    // This is the pre-fix behaviour, and it must still be reachable — otherwise
    // the AT1 assertion above passes for some reason other than the root choice.
    const findings = findingsUnderRoot(MAIN_ROOT, AT_FIRE_TIME, SESSION_WRITE);

    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.citedPath).toBe(CITED);
  });
});

describe("AT2 — a genuine dead pointer still fires", () => {
  test("AT2: a path absent from BOTH trees is still a finding", () => {
    const deadPointer = `/**\n * @see scripts/deleted-thing.ts — the sweep\n */`;
    const input = { sessionId: SESSION_ID, path: CITING, content: deadPointer };
    const emptyTree = fsWith([SESSION_ROOT]);

    const findings = findingsUnderRoot(SESSION_ROOT, emptyTree, input);

    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.citedPath).toBe("scripts/deleted-thing.ts");
  });
});

describe("AT3 — the false-NEGATIVE direction is closed", () => {
  // The silent half of the same defect. A session deletes a file and then writes
  // a comment citing the old path; resolved against main the path still exists,
  // so the detector records nothing at the exact moment a dead pointer is being
  // authored. This case FAILS on the pre-fix code.
  const DELETED_IN_SESSION = fsWith([SESSION_ROOT, `${MAIN_ROOT}/${CITED}`]);

  test("AT3: a path deleted in the session but still on main IS a finding", () => {
    // Resolve through the function under test rather than passing SESSION_ROOT
    // as a literal — otherwise this asserts the pipeline given a correct root
    // and says nothing about the root DECISION, which is the whole fix. (Caught
    // by the negative control: the literal form passed against pre-fix code.)
    const root = resolveTargetWorkspaceRoot(
      SESSION_WRITE,
      MAIN_ROOT,
      SESSIONS_ROOT,
      DELETED_IN_SESSION
    );

    expect(root).toBe(SESSION_ROOT);

    const findings = findingsUnderRoot(root as string, DELETED_IN_SESSION, SESSION_WRITE);

    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.citedPath).toBe(CITED);
  });

  test("AT3 negative control: against the MAIN root the same dead pointer is silently missed", () => {
    expect(findingsUnderRoot(MAIN_ROOT, DELETED_IN_SESSION, SESSION_WRITE)).toEqual([]);
  });
});
