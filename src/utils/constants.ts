// Domain-specific constants to replace magic numbers
export const DOMAIN_CONSTANTS = {
  // Network and HTTP
  DEFAULT_DEV_PORT: 8080,
  HTTP_OK: 200,
  STANDARD_HTTPS_PORT: 80,
  
  // System configuration
  DEFAULT_RETRY_COUNT: 5,
  BYTES_PER_KB: 1024,
  
  // Timeouts and intervals (milliseconds)
  DEFAULT_TIMEOUT_MS: 30000,
  MINUTE_IN_SECONDS: 60,
  
  // Test configuration
  TEST_PORT: 123,
  SMALL_DELAY_MS: 20,
} as const;

// Re-export individual constants for easier imports
export const {
  DEFAULT_DEV_PORT,
  HTTP_OK,
  STANDARD_HTTPS_PORT,
  DEFAULT_RETRY_COUNT,
  BYTES_PER_KB,
  DEFAULT_TIMEOUT_MS,
  MINUTE_IN_SECONDS,
  TEST_PORT,
  SMALL_DELAY_MS,
} = DOMAIN_CONSTANTS; 
