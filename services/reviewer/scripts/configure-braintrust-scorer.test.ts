/**
 * Tests for the human-review scorer payload (mt#2746).
 */

import { describe, expect, test } from "bun:test";

import { buildScorePayload, SCORE_CATEGORIES } from "./configure-braintrust-scorer";

describe("SCORE_CATEGORIES", () => {
  test("carries exactly the 4 labels the scorer maps to", () => {
    expect(SCORE_CATEGORIES.map((c) => c.name).sort()).toEqual([
      "cant_tell",
      "false_positive",
      "valid_blocking",
      "valid_nonblocking",
    ]);
  });

  test("assigns DISTINCT values so a stored number maps back to one name", () => {
    // Braintrust requires a unique 0-1 value per option and offers no
    // string-valued categorical score. Distinctness is what makes the
    // number->name recovery bijective; a collision would silently merge two
    // labels into one category at scoring time.
    const values = SCORE_CATEGORIES.map((c) => c.value);
    expect(new Set(values).size).toBe(values.length);
  });

  test("keeps every value inside the 0-1 range the API requires", () => {
    for (const { value } of SCORE_CATEGORIES) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe("buildScorePayload", () => {
  test("requests a single-select categorical score written to `expected`", () => {
    const payload = buildScorePayload("proj-123");
    expect(payload.project_id).toBe("proj-123");
    expect(payload.score_type).toBe("categorical");
    expect(payload.config).toEqual({ multi_select: false, destination: "expected" });
  });

  test("sends all 4 categories with name and value", () => {
    const categories = buildScorePayload("p").categories as { name: string; value: number }[];
    expect(categories).toHaveLength(4);
    for (const c of categories) {
      expect(typeof c.name).toBe("string");
      expect(typeof c.value).toBe("number");
    }
  });
});
