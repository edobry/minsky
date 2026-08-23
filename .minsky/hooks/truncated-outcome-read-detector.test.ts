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

describe("truncated-outcome-read — the enumeration arm (mt#4176)", () => {
  test("the originating incident: a --help listing truncated by head", () => {
    // `minsky mcp --help | head -15` cut the subcommand list mid-entry (descriptions wrap), and
    // `proxy`/`shim` were below the cut. The conclusion drawn was that neither was registered.
    const result = scanCommand("minsky mcp --help | head -15");
    expect(result.matched).toBe(true);
    expect(result.kind).toBe("enumeration");
    expect(result.filter).toBe("head");
  });

  test("any CLI's --help counts — the arm is not Minsky-specific", () => {
    expect(scanCommand("some-cli --help | tail -5").kind).toBe("enumeration");
  });

  test("SAMPLING a read is still ordinary — the original carve-out is preserved", () => {
    // The distinction the arm draws is sample-vs-enumerate, NOT read-vs-mutate. These are the
    // cases the read-only exclusion exists to protect, and they must stay silent.
    expect(scanCommand("git log | head -20").matched).toBe(false);
    expect(scanCommand("cat file | head").matched).toBe(false);
  });

  test("a bare -h is NOT a help flag — it is widely human-readable", () => {
    // `ls -h`, `du -h`, `sort -h` all mean human-readable, so keying on `-h` would fire on
    // exactly the samples above. This is why the arm requires the long form.
    expect(scanCommand("ls -lh | head -20").matched).toBe(false);
    expect(scanCommand("du -h /tmp | head").matched).toBe(false);
  });

  test("a targeted read of the listing is the remedy, not the defect", () => {
    expect(scanCommand("minsky mcp --help | grep proxy").matched).toBe(false);
    expect(scanCommand("minsky mcp --help | grep -c shim").matched).toBe(false);
  });

  test("--help with no pipeline at all", () => {
    expect(scanCommand("minsky mcp --help").matched).toBe(false);
  });

  test("--help must be its own token, not a substring", () => {
    expect(scanCommand("minsky run --help-text-only | head -5").matched).toBe(false);
  });

  test("the outcome arm is unchanged by the addition", () => {
    const commit = scanCommand("minsky session commit --task mt#1 'm' | tail -6");
    expect(commit.matched).toBe(true);
    expect(commit.kind).toBe("outcome");
    expect(scanCommand("git push | tail -3").kind).toBe("outcome");
  });

  test("outcome wins when a command could match both arms", () => {
    // Not a real invocation, but the precedence is asserted rather than left to branch order:
    // discarded confirmation fields are the costlier of the two warnings.
    expect(scanCommand("minsky session commit --help | tail -6").kind).toBe("outcome");
  });
});
