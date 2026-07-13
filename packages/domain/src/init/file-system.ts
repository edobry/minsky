import * as path from "path";
import type { FsLike } from "../interfaces/fs-like";
import { createRealFs } from "../interfaces/real-fs";

/**
 * Creates a directory and all parent directories if they don't exist
 */
export async function createDirectoryIfNotExists(
  dirPath: string,
  fileSystem: FsLike = createRealFs()
): Promise<void> {
  if (!(await fileSystem.exists(dirPath))) {
    await fileSystem.mkdir(dirPath, { recursive: true });
  }
}

/**
 * Creates a file if it doesn't exist, throws an error if it does unless overwrite is true
 */
export async function createFileIfNotExists(
  filePath: string,
  content: string,
  overwrite = false,
  fileSystem: FsLike = createRealFs()
): Promise<void> {
  if (await fileSystem.exists(filePath)) {
    if (!overwrite) {
      throw new Error(`File already exists: ${filePath}`);
    }
    // If overwrite is true, we'll proceed and overwrite the existing file
  }

  // Ensure the directory exists
  const dirPath = path.dirname(filePath);
  await createDirectoryIfNotExists(dirPath, fileSystem);

  // Write the file
  await fileSystem.writeFile(filePath, content);
}
