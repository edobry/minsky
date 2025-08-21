import { describe, it, expect } from "bun:test";
import { filterTasksByStatus } from "./task-filters";
import { TASK_STATUS } from "./taskConstants";

interface TestTask {
  id: string;
  status?: string;
}

const tasks: TestTask[] = [
  { id: "#1", status: TASK_STATUS.TODO },
  { id: "#2", status: TASK_STATUS.IN_PROGRESS },
  { id: "#3", status: TASK_STATUS.IN_REVIEW },
  { id: "#4", status: TASK_STATUS.DONE },
  { id: "#5", status: TASK_STATUS.CLOSED },
  { id: "#6", status: TASK_STATUS.BLOCKED },
];

describe("task-filters: filterTasksByStatus", () => {
  it("hides DONE and CLOSED by default", () => {
    const result = filterTasksByStatus(tasks);
    expect(result.map((t) => t.id)).toEqual(["#1", "#2", "#3", "#6"]);
  });

  it("includes all when all=true", () => {
    const result = filterTasksByStatus(tasks, { all: true });
    expect(result.map((t) => t.id)).toEqual(["#1", "#2", "#3", "#4", "#5", "#6"]);
  });

  it("filters by explicit status when provided (TODO)", () => {
    const result = filterTasksByStatus(tasks, { status: TASK_STATUS.TODO });
    expect(result.map((t) => t.id)).toEqual(["#1"]);
  });

  it("filters by explicit status when provided (DONE)", () => {
    const result = filterTasksByStatus(tasks, { status: TASK_STATUS.DONE });
    expect(result.map((t) => t.id)).toEqual(["#4"]);
  });

  it("returns empty when status does not match any task", () => {
    const result = filterTasksByStatus(tasks, { status: "NON-EXISTENT" });
    expect(result).toEqual([]);
  });
});
