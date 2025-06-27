const DEFAULT_HTTP_PORT = 8080;
const DEFAULT_DISPLAY_LENGTH = 100;
const TEST_ARRAY_SIZE = 3;
const TEST_VALUE = 8081;

// Domain-specific constants to replace magic numbers
export const DOMAIN_CONSTANTS = {
  // Network and HTTP
  DEFAULT_DEV_PORT: DEFAULT_HTTP_PORT,
  HTTP_OK: 200,
  STANDARD_HTTPS_PORT: 80,

  // System configuration
  DEFAULT_RETRY_COUNT: TEST_ARRAY_SIZE,
  BYTES_PER_KB: 1024,

  // Timeouts and intervals (milliseconds)
  DEFAULT_TIMEOUT_MS: 30000,
  MINUTE_IN_SECONDS: 60,

  // Test configuration
  TEST_PORT: TEST_VALUE,
  SMALL_DELAY_MS: DEFAULT_DISPLAY_LENGTH,
} as const;

// Re-export individual constants for easier imports
export const {
  DEFAULT_DEV_PORT,
  HTTP_OK,
  STANDARD_HTTPS_PORT,
  BYTES_PER_KB,
  DEFAULT_TIMEOUT_MS,
  MINUTE_IN_SECONDS,
  TEST_PORT,
  SMALL_DELAY_MS,
} = DOMAIN_CONSTANTS;
