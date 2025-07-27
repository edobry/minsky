import {
  ConflictDetectionService,
  ConflictType,
  ConflictSeverity,
} from "./src/domain/git/conflict-detection";

// Test the improved error message format
const service = new ConflictDetectionService();

// Create a mock conflict file
const mockConflictFiles = [
  {
    path: "process/tasks.md",
    status: "modified_both" as any,
    conflictRegions: [
      {
        startLine: 420,
        endLine: 422,
        type: "content" as const,
        description: "Task status conflict",
      },
    ],
  },
];

// Test the improved user guidance
const guidance = (service as any).generateUserGuidance(
  ConflictType.CONTENT_CONFLICT,
  ConflictSeverity.MANUAL_SIMPLE,
  mockConflictFiles
);

console.log("🧪 Testing improved error message format:");
console.log("=".repeat(50));
console.log(guidance);
console.log("=".repeat(50));

// Verify it contains our improvements
const hasStepByStep = guidance.includes("📋 Next Steps:");
const hasGitStatus = guidance.includes("git status");
const hasGitAdd = guidance.includes("git add");
const hasGitCommit = guidance.includes("git commit");
const hasRetryCommand = guidance.includes("minsky session pr");

console.log("\n✅ Verification Results:");
console.log(`- Contains step-by-step guidance: ${hasStepByStep}`);
console.log(`- Contains git status command: ${hasGitStatus}`);
console.log(`- Contains git add command: ${hasGitAdd}`);
console.log(`- Contains git commit command: ${hasGitCommit}`);
console.log(`- Contains retry command: ${hasRetryCommand}`);

if (hasStepByStep && hasGitStatus && hasGitAdd && hasGitCommit && hasRetryCommand) {
  console.log("\n🎉 All improvements are working correctly!");
} else {
  console.log("\n❌ Some improvements are missing.");
}
