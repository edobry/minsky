/**
 * Tests for the topic-filter helper — mt#1853.
 */

import { describe, test, expect } from "bun:test";
import { matchesTopic } from "./topic-filter";

// ---------------------------------------------------------------------------
// Channel name constants (avoid magic string duplication)
// ---------------------------------------------------------------------------

const CH_ATTENTION_OPENED = "minsky.attention_window_opened";
const CH_ATTENTION_CLOSED = "minsky.attention_window_closed";
const CH_SESSION_CREATED = "minsky.session_created";

describe("matchesTopic", () => {
  describe("empty patterns list", () => {
    test("returns false when patterns is empty", () => {
      expect(matchesTopic(CH_ATTENTION_OPENED, [])).toBe(false);
    });
  });

  describe("wildcard *", () => {
    test("bare * matches any channel", () => {
      expect(matchesTopic(CH_ATTENTION_OPENED, ["*"])).toBe(true);
    });

    test("bare * matches a simple channel name", () => {
      expect(matchesTopic("anything", ["*"])).toBe(true);
    });
  });

  describe("exact match", () => {
    test("exact pattern matches the channel exactly", () => {
      expect(matchesTopic(CH_ATTENTION_OPENED, [CH_ATTENTION_OPENED])).toBe(true);
    });

    test("exact pattern does not match a different channel", () => {
      expect(matchesTopic(CH_ATTENTION_CLOSED, [CH_ATTENTION_OPENED])).toBe(false);
    });

    test("exact pattern does not match a channel with extra segments", () => {
      expect(matchesTopic(CH_SESSION_CREATED, ["minsky"])).toBe(false);
    });
  });

  describe("glob prefix matching — attention.*", () => {
    test("attention.* matches minsky.attention_window_opened", () => {
      expect(matchesTopic(CH_ATTENTION_OPENED, ["attention.*"])).toBe(true);
    });

    test("attention.* matches minsky.attention_window_closed", () => {
      expect(matchesTopic(CH_ATTENTION_CLOSED, ["attention.*"])).toBe(true);
    });

    test("attention.* does not match minsky.session_created", () => {
      expect(matchesTopic(CH_SESSION_CREATED, ["attention.*"])).toBe(false);
    });
  });

  describe("glob prefix matching — minsky.*", () => {
    test("minsky.* matches minsky.attention_window_opened (direct child)", () => {
      expect(matchesTopic(CH_ATTENTION_OPENED, ["minsky.*"])).toBe(true);
    });

    test("minsky.* matches minsky.session_created", () => {
      expect(matchesTopic(CH_SESSION_CREATED, ["minsky.*"])).toBe(true);
    });

    test("minsky.* does not match other.channel", () => {
      expect(matchesTopic("other.channel", ["minsky.*"])).toBe(false);
    });
  });

  describe("glob prefix — exact prefix equals channel", () => {
    test("prefix.* matches the bare prefix (no trailing segment)", () => {
      expect(matchesTopic("attention", ["attention.*"])).toBe(true);
    });
  });

  describe("multi-pattern OR semantics", () => {
    test("returns true if ANY pattern matches", () => {
      expect(matchesTopic(CH_ATTENTION_OPENED, ["session.*", "attention.*"])).toBe(true);
    });

    test("returns false if NO pattern matches", () => {
      expect(matchesTopic(CH_ATTENTION_OPENED, ["session.*", "task.*"])).toBe(false);
    });

    test("first pattern matches even if second doesn't", () => {
      expect(matchesTopic(CH_SESSION_CREATED, ["minsky.*", "attention.*"])).toBe(true);
    });

    test("second pattern matches even if first doesn't", () => {
      expect(matchesTopic(CH_ATTENTION_OPENED, ["session.*", "minsky.*"])).toBe(true);
    });
  });

  describe("mismatch scenarios", () => {
    test("returns false when no pattern matches anything", () => {
      expect(matchesTopic(CH_ATTENTION_OPENED, ["task.*", "session.*"])).toBe(false);
    });

    test("non-glob pattern does not match with extra suffix", () => {
      expect(matchesTopic(`${CH_ATTENTION_OPENED}.extra`, [CH_ATTENTION_OPENED])).toBe(false);
    });
  });
});
