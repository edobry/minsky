import * as fs from "fs";
import * as path from "path";

/**
 * Test utility for mocking file system operations
 */
export interface FileSystem {
  existsSync: (path: fs.PathLike) => boolean;
  mkdirSync: (path: fs.PathLike, options?: fs.MakeDirectoryOptions) => string | undefined;
  writeFileSync: (path: fs.PathLike, data: string) => void;
}

/**
 * Creates a directory and all parent directories if they don't exist
 */
export async function createDirectoryIfNotExists(
  dirPath: string,
  fileSystem: FileSystem = fs
): Promise<void> {
  if (!fileSystem.existsSync(dirPath)) {
    fileSystem.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Creates a file if it doesn't exist, throws an error if it does unless overwrite is true
 */
export async function createFileIfNotExists(
  filePath: string,
  content: string,
  overwrite = false,
  fileSystem: FileSystem = fs
): Promise<void> {
  if (fileSystem.existsSync(filePath)) {
    if (!overwrite) {
      throw new Error(`File already exists: ${filePath}`);
    }
    // If overwrite is true, we'll proceed and overwrite the existing file
  }

  // Ensure the directory exists
  const dirPath = path.dirname(filePath);
  await createDirectoryIfNotExists(dirPath, fileSystem);

  // Write the file
  fileSystem.writeFileSync(filePath, content);
}
