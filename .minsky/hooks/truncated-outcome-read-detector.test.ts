/**
 * Unit tests for truncated-outcome-read-detector (mt#4096).
 *
 * The non-firing cases carry as much weight as the firing one. This detector's whole design bet is
 * that positional truncation of a MUTATING command is distinguishable from the two shapes that
 * surround it and are fine — a targeted field read, and truncating a read-only command. If it
 * cannot tell them apart it becomes the unmatchable noise mem#719 records as eroding trust in a
 * detector's true positives.
 */

import { describe, test, expect } from "bun:test";
import { scanCommand } from "./truncated-outcome-read-detector";

describe("scanCommand — fires on positional truncation of a mutating command", () => {
  test("the originating incident's exact command (mt#4096)", () => {
    const result = scanCommand(
      "minsky session commit --task 'mt#4089' \"$(cat msg.txt)\" 2>&1 | tail -6"
    );
    expect(result.matched).toBe(true);
    expect(result.filter).toBe("tail");
    expect(result.mutatingCommand).toContain("session commit");
  });

  test("`head` truncates just as blindly as `tail`", () => {
    expect(scanCommand("minsky git push --session abc | head -3").matched).toBe(true);
  });

  test("fires through a multi-stage pipeline, not only the stage right after the command", () => {
    expect(scanCommand("minsky session pr create --task mt#1 | cat | tail -2").matched).toBe(true);
  });

  test("fires on a later top-level segment, not only the first", () => {
    expect(scanCommand("echo start; minsky session pr merge --task mt#1 | tail -5").matched).toBe(
      true
    );
  });

  test("whitespace between the subcommand words does not evade the match", () => {
    expect(scanCommand("minsky  session   commit --task mt#1 'm' | tail -1").matched).toBe(true);
  });

  test("the `sess` alias is covered", () => {
    expect(scanCommand("minsky sess commit --task mt#1 'm' | tail -1").matched).toBe(true);
  });
});

describe("scanCommand — does NOT fire on the shapes that surround it", () => {
  test("a targeted field read is the REMEDY, not the defect", () => {
    // This is precisely what the warning tells the author to do. Firing here would tell them to
    // stop doing the correct thing.
    expect(
      scanCommand("minsky session commit --task mt#1 'm' --json | jq -r '.pushed'").matched
    ).toBe(false);
  });

  test("grep is a field read too — dropped from the trigger set deliberately", () => {
    expect(scanCommand("minsky session commit --task mt#1 'm' | grep -E 'pushed'").matched).toBe(
      false
    );
  });

  test("truncating a READ-ONLY command is ordinary", () => {
    expect(scanCommand("minsky git log --limit 50 | head -20").matched).toBe(false);
    expect(scanCommand("minsky tasks list | tail -10").matched).toBe(false);
  });

  test("a mutating command with no pipeline at all", () => {
    expect(scanCommand("minsky session commit --task mt#1 'm' --json").matched).toBe(false);
  });

  test("a heredoc body that merely CONTAINS the shape does not fire (mt#4088 hazard)", () => {
    // The leading command of the first pipeline stage is `cat`, not `minsky` — so the structural
    // check handles this without a bespoke heredoc guard.
    const command = "cat > /tmp/notes.md <<'EOF'\nminsky session commit --task mt#1 | tail -6\nEOF";
    expect(scanCommand(command).matched).toBe(false);
  });

  test("a pipe inside a quoted argument is not a pipeline (quote-aware split)", () => {
    expect(scanCommand("minsky session commit --task mt#1 'fix: a | b'").matched).toBe(false);
  });

  test("an unrelated command that happens to end in tail", () => {
    expect(scanCommand("cat /var/log/x | tail -100").matched).toBe(false);
  });
});
