/**
 * Mock implementation of the logger module for tests
 */

const log = {
  agent: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  cli: jest.fn(),
  cliWarn: jest.fn(),
  cliError: jest.fn(),
  setLevel: jest.fn(),
  cliDebug: jest.fn(),
};

module.exports = { log };
