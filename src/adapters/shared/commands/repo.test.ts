/* eslint-disable custom/no-real-fs-in-tests -- test infrastructure: temp dirs for hermetic git grep tests */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { sharedCommandRegistry } from "../command-registry";
import { registerRepoCommands, setWorkspaceRootOverride } from "./repo";

const CMD_READ_FILE = "repo.read_file";
const CMD_SEARCH = "repo.search";
const CMD_LIST_DIR = "repo.list_directory";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "minsky-repo-test-"));
  await mkdir(join(tempDir, "subdir"));
  await writeFile(join(tempDir, "test-file.txt"), "line one\nline two\nline three\nline four\n");
  await writeFile(join(tempDir, "subdir", "nested.txt"), "nested content\n");

  const { execSync } = await import("child_process");
  execSync("git init", { cwd: tempDir, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: tempDir, stdio: "ignore" });
  execSync("git add -A", { cwd: tempDir, stdio: "ignore" });
  execSync('git commit -m "init" --no-gpg-sign', { cwd: tempDir, stdio: "ignore" });

  setWorkspaceRootOverride(tempDir);
  registerRepoCommands();
});

afterAll(async () => {
  setWorkspaceRootOverride(null);
  await rm(tempDir, { recursive: true, force: true });
});

function getCommand(id: string) {
  const cmd = sharedCommandRegistry.getCommand(id);
  if (!cmd) throw new Error(`Command ${id} not registered`);
  return cmd;
}

describe("repo.read_file", () => {
  test("reads a file by relative path", async () => {
    const cmd = getCommand(CMD_READ_FILE);
    const result = (await cmd.execute({ path: "test-file.txt" }, {} as any)) as any;
    expect(result.success).toBe(true);
    expect(result.content).toContain("line one");
    expect(result.totalLines).toBe(5);
  });

  test("reads with offset and limit", async () => {
    const cmd = getCommand(CMD_READ_FILE);
    const result = (await cmd.execute(
      { path: "test-file.txt", offset: 1, limit: 2 },
      {} as any
    )) as any;
    expect(result.success).toBe(true);
    expect(result.content).toBe("line two\nline three");
  });

  test("reads nested file", async () => {
    const cmd = getCommand(CMD_READ_FILE);
    const result = (await cmd.execute({ path: "subdir/nested.txt" }, {} as any)) as any;
    expect(result.success).toBe(true);
    expect(result.content).toContain("nested content");
  });

  test("returns error for nonexistent file", async () => {
    const cmd = getCommand(CMD_READ_FILE);
    const result = (await cmd.execute({ path: "nonexistent.txt" }, {} as any)) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe("repo.search", () => {
  test("finds a known pattern", async () => {
    const cmd = getCommand(CMD_SEARCH);
    const result = (await cmd.execute({ pattern: "line two" }, {} as any)) as any;
    if (!result.success) {
      throw new Error(`repo.search failed: ${result.error}`);
    }
    expect(result.output).toContain("line two");
  });

  test("searches within a subdirectory", async () => {
    const cmd = getCommand(CMD_SEARCH);
    const result = (await cmd.execute({ pattern: "nested", path: "subdir" }, {} as any)) as any;
    expect(result.success).toBe(true);
    expect(result.output).toContain("nested content");
  });

  test("returns empty for no matches", async () => {
    const cmd = getCommand(CMD_SEARCH);
    const result = (await cmd.execute(
      { pattern: "zzz_nonexistent_pattern_zzz" },
      {} as any
    )) as any;
    expect(result.success).toBe(true);
    expect(result.output).toBe("");
  });
});

describe("repo.list_directory", () => {
  test("lists root directory", async () => {
    const cmd = getCommand(CMD_LIST_DIR);
    const result = (await cmd.execute({ path: "." }, {} as any)) as any;
    expect(result.success).toBe(true);
    const names = result.entries.map((e: any) => e.name);
    expect(names).toContain("test-file.txt");
    expect(names).toContain("subdir");
  });

  test("lists subdirectory", async () => {
    const cmd = getCommand(CMD_LIST_DIR);
    const result = (await cmd.execute({ path: "subdir" }, {} as any)) as any;
    expect(result.success).toBe(true);
    expect(result.entries).toEqual([{ name: "nested.txt", type: "file" }]);
  });

  test("includes type indicators", async () => {
    const cmd = getCommand(CMD_LIST_DIR);
    const result = (await cmd.execute({ path: "." }, {} as any)) as any;
    const subdirEntry = result.entries.find((e: any) => e.name === "subdir");
    expect(subdirEntry?.type).toBe("directory");
    const fileEntry = result.entries.find((e: any) => e.name === "test-file.txt");
    expect(fileEntry?.type).toBe("file");
  });

  test("returns error for nonexistent directory", async () => {
    const cmd = getCommand(CMD_LIST_DIR);
    const result = (await cmd.execute({ path: "nonexistent" }, {} as any)) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
