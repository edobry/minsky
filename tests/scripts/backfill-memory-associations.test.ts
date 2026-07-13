/**
 * Tests for the memory association backfill extraction logic (mt#2071).
 *
 * Tests the pure extraction and merge functions without requiring a DB connection.
 * The script itself is tested via dry-run; these tests cover the regex patterns.
 */

import { describe, it, expect } from "bun:test";

// Re-implement the extraction functions inline for testing (the script uses
// top-level await and dynamic imports that make direct import impractical).

function extractAssociations(content: string, tags: string[]): Record<string, string[]> {
  const tracksTask = new Set<string>();
  const relatedTask = new Set<string>();

  const trackingPattern = /[Tt]racking\s+task:\s*mt#(\d+)/g;
  for (const match of content.matchAll(trackingPattern)) {
    tracksTask.add(`mt#${match[1]}`);
  }

  const budgetPattern = /Budget:.*?tracking\s+task:\s*mt#(\d+)/gi;
  for (const match of content.matchAll(budgetPattern)) {
    tracksTask.add(`mt#${match[1]}`);
  }

  const isBridge = tags.some(
    (t) => t === "bridge" || t.includes("bridge-memory") || t.includes("bridge_memory")
  );
  if (isBridge) {
    const taskRefPattern = /mt#(\d+)/g;
    for (const match of content.matchAll(taskRefPattern)) {
      tracksTask.add(`mt#${match[1]}`);
    }
  }

  const seePattern = /[Ss]ee\s+mt#(\d+)/g;
  for (const match of content.matchAll(seePattern)) {
    const taskId = `mt#${match[1]}`;
    if (!tracksTask.has(taskId)) {
      relatedTask.add(taskId);
    }
  }

  const generalPattern = /\bmt#(\d+)\b/g;
  for (const match of content.matchAll(generalPattern)) {
    const taskId = `mt#${match[1]}`;
    if (!tracksTask.has(taskId) && !relatedTask.has(taskId)) {
      relatedTask.add(taskId);
    }
  }

  const result: Record<string, string[]> = {};
  if (tracksTask.size > 0) result.tracksTask = [...tracksTask].sort();
  if (relatedTask.size > 0) result.relatedTask = [...relatedTask].sort();
  return result;
}

function mergeAssociations(
  existing: Record<string, string[]>,
  extracted: Record<string, string[]>
): Record<string, string[]> {
  const merged = { ...existing };
  for (const [key, values] of Object.entries(extracted)) {
    const current = new Set(merged[key] ?? []);
    for (const v of values) current.add(v);
    merged[key] = [...current].sort();
  }
  return merged;
}

describe("backfill-memory-associations", () => {
  describe("extractAssociations", () => {
    it("extracts 'Tracking task: mt#XXXX' pattern", () => {
      const content = "Some content.\n\nTracking task: mt#2053. Budget expires in 5 days.";
      const result = extractAssociations(content, []);
      expect(result.tracksTask).toEqual(["mt#2053"]);
    });

    it("extracts lowercase 'tracking task: mt#XXXX'", () => {
      const content = "Budget: retire when mt#1034 ships; tracking task: mt#1588.";
      const result = extractAssociations(content, []);
      expect(result.tracksTask).toEqual(["mt#1588"]);
    });

    it("extracts 'Budget: ... tracking task:' pattern", () => {
      const content = "**Budget:** retire when >=3 in 14d; tracking task: mt#1503.";
      const result = extractAssociations(content, []);
      expect(result.tracksTask).toEqual(["mt#1503"]);
    });

    it("bridge-tagged memory captures all mt# refs as tracksTask", () => {
      const content = "Bridge until mt#1034 ships. See also mt#1035.";
      const result = extractAssociations(content, ["bridge"]);
      expect(result.tracksTask).toEqual(["mt#1034", "mt#1035"]);
      expect(result.relatedTask).toBeUndefined();
    });

    it("bridge-memory tag variant also triggers", () => {
      const content = "This bridges mt#500.";
      const result = extractAssociations(content, ["bridge-memory", "other-tag"]);
      expect(result.tracksTask).toEqual(["mt#500"]);
    });

    it("'See mt#XXXX' becomes relatedTask when not tracked", () => {
      const content = "Tracking task: mt#100.\n\nSee mt#200 for context.";
      const result = extractAssociations(content, []);
      expect(result.tracksTask).toEqual(["mt#100"]);
      expect(result.relatedTask).toEqual(["mt#200"]);
    });

    it("general mt# refs become relatedTask", () => {
      const content = "Originated from mt#1551. Related to mt#1086 and mt#1610.";
      const result = extractAssociations(content, []);
      expect(result.relatedTask).toEqual(["mt#1086", "mt#1551", "mt#1610"]);
    });

    it("does not duplicate: tracked task is not also related", () => {
      const content = "Tracking task: mt#999. See mt#999 for details.";
      const result = extractAssociations(content, []);
      expect(result.tracksTask).toEqual(["mt#999"]);
      expect(result.relatedTask).toBeUndefined();
    });

    it("returns empty object when no patterns match", () => {
      const content = "This memory has no task references at all.";
      const result = extractAssociations(content, []);
      expect(result).toEqual({});
    });

    it("handles multiple tracking tasks", () => {
      const content = "Tracking task: mt#100.\nAlso tracking task: mt#200.";
      const result = extractAssociations(content, []);
      expect(result.tracksTask).toEqual(["mt#100", "mt#200"]);
    });
  });

  describe("mergeAssociations", () => {
    it("adds new keys without affecting existing", () => {
      const existing = { tracksTask: ["mt#100"] };
      const extracted = { relatedTask: ["mt#200"] };
      const result = mergeAssociations(existing, extracted);
      expect(result).toEqual({
        tracksTask: ["mt#100"],
        relatedTask: ["mt#200"],
      });
    });

    it("merges values for existing keys (union)", () => {
      const existing = { tracksTask: ["mt#100"] };
      const extracted = { tracksTask: ["mt#200"] };
      const result = mergeAssociations(existing, extracted);
      expect(result.tracksTask).toEqual(["mt#100", "mt#200"]);
    });

    it("does not duplicate existing values", () => {
      const existing = { tracksTask: ["mt#100"] };
      const extracted = { tracksTask: ["mt#100"] };
      const result = mergeAssociations(existing, extracted);
      expect(result.tracksTask).toEqual(["mt#100"]);
    });

    it("preserves manually-set associations", () => {
      const existing = { originatesRule: ["hook-files.mdc"] };
      const extracted = { tracksTask: ["mt#999"] };
      const result = mergeAssociations(existing, extracted);
      expect(result).toEqual({
        originatesRule: ["hook-files.mdc"],
        tracksTask: ["mt#999"],
      });
    });

    it("returns existing unchanged when extracted is empty", () => {
      const existing = { tracksTask: ["mt#100"] };
      const result = mergeAssociations(existing, {});
      expect(result).toEqual({ tracksTask: ["mt#100"] });
    });
  });
});
