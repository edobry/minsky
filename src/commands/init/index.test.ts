import { describe, test, expect } from "bun:test";
import { createInitCommand } from "./index.js";

describe("createInitCommand", () => {
  test("should create a command object", () => {
    const command = createInitCommand();
    expect(command).toBeDefined();
    expect(typeof command.parseAsync).toBe("function");
  });
});
