/**
 * Test utilities for GitService testing
 * @module test-git-service
 */
import { GitService } from "../../domain/git";

/**
 * A test version of GitService that uses mock execAsync implementation
 * This allows us to test GitService methods without making real git commands
 */
export class TestGitService extends GitService {
  private mockResponses: Map<string, { stdout: string; stderr: string }> = new Map();

  /**
   * Register mock responses for git commands
   * @param commandPattern - String to match in the command
   * @param response - Mock response to return
   */
  registerMockResponse(commandPattern: string, response: { stdout: string; stderr: string }): void {
    this.mockResponses.set(commandPattern, response);
  }

  /**
   * Reset all mock responses
   */
  resetMockResponses(): void {
    this.mockResponses.clear();
  }

  /**
   * Mock implementation of execAsync that returns registered responses
   * @param command - Command string
   * @returns Mock response
   */
  async execAsync(command: string): Promise<{ stdout: string; stderr: string }> {
    // Check if we have a registered mock response for this command
    for (const [pattern, response] of this.mockResponses.entries()) {
      if (command.includes(pattern)) {
        return response;
      }
    }

    // Default empty response
    return { stdout: "", stderr: "" };
  }

  /**
   * Override execInRepository to use our mock execAsync
   */
  async execInRepository(workdir: string, command: string): Promise<string> {
    const result = await this.execAsync(`git -C ${workdir} ${command}`);
    return result.stdout.trim();
  }
}
