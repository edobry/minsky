/**
 * Unified diff parser for GitHub PR diffs.
 *
 * Parses a unified diff string into structured hunks that can be used to
 * construct valid line-anchored review comments for the GitHub API
 * (octokit.rest.pulls.createReview comments[]). See:
 *   https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request
 *
 * The output shape mirrors the parsedDiff field in SessionPrReviewContextResult.
 *
 * Side semantics (relevant to anchor selection):
 *  - RIGHT lines (`newLine` set, `oldLine` null) — anchor on the head/incoming side.
 *  - LEFT lines (`oldLine` set, `newLine` null) — anchor on the base/old side
 *    (used to comment on deletions or pre-change code).
 *  - CONTEXT lines (both set) — unchanged lines; usable as anchors on either side.
 *
 * Reviewers picking anchors should match the side they want to comment on:
 * commenting on a deletion needs `side: "LEFT"`; commenting on an addition needs
 * `side: "RIGHT"`. CONTEXT lines are flexible.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export type DiffFileSide = "LEFT" | "RIGHT" | "CONTEXT";
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffLine {
  /** Which side of the diff this line belongs to. */
  side: DiffFileSide;
  /** 1-based line number in the old file (null for RIGHT lines). */
  oldLine: number | null;
  /** 1-based line number in the new file (null for LEFT lines). */
  newLine: number | null;
  /** Line content without the leading +/-/space prefix. */
  content: string;
}

export interface DiffHunk {
  /** 1-based start line in the old file. */
  oldStart: number;
  /** Number of lines from the old file this hunk covers. */
  oldLines: number;
  /** 1-based start line in the new file. */
  newStart: number;
  /** Number of lines from the new file this hunk covers. */
  newLines: number;
  /** Raw "@@ -a,b +c,d @@" hunk header line. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Path in the new tree (or deleted path for deleted files). */
  path: string;
  /** Original path before rename (only set for renamed files). */
  oldPath?: string;
  status: DiffFileStatus;
  hunks: DiffHunk[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Determine the file path from --- / +++ header values, stripping the
 * "a/" and "b/" prefixes that git adds.
 */
function stripGitPrefix(headerPath: string): string {
  // Remove leading a/ or b/ prefix added by git
  if (headerPath.startsWith("a/") || headerPath.startsWith("b/")) {
    return headerPath.slice(2);
  }
  // /dev/null signals file creation or deletion — callers handle separately
  return headerPath;
}

// Match: @@ -oldStart[,oldLines] +newStart[,newLines] @@ [optional context]
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// Match rename source/dest in extended headers
// e.g. "rename from path/to/old" / "rename to path/to/new"
const RENAME_FROM_RE = /^rename from (.+)$/;
const RENAME_TO_RE = /^rename to (.+)$/;

// ── Main parser ───────────────────────────────────────────────────────────

/**
 * Parse a full unified diff string (typically from a GitHub PR diff endpoint)
 * into an array of DiffFile objects.
 *
 * Handles:
 * - Pure-add files (--- /dev/null)
 * - Pure-delete files (+++ /dev/null)
 * - Modified files (single or multi-hunk)
 * - Renames without content change (no hunks)
 * - Renames with content change (has hunks)
 * - "\ No newline at end of file" markers (skipped, not counted as lines)
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const lines = diffText.split("\n");
  const files: DiffFile[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Advance until we hit a "diff --git" line (start of a new file section)
    if (!line.startsWith("diff --git ")) {
      i++;
      continue;
    }

    // ── Parse file header block ──────────────────────────────────────────
    i++;

    let oldPath: string | undefined;
    let newPath: string | undefined;
    let isRename = false;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;

    // Read extended headers until we hit --- or @@
    while (i < lines.length) {
      const hdr = lines[i] ?? "";

      if (hdr.startsWith("--- ") || hdr.startsWith("@@ ") || hdr.startsWith("diff --git ")) {
        break;
      }

      const renameFromMatch = RENAME_FROM_RE.exec(hdr);
      if (renameFromMatch) {
        renameFrom = renameFromMatch[1] ?? "";
        isRename = true;
        i++;
        continue;
      }

      const renameToMatch = RENAME_TO_RE.exec(hdr);
      if (renameToMatch) {
        renameTo = renameToMatch[1] ?? "";
        i++;
        continue;
      }

      i++;
    }

    // Read --- and +++ headers
    const minusLine = lines[i] ?? "";
    if (i < lines.length && minusLine.startsWith("--- ")) {
      oldPath = stripGitPrefix(minusLine.slice(4).split("\t")[0] ?? "");
      i++;
    }
    const plusLine = lines[i] ?? "";
    if (i < lines.length && plusLine.startsWith("+++ ")) {
      newPath = stripGitPrefix(plusLine.slice(4).split("\t")[0] ?? "");
      i++;
    }

    // Determine status
    let status: DiffFileStatus;
    let filePath: string;
    let fileOldPath: string | undefined;

    if (isRename && renameFrom && renameTo) {
      status = "renamed";
      filePath = renameTo;
      fileOldPath = renameFrom;
    } else if (oldPath === "/dev/null") {
      // New file
      status = "added";
      filePath = newPath ?? "";
    } else if (newPath === "/dev/null") {
      // Deleted file
      status = "deleted";
      filePath = oldPath ?? "";
    } else {
      status = "modified";
      filePath = newPath ?? oldPath ?? "";
    }

    // ── Parse hunks ──────────────────────────────────────────────────────
    const hunks: DiffHunk[] = [];

    while (i < lines.length) {
      const hunkLine = lines[i] ?? "";

      // Stop at next file
      if (hunkLine.startsWith("diff --git ")) {
        break;
      }

      const hunkMatch = HUNK_HEADER_RE.exec(hunkLine);
      if (!hunkMatch) {
        i++;
        continue;
      }

      const hunkHeader = hunkLine;
      const oldStart = parseInt(hunkMatch[1] ?? "0", 10);
      const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3] ?? "0", 10);
      const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

      i++;

      const diffLines: DiffLine[] = [];
      let oldLineNum = oldStart;
      let newLineNum = newStart;

      while (i < lines.length) {
        const diffLine = lines[i] ?? "";

        // Stop at next hunk header or next file
        if (diffLine.startsWith("@@ ") || diffLine.startsWith("diff --git ")) {
          break;
        }

        if (diffLine === "\\ No newline at end of file") {
          // This is a git metadata marker, not an actual line — skip it
          i++;
          continue;
        }

        // A truly empty line ends the hunk — real context lines always carry
        // a leading space prefix, so an empty string is the trailing newline
        // from split("\n") or a blank separator before the next file.
        if (diffLine === "") {
          i++;
          break;
        }

        const prefix = diffLine[0];
        const content = diffLine.slice(1);

        if (prefix === "+") {
          diffLines.push({
            side: "RIGHT",
            oldLine: null,
            newLine: newLineNum,
            content,
          });
          newLineNum++;
        } else if (prefix === "-") {
          diffLines.push({
            side: "LEFT",
            oldLine: oldLineNum,
            newLine: null,
            content,
          });
          oldLineNum++;
        } else if (prefix === " ") {
          diffLines.push({
            side: "CONTEXT",
            oldLine: oldLineNum,
            newLine: newLineNum,
            content,
          });
          oldLineNum++;
          newLineNum++;
        } else {
          // Unknown prefix — skip
          i++;
          continue;
        }

        i++;
      }

      hunks.push({
        oldStart,
        oldLines,
        newStart,
        newLines,
        header: hunkHeader,
        lines: diffLines,
      });
    }

    const fileEntry: DiffFile = {
      path: filePath,
      status,
      hunks,
    };

    if (fileOldPath !== undefined) {
      fileEntry.oldPath = fileOldPath;
    }

    files.push(fileEntry);
  }

  return files;
}
