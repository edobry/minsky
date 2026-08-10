import { describe, expect, test } from "bun:test";

import {
  classifyVectorProbe,
  describeProbeRows,
  VectorCapabilityProbeInconclusiveError,
} from "./vector-capability-probe";

describe("classifyVectorProbe", () => {
  test("reads the two answers the catalog can actually give", () => {
    expect(classifyVectorProbe([{ exists: true }])).toBe("present");
    expect(classifyVectorProbe([{ exists: false }])).toBe("absent");
  });

  /**
   * The negative control for mt#3833: every input below is what the OLD
   * `result[0]?.exists ?? false` silently reported as "absent", producing a
   * successfully-constructed provider with no vector support and no signal.
   */
  test.each([
    ["zero rows", []],
    ["a row with no exists column", [{}]],
    ["a row whose exists is null", [{ exists: null }]],
    ["a row whose exists is the string 'f'", [{ exists: "f" }]],
    ["a row whose exists is 0", [{ exists: 0 }]],
    ["a non-array result", undefined],
    ["a null result", null],
    ["an array whose first element is not an object", [42]],
  ])("treats %s as inconclusive, not absent", (_label, rows) => {
    expect(classifyVectorProbe(rows)).toBe("inconclusive");
  });

  test("a genuine absence stays absent — the fix must not turn 'no pgvector' into a fault", () => {
    // A Postgres without the extension answers exactly this. If this drifted to
    // "inconclusive" the change would convert every such database into a boot
    // failure, which is the opposite of the intent.
    expect(classifyVectorProbe([{ exists: false }])).toBe("absent");
  });

  test("only the FIRST row is consulted, matching the query's single-row contract", () => {
    expect(classifyVectorProbe([{ exists: true }, { exists: false }])).toBe("present");
  });
});

describe("describeProbeRows", () => {
  test("names the shape without disclosing row contents", () => {
    expect(describeProbeRows([])).toBe("zero rows");
    expect(describeProbeRows([{}])).toBe("1 row(s) with no 'exists' column");
    expect(describeProbeRows([{ exists: "f" }])).toBe(
      "1 row(s) whose 'exists' is string, not boolean"
    );
    expect(describeProbeRows(undefined)).toBe("a non-array result (undefined)");
  });

  test("does not echo a value from the row into the description", () => {
    const description = describeProbeRows([{ exists: "super-secret-looking-value" }]);
    expect(description).not.toContain("super-secret-looking-value");
  });
});

describe("VectorCapabilityProbeInconclusiveError", () => {
  test("blames the probe, not the database", () => {
    const error = new VectorCapabilityProbeInconclusiveError("zero rows");
    expect(error.message).toContain("probe was inconclusive");
    expect(error.message).toContain("zero rows");
    // The message callers saw for a day read as a fact about the database.
    expect(error.message).not.toContain("does not support vector storage");
  });

  test("is a real Error subclass so the container's catch paths see it normally", () => {
    const error = new VectorCapabilityProbeInconclusiveError("zero rows");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("VectorCapabilityProbeInconclusiveError");
  });
});
