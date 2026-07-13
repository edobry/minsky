/**
 * Unit tests for the SSE channel → query-key mapping — mt#1148 Stage 2.
 *
 * Pure function tests: no mocks, no server, no browser globals needed.
 */
import { describe, it, expect } from "bun:test";
import { queryKeysForChannel, CHANNEL_TO_QUERY_KEYS } from "./sse-invalidation";

// ---------------------------------------------------------------------------
// Channel name constants (mirrors server-side COCKPIT_SSE_CHANNELS values)
// Extracted here to satisfy the no-magic-string-duplication lint rule.
// ---------------------------------------------------------------------------
const CH_ATTENTION_OPENED = "minsky.attention_window_opened";
const CH_ATTENTION_CLOSED = "minsky.attention_window_closed";
const CH_SESSION_STARTED = "minsky.session.started";
const CH_SESSION_SCOPE_CHANGED = "minsky.session.scope_changed";
const CH_TASK_STATUS_CHANGED = "minsky.task.status_changed";
const CH_TASK_BLOCKING = "minsky.task.blocking";
const CH_CREDENTIAL_INVALIDATED = "minsky.credential.invalidated";

describe("queryKeysForChannel", () => {
  describe("known channels with active producers (mt#1411)", () => {
    it("minsky.attention_window_opened → invalidates attention", () => {
      const keys = queryKeysForChannel(CH_ATTENTION_OPENED);
      expect(keys).toContainEqual(["attention"]);
    });

    it("minsky.attention_window_closed → invalidates attention", () => {
      const keys = queryKeysForChannel(CH_ATTENTION_CLOSED);
      expect(keys).toContainEqual(["attention"]);
    });
  });

  describe("known channels with pending producers (mt#1854)", () => {
    it("minsky.session.started → invalidates agents", () => {
      const keys = queryKeysForChannel(CH_SESSION_STARTED);
      expect(keys).toContainEqual(["agents"]);
    });

    it("minsky.session.scope_changed → invalidates agents", () => {
      const keys = queryKeysForChannel(CH_SESSION_SCOPE_CHANGED);
      expect(keys).toContainEqual(["agents"]);
    });

    it("minsky.task.blocking → invalidates attention", () => {
      const keys = queryKeysForChannel(CH_TASK_BLOCKING);
      expect(keys).toContainEqual(["attention"]);
    });

    it("minsky.task.status_changed → invalidates task-list (mt#2078)", () => {
      const keys = queryKeysForChannel(CH_TASK_STATUS_CHANGED);
      expect(keys).toContainEqual(["task-list"]);
    });

    it("minsky.credential.invalidated → invalidates credentials (mt#1426)", () => {
      const keys = queryKeysForChannel(CH_CREDENTIAL_INVALIDATED);
      expect(keys).toContainEqual(["credentials"]);
    });
  });

  describe("unknown channels", () => {
    it("returns empty array for completely unknown channel", () => {
      const keys = queryKeysForChannel("minsky.something.unknown");
      expect(Array.from(keys)).toHaveLength(0);
    });

    it("returns empty array for empty string", () => {
      const keys = queryKeysForChannel("");
      expect(Array.from(keys)).toHaveLength(0);
    });

    it("returns empty array for partial channel name match (no prefix matching)", () => {
      // Only exact channel names match — not patterns
      const keys = queryKeysForChannel("minsky.attention");
      expect(Array.from(keys)).toHaveLength(0);
    });
  });

  describe("CHANNEL_TO_QUERY_KEYS coverage", () => {
    it("all canonical channels are present in the map (6 ADR-010 + credential)", () => {
      const expectedChannels = [
        CH_ATTENTION_OPENED,
        CH_ATTENTION_CLOSED,
        CH_SESSION_STARTED,
        CH_SESSION_SCOPE_CHANGED,
        CH_TASK_STATUS_CHANGED,
        CH_TASK_BLOCKING,
        CH_CREDENTIAL_INVALIDATED,
      ];
      for (const channel of expectedChannels) {
        expect(channel in CHANNEL_TO_QUERY_KEYS).toBe(true);
      }
    });

    it("all entries in CHANNEL_TO_QUERY_KEYS are arrays", () => {
      for (const [channel, keys] of Object.entries(CHANNEL_TO_QUERY_KEYS)) {
        expect(Array.isArray(keys), `${channel} should map to an array`).toBe(true);
      }
    });

    it("each queryKey entry is an array of strings", () => {
      for (const [channel, keys] of Object.entries(CHANNEL_TO_QUERY_KEYS)) {
        for (const key of keys) {
          expect(Array.isArray(key), `${channel} key entries should be arrays`).toBe(true);
          for (const part of key) {
            expect(
              typeof part === "string" || typeof part === "number",
              `${channel} key parts should be strings or numbers`
            ).toBe(true);
          }
        }
      }
    });
  });

  describe("return value shape", () => {
    it("returns a readonly array (does not mutate the map value)", () => {
      const keys1 = queryKeysForChannel(CH_ATTENTION_OPENED);
      const keys2 = queryKeysForChannel(CH_ATTENTION_OPENED);
      // Both calls return the same reference (the map value is returned directly)
      expect(keys1).toBe(keys2);
    });
  });
});
