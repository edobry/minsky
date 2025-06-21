/**
 * Tests for session file operations MCP adapter
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { z } from "zod";
import { registerSessionFileTools } from "../session-files";

describe("Session File Tools", () => {
  let mockCommandMapper: any;

  beforeEach(() => {
    mockCommandMapper = {
      addSessionCommand: mock(() => {}),
    } as any;
  });

  test("registerSessionFileTools registers expected commands", () => {
    registerSessionFileTools(mockCommandMapper);
    expect(mockCommandMapper.addSessionCommand).toHaveBeenCalledTimes(4);
  });
});
