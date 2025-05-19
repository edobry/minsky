/**
 * Mock implementation of winston for tests
 */

const format = {
  combine: jest.fn(() => ({})),
  timestamp: jest.fn(() => ({})),
  errors: jest.fn(() => ({})),
  json: jest.fn(() => ({})),
  colorize: jest.fn(() => ({})),
  printf: jest.fn(() => ({}))
};

const transports = {
  Console: jest.fn(function() {
    return {};
  }),
  File: jest.fn(function() {
    return {};
  })
};

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
};

const createLogger = jest.fn(() => mockLogger);

module.exports = {
  format,
  transports,
  createLogger
}; 
