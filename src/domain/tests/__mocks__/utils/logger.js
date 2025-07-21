/**
 * Mock implementation of the logger module for tests
 */
const { mock } = require("bun:test");

const log = {
  agent: mock(),
  debug: mock(),
  warn: mock(),
  error: mock(),
  cli: mock(),
  cliWarn: mock(),
  cliError: mock(),
  setLevel: mock(),
  cliDebug: mock(),
};

module.exports = { log };
