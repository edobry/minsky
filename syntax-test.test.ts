import { test, describe, mock } from "bun:test";

const mockLog = {
  info: mock((message: string) => {}),
  error: mock((message: string) => {}),
  cli: mock((message: string) => {}),
};

describe("Session Approve", () => {
  test("should approve", () => {
    mockLog.info("test");
  });
});
