/**
 * Mock implementation of winston for tests
 */
const { mock } = require("bun:test");

const format = {
  combine: mock(() => ({})),
  timestamp: mock(() => ({})),
  errors: mock(() => ({})),
  json: mock(() => ({})),
  colorize: mock(() => ({})),
  printf: mock(() => ({})),
};

const transports = {
  Console: mock(function () {
    return {};
  }),
  File: mock(function () {
    return {};
  }),
};

const mockLogger = {
  info: mock(),
  error: mock(),
  debug: mock(),
  warn: mock(),
};

const createLogger = mock(() => mockLogger);

module.exports = {
  format,
  transports,
  createLogger,
};
