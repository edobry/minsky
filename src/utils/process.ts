/**
 * A utility function that abstracts process exit functionality
 * This allows us to use a consistent interface while following
 * the platform-specific recommendations for exiting
 */
export function exit(code: number): never {
  // For now, we use process.exit as it's consistently used across the codebase
  // In the future, we could adapt this to use Bun-specific APIs if needed

  // Use process.exit directly — works in both Node.js and Bun environments
  process.exit(code);

  // This line should never be reached, but satisfies TypeScript's never return type
  throw new Error("Process exit failed");
}

/**
 * Alias for exit() — wraps (process as any).exit(code)
 */
export function processExit(code: number): never {
  return exit(code);
}

// Store the original process.cwd() function to allow resetting
let currentWorkingDirectoryImpl = () => {
  return process.cwd();
};

/**
 * A utility function that abstracts process.cwd() functionality
 * This allows for easier mocking and testing of directory-related functionality
 * @returns The current working directory
 */
export function getCurrentWorkingDirectory(): string {
  return currentWorkingDirectoryImpl();
}

/**
 * Alias for getCurrentWorkingDirectory() — wraps (process as any).cwd()
 * @returns The current working directory
 */
export function processCwd(): string {
  return getCurrentWorkingDirectory();
}

/**
 * A utility function that abstracts process.chdir() functionality
 * This allows for easier mocking and testing of directory-related functionality
 * @param directory The directory to change to
 */
export function processChdir(directory: string): void {
  // Access chdir via bracket notation — it exists at runtime in Node.js and Bun
  // but is not in the @types/node process interface for all environments.
  const chdir = (process as Record<string, unknown>)["chdir"] as (dir: string) => void;
  chdir(directory);
}

/**
 * For testing only: Override the implementation of getCurrentWorkingDirectory
 * @param mockImpl The mock implementation to use
 * @returns A function to restore the original implementation
 */
export function mockCurrentWorkingDirectory(mockImpl: () => string): () => void {
  const originalImpl = currentWorkingDirectoryImpl;
  currentWorkingDirectoryImpl = mockImpl;

  // Return a function to restore the original
  return () => {
    currentWorkingDirectoryImpl = originalImpl;
  };
}
