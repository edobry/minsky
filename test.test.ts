import { mock } from "bun:test";

const mockLog = {
  info: mock(() => {}),
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  cli: mock(() => {})
};
      