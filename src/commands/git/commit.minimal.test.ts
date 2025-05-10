import { describe, test, expect } from "bun:test";
import { createGitCommitCommand } from "./commit";

describe("git commit command", () => {
  test("command is properly created", () => {
    const command = createGitCommitCommand();
    expect(command).toBeDefined();
    expect(typeof command.parse).toBe("function");
  });
}); 
