import { describe, expect, test, spyOn } from "bun:test";
import fs from "fs";
import path from "path";
import { 
  ProjectContext, 
  validateRepositoryPath, 
  createProjectContext,
  createProjectContextFromCwd 
} from "./project.js";

describe("ProjectContext", () => {
  describe("validateRepositoryPath", () => {
    test("returns true for existing directory", () => {
      // Spy on fs.existsSync and fs.statSync
      const existsSyncSpy = spyOn(fs, "existsSync").mockReturnValue(true);
      const statSyncSpy = spyOn(fs, "statSync").mockReturnValue({
        isDirectory: () => true
      } as fs.Stats);

      const result = validateRepositoryPath("/valid/directory");
      
      expect(result).toBe(true);
      expect(existsSyncSpy).toHaveBeenCalledWith("/valid/directory");
      expect(statSyncSpy).toHaveBeenCalledWith("/valid/directory");
      
      // Restore the spies
      existsSyncSpy.mockRestore();
      statSyncSpy.mockRestore();
    });

    test("returns false for non-existent path", () => {
      // Spy on fs.existsSync
      const existsSyncSpy = spyOn(fs, "existsSync").mockReturnValue(false);
      
      const result = validateRepositoryPath("/non/existent/path");
      
      expect(result).toBe(false);
      expect(existsSyncSpy).toHaveBeenCalledWith("/non/existent/path");
      
      // Restore the spy
      existsSyncSpy.mockRestore();
    });

    test("returns false for file path (not a directory)", () => {
      // Spy on fs.existsSync and fs.statSync
      const existsSyncSpy = spyOn(fs, "existsSync").mockReturnValue(true);
      const statSyncSpy = spyOn(fs, "statSync").mockReturnValue({
        isDirectory: () => false
      } as fs.Stats);
      
      const result = validateRepositoryPath("/path/to/file.txt");
      
      expect(result).toBe(false);
      expect(existsSyncSpy).toHaveBeenCalledWith("/path/to/file.txt");
      expect(statSyncSpy).toHaveBeenCalledWith("/path/to/file.txt");
      
      // Restore the spies
      existsSyncSpy.mockRestore();
      statSyncSpy.mockRestore();
    });

    test("returns false when fs operation throws an error", () => {
      // Spy on fs.existsSync to throw an error
      const existsSyncSpy = spyOn(fs, "existsSync").mockImplementation(() => {
        throw new Error("Mock file system error");
      });
      
      const result = validateRepositoryPath("/error/path");
      
      expect(result).toBe(false);
      expect(existsSyncSpy).toHaveBeenCalledWith("/error/path");
      
      // Restore the spy
      existsSyncSpy.mockRestore();
    });
  });

  describe("createProjectContext", () => {
    test("creates a valid ProjectContext from a valid path", () => {
      // Spy on path.resolve and validateRepositoryPath
      const resolveSpy = spyOn(path, "resolve").mockReturnValue("/resolved/path");
      const validateSpy = spyOn(global, "validateRepositoryPath").mockReturnValue(true);
      
      const context = createProjectContext("/some/path");
      
      expect(context).toEqual({ repositoryPath: "/resolved/path" });
      expect(resolveSpy).toHaveBeenCalledWith("/some/path");
      expect(validateSpy).toHaveBeenCalledWith("/resolved/path");
      
      // Restore the spies
      resolveSpy.mockRestore();
      validateSpy.mockRestore();
    });

    test("throws an error for invalid repository path", () => {
      // Spy on path.resolve and validateRepositoryPath
      const resolveSpy = spyOn(path, "resolve").mockReturnValue("/invalid/path");
      const validateSpy = spyOn(global, "validateRepositoryPath").mockReturnValue(false);
      
      expect(() => createProjectContext("/invalid/path")).toThrow("Invalid repository path: /invalid/path");
      
      expect(resolveSpy).toHaveBeenCalledWith("/invalid/path");
      expect(validateSpy).toHaveBeenCalledWith("/invalid/path");
      
      // Restore the spies
      resolveSpy.mockRestore();
      validateSpy.mockRestore();
    });
  });

  describe("createProjectContextFromCwd", () => {
    test("creates a ProjectContext from the current working directory", () => {
      // Spy on process.cwd and createProjectContext
      const cwdSpy = spyOn(process, "cwd").mockReturnValue("/current/dir");
      const createContextSpy = spyOn(global, "createProjectContext").mockReturnValue({
        repositoryPath: "/current/dir"
      });
      
      const context = createProjectContextFromCwd();
      
      expect(context).toEqual({ repositoryPath: "/current/dir" });
      expect(cwdSpy).toHaveBeenCalled();
      expect(createContextSpy).toHaveBeenCalledWith("/current/dir");
      
      // Restore the spies
      cwdSpy.mockRestore();
      createContextSpy.mockRestore();
    });
  });
}); 
