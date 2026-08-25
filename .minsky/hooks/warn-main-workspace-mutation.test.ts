/**
 * Tests for the main-workspace mutation observer (mt#2358).
 *
 * The two decisions are pure — `parseModifiedTracked` over git's own output and
 * `decideMutation` over two observations — so every branch that matters is
 * assertable without a repository, a session, or a Bash call.
 *
 * **What these tests are FOR.** The observer's value is that its fires mean
 * something, and the two ways it loses that are both covered here: flagging the
 * tree's pre-existing modifications (the first-run and steady-state cases), and
 * flagging untracked scratch files (the exemption). A detector that cries on
 * every call is discounted by its reader, which is the same as not shipping it.
 */

import { describe, test, expect } from "bun:test";
import {
  buildAdvisory,
  decideMutation,
  hasSessionWorkspace,
  parseModifiedTracked,
} from "./warn-main-workspace-mutation";

// Repeated literals extracted to satisfy custom/no-magic-string-duplication.
const CREDENTIALS_TSX = "src/cockpit/web/widgets/Credentials.tsx";
const ASK_DETAIL_TSX = "src/cockpit/web/widgets/AskDetail.tsx";
const SCRATCH_LOG = "scratch.log";

describe("parseModifiedTracked — what counts as a tracked modification", () => {
  test("includes modified, added, deleted and staged entries", () => {
    const porcelain = [
      ` M ${CREDENTIALS_TSX}`,
      `M  ${ASK_DETAIL_TSX}`,
      ` D docs/gone.md`,
      `A  packages/domain/src/new.ts`,
      "",
    ].join("\n");

    expect(parseModifiedTracked(porcelain)).toEqual([
      CREDENTIALS_TSX,
      ASK_DETAIL_TSX,
      "docs/gone.md",
      "packages/domain/src/new.ts",
    ]);
  });

  test("EXCLUDES untracked files — the exemption that keeps this usable", () => {
    // Legitimate main-workspace scratch and log writes exist, and were present
    // during the originating incident itself. This is the assertion that stops
    // the observer from burying its own signal.
    const porcelain = [` M ${CREDENTIALS_TSX}`, `?? ${SCRATCH_LOG}`, "?? .tmp-measure.ts"].join(
      "\n"
    );

    expect(parseModifiedTracked(porcelain)).toEqual([CREDENTIALS_TSX]);
  });

  test("reports the NEW path of a rename, not the old one", () => {
    expect(parseModifiedTracked("R  old/path.ts -> new/path.ts")).toEqual(["new/path.ts"]);
  });

  test("handles a path containing spaces, and strips porcelain's quoting", () => {
    expect(parseModifiedTracked(" M docs/a file.md")).toEqual(["docs/a file.md"]);
    expect(parseModifiedTracked(' M "docs/wéird.md"')).toEqual(["docs/wéird.md"]);
  });

  test("empty output is no modifications, not a crash", () => {
    expect(parseModifiedTracked("")).toEqual([]);
    expect(parseModifiedTracked("\n\n")).toEqual([]);
  });
});

describe("decideMutation — the baseline diff", () => {
  test("a file that became modified during the call is flagged", () => {
    // The 2026-08-23 incident in miniature: main was clean of this file, a Bash
    // call wrote it, and nothing else in the system produced a signal.
    const decision = decideMutation([], [CREDENTIALS_TSX]);

    expect(decision.fired).toBe(true);
    expect(decision.newlyModified).toEqual([CREDENTIALS_TSX]);
  });

  test("PRE-EXISTING modifications are NOT flagged — the dominant false positive", () => {
    // This repo carried three modified files before the observer ever ran. A
    // bare status read would re-report them on every single Bash call, which is
    // the noise the diff exists to remove.
    const preExisting = [CREDENTIALS_TSX, ASK_DETAIL_TSX];
    const decision = decideMutation(preExisting, preExisting);

    expect(decision.fired).toBe(false);
    expect(decision.newlyModified).toEqual([]);
  });

  test("flags ONLY the new file when others were already dirty", () => {
    const decision = decideMutation([ASK_DETAIL_TSX], [ASK_DETAIL_TSX, CREDENTIALS_TSX]);

    expect(decision.newlyModified).toEqual([CREDENTIALS_TSX]);
  });

  test("the FIRST observation reports nothing and only records the baseline", () => {
    // No baseline yet (fresh checkout, or the state file was removed). Everything
    // dirty at that moment predates the observer, so flagging it would be exactly
    // the noise the diff removes — and it would fire on the very first Bash call
    // of a session, which is where a reader's trust is cheapest to lose.
    const decision = decideMutation(null, [CREDENTIALS_TSX, ASK_DETAIL_TSX]);

    expect(decision.fired).toBe(false);
    expect(decision.newlyModified).toEqual([]);
    expect(decision.nextBaseline).toEqual([ASK_DETAIL_TSX, CREDENTIALS_TSX]);
  });

  test("a file going CLEAN is silent — that is the repair, not a mutation", () => {
    // `git_restore` is what the advisory asks for. Reporting it would flag the
    // fix as if it were the defect.
    const decision = decideMutation([CREDENTIALS_TSX], []);

    expect(decision.fired).toBe(false);
    expect(decision.nextBaseline).toEqual([]);
  });

  test("each file flags at most ONCE — the next call inherits it as baseline", () => {
    const first = decideMutation([], [CREDENTIALS_TSX]);
    expect(first.fired).toBe(true);

    // The shell persists `nextBaseline`; the following call sees it as known.
    const second = decideMutation(first.nextBaseline, [CREDENTIALS_TSX]);
    expect(second.fired).toBe(false);
  });

  test("the persisted baseline is sorted, so it does not churn on ordering alone", () => {
    const decision = decideMutation([], [CREDENTIALS_TSX, ASK_DETAIL_TSX]);
    expect(decision.nextBaseline).toEqual([ASK_DETAIL_TSX, CREDENTIALS_TSX]);
  });
});

describe("hasSessionWorkspace — the no-session narrowing (PR #3354 R1)", () => {
  const SESSION_ROOT = "/Users/x/.local/state/minsky/sessions";

  test("an empty session root means no session is open", () => {
    expect(hasSessionWorkspace(SESSION_ROOT, () => [])).toBe(false);
  });

  test("a session directory present means one may be open", () => {
    expect(hasSessionWorkspace(SESSION_ROOT, () => ["44e51685-76b6-47b1-97e3-cdbd84a1b099"])).toBe(
      true
    );
  });

  test("an unreadable root fails OPEN — absence of evidence is not evidence", () => {
    // Silence should require positive evidence that no session exists. An
    // unreadable root is not that, and treating it as "no session" would turn a
    // transient fs error into a permanently silent detector — the failure mode
    // that makes a probe worthless (mem#704).
    expect(
      hasSessionWorkspace(SESSION_ROOT, () => {
        throw new Error("ENOENT");
      })
    ).toBe(true);
  });

  test("the lister returns DIRECTORIES only, so a stray file is not a session", () => {
    // `defaultListDirs` filters on isDirectory(); this pins the contract the
    // injected lister must honour.
    expect(hasSessionWorkspace(SESSION_ROOT, () => [])).toBe(false);
  });
});

describe("buildAdvisory — what the reader is told", () => {
  test("names the repair, not just the problem", () => {
    // The originating incident's repair took three calls once noticed; an
    // advisory that only reports leaves the reader to rediscover them.
    const message = buildAdvisory([CREDENTIALS_TSX]);

    expect(message).toContain("git_restore");
    expect(message).toContain("session_write_file");
    expect(message).toContain(CREDENTIALS_TSX);
  });

  test("names the LEGITIMATE case too", () => {
    // A deliberate main-workspace edit is the residual false positive. A
    // detector that assumes every fire is a mistake trains its reader to
    // discount it.
    expect(buildAdvisory([CREDENTIALS_TSX])).toContain("deliberately editing main");
  });

  test("says why verifying in the session will not catch it", () => {
    // The can't-fail-probe half: the session is internally consistent either
    // way, so a passing typecheck and suite are not evidence.
    expect(buildAdvisory([CREDENTIALS_TSX])).toContain("internally consistent");
  });

  test("pluralizes on count", () => {
    expect(buildAdvisory([CREDENTIALS_TSX])).toContain("1 tracked file");
    expect(buildAdvisory([CREDENTIALS_TSX, ASK_DETAIL_TSX])).toContain("2 tracked files");
  });
});
