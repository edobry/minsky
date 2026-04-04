import * as fsPromises from "fs/promises";
import type { FsLike } from "./fs-like";

/**
 * Real filesystem implementation of FsLike using Node's fs/promises module.
 * Use this in production code; inject createMockFs() in tests.
 */
export function createRealFs(): FsLike {
  return {
    readFile: (path, encoding) => fsPromises.readFile(path, { encoding }) as Promise<string>,
    writeFile: (path, data) => fsPromises.writeFile(path, data),
    mkdir: (path, options) =>
      fsPromises.mkdir(path, options).then((result) => result ?? undefined) as Promise<
        string | undefined
      >,
    readdir: (path) => fsPromises.readdir(path),
    stat: (path) => fsPromises.stat(path),
    access: (path) => fsPromises.access(path),
    unlink: (path) => fsPromises.unlink(path),
    rm: (path, options) => fsPromises.rm(path, options),
  };
}
