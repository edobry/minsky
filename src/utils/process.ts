/**
 * A utility function that abstracts process exit functionality
 * This allows us to use a consistent interface while following
 * the platform-specific recommendations for exiting
 */
export function exit(_code: number): never {
  // For now, we use process.exit as it's consistently used across the codebase
  // In the future, we could adapt this to use Bun-specific APIs if needed
   
  process.exit(code);
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
