/**
 * A utility function that abstracts process exit functionality
 * This allows us to use a consistent interface while following
 * the platform-specific recommendations for exiting
 */
export function exit(code: number): never {
  // For now, we use process.exit as it's consistently used across the codebase
  // In the future, we could adapt this to use Bun-specific APIs if needed
  // eslint-disable-next-line no-restricted-globals
  process.exit(code);
}
