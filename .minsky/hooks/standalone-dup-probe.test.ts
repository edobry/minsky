// Tests for the pure, dependency-free surface of standalone-dup-probe.ts
// (mt#3072): `classifyCause`'s infra/logic heuristic. The rest of the module
// (`fetchSimilarActiveTasksInProcess` / `runProbe`) requires a live DB +
// embedding backend and is exercised via `decideStandaloneDuplicateGuard`'s
// injected-`fetchSimilar` tests in parallel-work-guard-standalone-dedup.test.ts
// instead — this file covers only the classifier itself.

import { describe, expect, it } from "bun:test";
import { classifyCause } from "./standalone-dup-probe";

describe("classifyCause (mt#3072 SC2)", () => {
  it("classifies TypeError as logic (the runtime signature of a code defect)", () => {
    expect(classifyCause(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(
      "logic"
    );
  });

  it("classifies ReferenceError as logic", () => {
    expect(classifyCause(new ReferenceError("x is not defined"))).toBe("logic");
  });

  it("classifies a generic Error as infra (most likely an external-dependency condition)", () => {
    expect(classifyCause(new Error("write CONNECT_TIMEOUT 192.0.2.1:5432"))).toBe("infra");
  });

  it("classifies a non-Error thrown value as infra", () => {
    expect(classifyCause("some string thrown as an error")).toBe("infra");
    expect(classifyCause(undefined)).toBe("infra");
    expect(classifyCause(null)).toBe("infra");
  });
});
