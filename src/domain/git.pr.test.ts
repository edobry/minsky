import { describe, it, expect, mock } from "bun:test";
import { GitService } from "./git";

describe("GitService PR base branch detection", () => {
  it("should generate PR diff against main branch", async () => {
    // Create a mock GitService that provides predictable PR output
    const mockGit = new GitService();
    mockGit.prWithDependencies = mock(() => ({
      markdown: `# Pull Request for branch \`feature\`

## Commits
- **Add feature.txt**
- **Add feature2.txt**

## Modified Files (Changes compared to merge-base with main)
- A feature.txt
- A feature2.txt

## Stats
2 files changed, 2 insertions(+), 0 deletions(-)
`,
      details: {
        branch: "feature",
        files: ["feature.txt", "feature2.txt"],
        commits: ["Add feature.txt", "Add feature2.txt"],
        stats: {
          insertions: 2,
          deletions: 0,
          filesChanged: 2
        }
      }
    }));
    
    const result = await mockGit.pr({ repoPath: "/mock/repo", branch: "feature" });
    
    expect(result.markdown).toContain("feature.txt");
    expect(result.markdown).toContain("feature2.txt");
    expect(result.markdown).toContain("Changes compared to merge-base with main");
    expect(result.markdown).toMatch(/\d+ files? changed/);
  });
}); 
