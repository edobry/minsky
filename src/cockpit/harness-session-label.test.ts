/**
 * Tests for the harness session-label writer (mt#4621).
 *
 * The label file is a CROSS-PROCESS contract: this module writes it, and
 * `.minsky/hooks/auto-session-title.ts` — a standalone bun script the cockpit
 * deliberately does not import — reads it. Nothing at compile time makes the
 * two agree on the path, so the last describe block asserts it directly
 * against the hook's source. That is the test that would actually catch a
 * regression; the rest pin the label-rendering decisions.
 *
 * @see ./harness-session-label.ts
 */

/* eslint-disable custom/no-real-fs-in-tests -- the last describe block asserts a CROSS-PROCESS contract against `.minsky/hooks/auto-session-title.ts`, a standalone bun script the cockpit deliberately does not import. The real file IS the artifact under test: injecting a fake fs would assert that this module agrees with a string the test itself supplied, which is exactly the drift it exists to catch. Reads only, from a committed path — none of the mutable-state or fixed-mock-path races the rule guards against apply. The module's own WRITE seam is injected and touches nothing. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  HARNESS_SESSION_LABEL_PREFIX,
  buildHarnessSessionLabel,
  harnessSessionLabelPath,
  writeHarnessSessionLabel,
} from "./harness-session-label";

const CONVERSATION = "3a61b3a8-67a2-4536-8461-741a6c7f1b15";

/** Recorder standing in for the filesystem — the module's injected IO seam. */
function recorder(): {
  writes: Array<{ path: string; contents: string }>;
  writeFile: (path: string, contents: string) => void;
} {
  const writes: Array<{ path: string; contents: string }> = [];
  return { writes, writeFile: (path, contents) => writes.push({ path, contents }) };
}

describe("harnessSessionLabelPath", () => {
  test("keys the file on the conversation id, under the prefix the guard reads", () => {
    expect(harnessSessionLabelPath(CONVERSATION)).toBe(
      `/tmp/claude-session-label-${CONVERSATION}.json`
    );
  });
});

describe("buildHarnessSessionLabel", () => {
  test("renders ref and title as separate fields, which the guard joins", () => {
    expect(
      buildHarnessSessionLabel({
        harnessSessionId: CONVERSATION,
        ref: "ask#9257",
        title: "Should we adopt X?",
      })
    ).toEqual({
      taskId: "ask#9257",
      title: "Should we adopt X?",
    });
  });

  test("collapses the duplicate when the entity has no title of its own", () => {
    // `askToEntitySeed` falls back to the short id for `title`, so ref and
    // title arrive equal — the naive join would read `ask#9257 — ask#9257`.
    expect(
      buildHarnessSessionLabel({
        harnessSessionId: CONVERSATION,
        ref: "ask#9257",
        title: "ask#9257",
      })
    ).toEqual({
      taskId: "ask#9257",
      title: "ask#9257",
    });
  });

  test("collapses an empty or whitespace-only title the same way", () => {
    expect(
      buildHarnessSessionLabel({ harnessSessionId: CONVERSATION, ref: "mt#4621", title: "   " })
    ).toEqual({
      taskId: "mt#4621",
      title: "mt#4621",
    });
  });

  test("trims both sides so a padded seed value cannot render padded", () => {
    expect(
      buildHarnessSessionLabel({ harnessSessionId: CONVERSATION, ref: " ask#1 ", title: " Title " })
    ).toEqual({
      taskId: "ask#1",
      title: "Title",
    });
  });
});

describe("writeHarnessSessionLabel", () => {
  test("writes the guard-readable payload at the guard-readable path", () => {
    const io = recorder();
    const wrote = writeHarnessSessionLabel(
      { harnessSessionId: CONVERSATION, ref: "ask#9257", title: "Should we adopt X?" },
      { writeFile: io.writeFile }
    );

    expect(wrote).toBe(true);
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0]?.path).toBe(`/tmp/claude-session-label-${CONVERSATION}.json`);
    expect(JSON.parse(io.writes[0]?.contents ?? "{}")).toEqual({
      taskId: "ask#9257",
      title: "Should we adopt X?",
    });
  });

  test("refuses an empty conversation id rather than writing a file nothing can consume", () => {
    // The guard keys on `input.session_id`; a file at `...label-.json` is
    // unreachable by construction and would linger in /tmp forever.
    const io = recorder();
    expect(
      writeHarnessSessionLabel(
        { harnessSessionId: "  ", ref: "ask#1", title: "T" },
        { writeFile: io.writeFile }
      )
    ).toBe(false);
    expect(io.writes).toHaveLength(0);
  });

  test("swallows a write failure — an untitled thread must not fail the spawn", () => {
    // This runs inside the host's stdout `init` frame; an escaping throw there
    // becomes an unhandled rejection on a detached promise for every spawn.
    const boom = () => {
      throw new Error("EACCES");
    };
    expect(
      writeHarnessSessionLabel(
        { harnessSessionId: CONVERSATION, ref: "ask#1", title: "T" },
        { writeFile: boom }
      )
    ).toBe(false);
  });
});

describe("cross-process path agreement with auto-session-title.ts", () => {
  test("the consuming guard reads the prefix this module writes", () => {
    // The real coupling test. Two processes, no shared import, one string.
    const guard = readFileSync(
      join(import.meta.dir, "..", "..", ".minsky", "hooks", "auto-session-title.ts"),
      "utf8"
    );
    expect(guard).toContain(HARNESS_SESSION_LABEL_PREFIX);
  });

  test("the guard still renders the two fields this module emits", () => {
    // If the guard stops joining `taskId` and `title`, this module's payload
    // shape is silently wrong and every thread renders a broken label.
    const guard = readFileSync(
      join(import.meta.dir, "..", "..", ".minsky", "hooks", "auto-session-title.ts"),
      "utf8"
    );
    expect(guard).toContain("${taskId} — ${title}");
  });
});
