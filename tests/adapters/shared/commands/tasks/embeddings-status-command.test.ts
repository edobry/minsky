import { describe, it, expect } from "bun:test";
import { TasksEmbeddingsStatusCommand } from "../../../../../src/adapters/shared/commands/tasks/embeddings-status-command";
import { TasksEmbeddingsRepairCommand } from "../../../../../src/adapters/shared/commands/tasks/embeddings-repair-command";

describe("TasksEmbeddingsStatusCommand", () => {
  it("has correct id and name", () => {
    const cmd = new TasksEmbeddingsStatusCommand();
    expect(cmd.id).toBe("tasks.embeddings-status");
    expect(cmd.name).toBe("embeddings-status");
  });

  it("has a description", () => {
    const cmd = new TasksEmbeddingsStatusCommand();
    expect(cmd.description).toBeTruthy();
  });

  it("has parameters defined", () => {
    const cmd = new TasksEmbeddingsStatusCommand();
    expect(cmd.parameters).toBeDefined();
    expect(typeof cmd.parameters).toBe("object");
  });
});

describe("TasksEmbeddingsRepairCommand", () => {
  it("has correct id and name", () => {
    const cmd = new TasksEmbeddingsRepairCommand();
    expect(cmd.id).toBe("tasks.embeddings-repair");
    expect(cmd.name).toBe("embeddings-repair");
  });

  it("has a description", () => {
    const cmd = new TasksEmbeddingsRepairCommand();
    expect(cmd.description).toBeTruthy();
  });

  it("has dryRun parameter defined", () => {
    const cmd = new TasksEmbeddingsRepairCommand();
    expect(cmd.parameters).toBeDefined();
    expect(cmd.parameters.dryRun).toBeDefined();
  });
});
