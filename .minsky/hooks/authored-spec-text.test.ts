/**
 * Tests for the shared authored-spec-text resolver (mt#4525, subsuming mt#4295).
 *
 * Its own file rather than more blocks in the three consumer suites: the resolver is
 * shared, and asserting it once beats asserting it three times with three different
 * fixtures that could drift apart — which is the duplication this module exists to end.
 */

import { describe, test, expect } from "bun:test";
import {
  canonicalizeInsideRepo,
  isInsideRepo,
  normalizeSpecToolName,
  readAuthoredSpecText,
  MAX_SPEC_FILE_BYTES,
} from "./authored-spec-text";

const EDIT_TOOL = "mcp__minsky__tasks_edit";
const INLINE_KEYS = { tasks_edit: "specContent", tasks_create: "spec" } as const;

/** An in-repo path that is a SYMLINK to somewhere outside — the PR #3309 R1 case. */
const SYMLINKED_IN_REPO_PATH = "/repo/docs/spec.md";

describe("normalizeSpecToolName — both callers' spellings resolve alike (mt#4525)", () => {
  // The two pre-existing guards keyed on DIFFERENT spellings. A resolver accepting
  // only one would cover one caller and silently miss the other — this family's own
  // defect, re-entered through its fix.
  test("the prefixed and bare spellings normalize to the same key", () => {
    expect(normalizeSpecToolName(EDIT_TOOL)).toBe("tasks_edit");
    expect(normalizeSpecToolName("tasks_edit")).toBe("tasks_edit");
    expect(normalizeSpecToolName("tasks.edit")).toBe("tasks_edit");
    expect(normalizeSpecToolName("mcp__minsky__tasks.edit")).toBe("tasks_edit");
  });

  test("a non-Minsky tool is left alone", () => {
    expect(normalizeSpecToolName("Bash")).toBe("bash");
  });
});

describe("isInsideRepo — containment on REAL paths (mt#4295 SC4, PR #3309 R1)", () => {
  const ROOT = "/repo";

  test("a path under the root is inside", () => {
    expect(isInsideRepo("/repo/docs/ordinary.md", ROOT)).toBe(true);
  });

  test("a path outside the root is not", () => {
    expect(isInsideRepo("/etc/passwd", ROOT)).toBe(false);
  });

  test("the root itself is not a spec", () => {
    expect(isInsideRepo(ROOT, ROOT)).toBe(false);
  });

  test("a sibling directory sharing a name PREFIX is not inside", () => {
    // `/repo-evil` starts with `/repo` as a string; `relative` is what makes this
    // correct, and a naive `startsWith` check would not.
    expect(isInsideRepo("/repo-evil/spec.md", ROOT)).toBe(false);
  });

  test("the LEXICAL form of a symlinked path passes — which is why the fix is elsewhere", () => {
    // This is the old code's whole bug in one line: the string it compared was
    // `/repo/docs/spec.md`, which IS inside the repo. `isInsideRepo` was never
    // wrong; it was being fed a path that had not been expanded.
    expect(isInsideRepo(SYMLINKED_IN_REPO_PATH, ROOT)).toBe(true);
  });
});

describe("canonicalizeInsideRepo — expansion happens (PR #3309 R1 regression)", () => {
  const ROOT = "/repo";
  const cwd = (): string => ROOT;

  /** `docs/spec.md` is an in-repo symlink pointing at `/etc/passwd`. */
  const realpathWithEvilSymlink = (p: string): string =>
    p === SYMLINKED_IN_REPO_PATH ? "/etc/passwd" : p;

  test("REGRESSION: an in-repo symlink pointing OUTSIDE is refused", () => {
    // The blocking finding. The old check compared `resolve()`d strings and never
    // touched the filesystem, so this exact path — no `..`, not absolute — passed
    // while the read followed the link to `/etc/passwd`. It reintroduced the class
    // it was written to close, which is worse than no check, because the comment
    // above it asserted the protection.
    expect(canonicalizeInsideRepo("docs/spec.md", realpathWithEvilSymlink, cwd)).toBeNull();
  });

  test("an ordinary in-repo file still resolves, and to its REAL path", () => {
    expect(canonicalizeInsideRepo("docs/real.md", (p) => p, cwd)).toBe("/repo/docs/real.md");
  });

  test("the repo ROOT is canonicalized too, not just the candidate", () => {
    // On macOS the session workspaces and `/tmp` are themselves symlinked
    // (`/tmp` → `/private/tmp`). Expanding only the candidate would compare a real
    // path against an unreal root and reject legitimate in-repo files.
    const realpathBoth = (p: string): string => p.replace(/^\/tmp/, "/private/tmp");
    expect(canonicalizeInsideRepo("docs/a.md", realpathBoth, () => "/tmp/repo")).toBe(
      "/private/tmp/repo/docs/a.md"
    );
  });

  test("a path that does not exist is null, not a containment verdict", () => {
    // `realpathSync` throws on a missing path. That must read as a coverage miss the
    // caller records, never as "outside the repo".
    expect(
      canonicalizeInsideRepo(
        "docs/gone.md",
        () => {
          throw new Error("ENOENT");
        },
        cwd
      )
    ).toBeNull();
  });

  test("an absolute outside path is refused after expansion too", () => {
    expect(canonicalizeInsideRepo("/etc/passwd", (p) => p, cwd)).toBeNull();
  });
});

describe("readAuthoredSpecText — inline vs by-reference (mt#4295)", () => {
  const reader = (): string => "from the file";

  test("inline wins, and the file is never opened", () => {
    const reads: string[] = [];
    const out = readAuthoredSpecText(EDIT_TOOL, { specContent: "inline" }, INLINE_KEYS, (p) => {
      reads.push(p);
      return "from the file";
    });
    expect(out).toEqual({ text: "inline", specFileUnreadable: false });
    expect(reads).toEqual([]);
  });

  test("by reference when there is no inline body", () => {
    expect(
      readAuthoredSpecText(EDIT_TOOL, { specFile: "docs/spec.md" }, INLINE_KEYS, reader)
    ).toEqual({ text: "from the file", specFileUnreadable: false });
  });

  test("an unreadable file is a MISS, flagged — not 'no spec here'", () => {
    // The distinction mt#4295 SC2 turns on: a guard that could not read its input has
    // not adjudicated it, and must not be recorded the same way as a call that simply
    // carried no spec.
    expect(
      readAuthoredSpecText(EDIT_TOOL, { specFile: "docs/spec.md" }, INLINE_KEYS, () => null)
    ).toEqual({ text: null, specFileUnreadable: true });
  });

  test("no spec at all is NOT flagged unreadable", () => {
    expect(readAuthoredSpecText(EDIT_TOOL, { taskId: "mt#1" }, INLINE_KEYS, reader)).toEqual({
      text: null,
      specFileUnreadable: false,
    });
  });

  test("a tool with no file key never reaches the reader", () => {
    // Only `tasks_edit` accepts a spec file. `tasks_create` carrying one is not a
    // by-reference write, and reading it would invent coverage that does not exist.
    const reads: string[] = [];
    const out = readAuthoredSpecText(
      "mcp__minsky__tasks_create",
      { specFile: "docs/spec.md" },
      INLINE_KEYS,
      (p) => {
        reads.push(p);
        return "from the file";
      }
    );
    expect(out.text).toBeNull();
    expect(reads).toEqual([]);
  });

  test("tasks_edit's boolean `spec` flag is not prose", () => {
    // PR #3063 R1 conflated this with `tasks_create`'s string `spec` body. The
    // typeof test is the whole defence; a truthiness check would regress it.
    const out = readAuthoredSpecText(EDIT_TOOL, { spec: true }, { tasks_edit: "spec" }, () => null);
    expect(out.text).toBeNull();
  });

  test("an unlisted tool contributes nothing", () => {
    expect(readAuthoredSpecText("Bash", { command: "ls" }, INLINE_KEYS, reader).text).toBeNull();
  });

  test("the size ceiling is a real bound, not decoration", () => {
    // Asserted as a property rather than by writing a 512 KB fixture: the ceiling's
    // job is to keep an arbitrarily large file out of a PreToolUse budget.
    expect(MAX_SPEC_FILE_BYTES).toBe(512 * 1024);
  });
});
