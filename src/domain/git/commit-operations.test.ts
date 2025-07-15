import { describe, test, expect } from "bun:test";
import { commitChangesFromParams } from "../git";

describe("commitChangesFromParams", () => {
  test("should be defined", () => {
    expect(commitChangesFromParams).toBeDefined();
  });

  test("should be a function", () => {
    expect(typeof commitChangesFromParams).toBe("function");
  });
}); 
